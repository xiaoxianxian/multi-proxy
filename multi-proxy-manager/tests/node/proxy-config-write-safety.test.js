'use strict';

// proxy-config 写操作安全测试（2026-10-16 面板走查新增）
//
// 背景：这一页的问题比 dashboard / logs 严重一个量级。它不只「读失败被伪装
// 成正常」，还有一整类**写操作假成功**：
//
//   病根：fetchAdminApi() 过去 catch 后 `return null`，把 HTTP 错误、网络错误、
//   JSON 解析错误全吞成同一个值。调用方因此无法区分「成功返回 null」和「失败」。
//
//   于是 addProvider / updateProvider / deleteProviderById 的 catch 分支把变更
//   写进本地数组——**提交失败却显示成功**：
//     · addProvider  失败 → 列表里出现一个后端根本不存在的 provider，
//                       用户刷新页面后它消失，而期间配的模型会一直失败；
//     · updateProvider 失败 → 用户以为新 API key 生效了，实际后端还是旧值，
//                       于是花几小时排查为什么链路不通；
//     · deleteProviderById 失败 → 用户以为敏感的 API key 删掉了，实际后端还存着。
//
//   changeRoutingMode 更隐蔽：失败时也弹「路由模式已切换为 xxx」，只是把 success
//   降成 info——连错误字样都没有。
//
//   loadProviders 读失败则兜底成 MOCK_PROVIDERS：4 个假 provider 带
//   sk-test-key-xxxxx 假 key。
//
// 另外：本页 `<script>` 块曾有一行 `'</span>');</div>'` 语法错误，导致**整块 JS
// 从未执行过**（详见 tests/node/panel-syntax-guard.test.js）。
//
// 本测试的结构说明：proxy-config 的函数在 script **顶层作用域**（不是 IIFE），
// 所以直接 append 导出即可；但顶层有一次 init() 调用，必须禁掉——stub DOM 跑不起
// 真实初始化。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

// ── 最小 DOM stub ────────────────────────────────────────────────────────
// textContent 必须反射进 innerHTML：面板 esc() 就是
// `document.createElement('div'); d.textContent = str; return d.innerHTML`。
// 第一版 stub 的 innerHTML 恒为 ''，导致 esc() 返回空、所有文案整段消失。
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeEl(id) {
  const el = {
    id, _html: '', _text: '', value: '', disabled: false,
    style: {}, dataset: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    children: [],
    appendChild(c) { this.children.push(c); },
    remove() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; }, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; },
    set scrollTop(v) { this._st = v; }, get scrollTop() { return this._st || 0; },
    set scrollHeight(v) { this._sh = v; }, get scrollHeight() { return this._sh || 0; }
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v); el._html = escapeHtml(el._text); }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); }
  });
  return el;
}

function makeEnv(fetchStub) {
  const registry = new Map();
  const getEl = id => { if (!registry.has(id)) registry.set(id, makeEl(id)); return registry.get(id); };
  const sandbox = {
    document: {
      getElementById: getEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeEl(''),
      addEventListener() {},
      documentElement: makeEl('html'),
      body: makeEl('body')
    },
    console,
    CustomEvent: function () { return { type: 'x' }; },
    localStorage: { _d: new Map(), getItem(k) { return this._d.has(k) ? this._d.get(k) : null; }, setItem(k, v) { this._d.set(k, String(v)); }, removeItem(k) { this._d.delete(k); } },
    sessionStorage: { _d: new Map(), getItem(k) { return this._d.has(k) ? this._d.get(k) : null; }, setItem(k, v) { this._d.set(k, String(v)); }, removeItem(k) { this._d.delete(k); } },
    navigator: { userAgent: 'node-test' },
    fetch: fetchStub,
    confirm: () => true,
    alert: () => {},
    setTimeout: (f) => { try { f(); } catch (e) {} return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    URLSearchParams: URLSearchParams
  };
  sandbox.window = sandbox;
  sandbox.location = { href: '', search: '' };
  vm.createContext(sandbox);
  return { sandbox, getEl };
}

// showToast 是页面内部函数，外部替换不了；它 `createElement('div')` 后
// `t.textContent = msg` 再 appendChild 到 toastContainer。所以从 DOM 读。
function readToasts(getEl) {
  const c = getEl('toastContainer');
  return (c.children || []).map(t => ({
    msg: t.textContent || '',
    type: String(t.className || '').replace(/^toast\s*/, '')
  }));
}

function runProxyConfig(fetchStub) {
  const html = fs.readFileSync(path.join(PUBLIC, 'proxy-config.html'), 'utf8');
  const code = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)[1];
  const EXPORTS = [
    'fetchAdminApi', 'loadProviders', 'addProvider', 'updateProvider',
    'deleteProviderById', 'toggleProviderEnabledApi', 'changeRoutingMode',
    'clearHistory', 'showReadError', 'showToast', 'renderProviders'
  ].join(', ');
  // 禁掉顶层 init()：stub DOM 跑不起真实初始化（会碰一堆不存在的元素）。
  // 只删这一次调用，函数定义保留。
  const patched = code.replace(/\n    init\(\);\n/, '\n    /* init() 由测试基座禁用 */\n');
  if (patched === code) throw new Error('没能禁掉 init()——基座与页面结构脱节了，请更新');
  const { sandbox, getEl, toasts } = makeEnv(fetchStub);
  vm.runInContext(patched + '\n;window.__panel = {' + EXPORTS + '};', sandbox, { filename: 'proxy-config.html' });
  return { api: sandbox.__panel, getEl };
}

async function settle() {
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0));
}

function jsonRes(ok, status, body) {
  return { ok, status, json: async () => body };
}

// ════════════════════════════════════════════════════════════════════════

test('fetchAdminApi：HTTP 失败必须抛错，不再 return null', async () => {
  const fetchStub = () => Promise.resolve(jsonRes(false, 500, { error: '后端炸了', hint: '看一眼 logs 页' }));
  const { api } = runProxyConfig(fetchStub);
  let threw = null;
  try { await api.fetchAdminApi('/providers'); } catch (e) { threw = e; }
  if (!threw) throw new Error('fetchAdminApi 仍然吞错返回 null——写操作假成功的病根还在');
  if (threw.message.indexOf('后端炸了') === -1) throw new Error('错误信息应带后端 error，实际: ' + threw.message);
  if (threw.hint !== '看一眼 logs 页') throw new Error('应透传后端 hint，实际: ' + threw.hint);
});

test('fetchAdminApi：网络断开时抛带 networkError 标记的错', async () => {
  const fetchStub = () => Promise.reject(new Error('ECONNREFUSED'));
  const { api } = runProxyConfig(fetchStub);
  let threw = null;
  try { await api.fetchAdminApi('/providers'); } catch (e) { threw = e; }
  if (!threw) throw new Error('网络错误也被吞了');
  if (!threw.networkError) throw new Error('网络错应带 networkError 标记');
});

test('addProvider：提交失败不许把 provider 塞进本地状态', async () => {
  const fetchStub = () => Promise.resolve(jsonRes(false, 400, { error: 'api_key 无效' }));
  const { api, getEl } = runProxyConfig(fetchStub);
  await api.addProvider('MyProv', 'openai', 'https://x/v1', 'sk-bad', true);
  await settle();
  const errs = readToasts(getEl).filter(t => t.type === 'error');
  if (errs.length === 0) throw new Error('添加失败却没有错误提示');
  if (errs[0].msg.indexOf('api_key 无效') === -1) throw new Error('提示应带后端原因，实际: ' + errs[0].msg);
  // 关键：不能出现「列表里有一个后端不存在的 provider」这种假成功。
  // addProvider 的 catch 若还在往 providers 里 push，紧接着的 loadProviders()
  // 又会失败（同一个 stub），最终走 loadProviders 的读失败分支——
  // 所以这里断言 providersBody 显示的是「读取失败」而不是 MyProv。
  const html = getEl('providersBody').innerHTML;
  if (html.indexOf('MyProv') !== -1) throw new Error('提交失败的 provider 被渲染出来了（假成功）');
});

test('updateProvider：保存失败不许在本地改掉 provider', async () => {
  const fetchStub = () => Promise.resolve(jsonRes(false, 500, { error: '写盘失败' }));
  const { api, getEl } = runProxyConfig(fetchStub);
  await api.updateProvider('prov_1', '新名字', 'https://new/v1', 'sk-new', true);
  await settle();
  const errs = readToasts(getEl).filter(t => t.type === 'error');
  if (errs.length === 0) throw new Error('保存失败却没有错误提示');
  if (errs[0].msg.indexOf('写盘失败') === -1) throw new Error('提示应带后端原因，实际: ' + errs[0].msg);
});

test('deleteProviderById：删除失败不许在本地摘掉 provider', async () => {
  const fetchStub = () => Promise.resolve(jsonRes(false, 500, { error: '删不掉' }));
  const { api, getEl } = runProxyConfig(fetchStub);
  await api.deleteProviderById('prov_1');
  await settle();
  const errs = readToasts(getEl).filter(t => t.type === 'error');
  if (errs.length === 0) throw new Error('删除失败却没有错误提示');
  if (errs[0].msg.indexOf('删不掉') === -1) throw new Error('提示应带后端原因，实际: ' + errs[0].msg);
});

test('changeRoutingMode：切换失败不许再说「已切换」', async () => {
  const fetchStub = () => Promise.resolve(jsonRes(false, 500, { error: '配置写不进去' }));
  const { api, getEl } = runProxyConfig(fetchStub);
  await api.changeRoutingMode('cheap');
  await settle();
  const bad = readToasts(getEl).find(t => t.msg.indexOf('已切换') !== -1);
  if (bad) throw new Error('失败时仍提示「已切换为 cheap」——用户会以为路由改了，实际没改');
  const errs = readToasts(getEl).filter(t => t.type === 'error');
  if (errs.length === 0) throw new Error('失败却没有 error 提示');
});

test('loadProviders：读失败显示「读取失败」，不是 4 个假 provider', async () => {
  const fetchStub = () => Promise.resolve(jsonRes(false, 500, { error: 'manager 不可达' }));
  const { api, getEl } = runProxyConfig(fetchStub);
  await api.loadProviders();
  await settle();
  const html = getEl('providersBody').innerHTML;
  if (html.indexOf('读取失败') === -1) throw new Error('应显示读取失败，实际: ' + html.slice(0, 200));
  if (html.indexOf('sk-test-key-xxxxx') !== -1) throw new Error('假 provider（sk-test-key-xxxxx）又出来了');
  if (html.indexOf('Azure OpenAI') !== -1) throw new Error('假 provider 名单又出来了');
});

test('loadProviders：读成功时不出现读取失败字样', async () => {
  const fetchStub = (url) => {
    const u = String(url);
    if (u.indexOf('/providers') !== -1) {
      return Promise.resolve(jsonRes(true, 200, { providers: [{ id: 'prov_real', name: '真Provider', provider_id: 'openai', base_url: 'https://real/v1', api_key: '****', enabled: true }] }));
    }
    return Promise.resolve(jsonRes(true, 200, {}));
  };
  const { api, getEl } = runProxyConfig(fetchStub);
  await api.loadProviders();
  // loadProviders 的成功路径本身不渲染（渲染由调用方 refreshPage / init 负责，
  // 这是原有设计）。读失败路径里我加的 renderProviders() 是必要的——
  // 调用方在 Promise.all 整体 catch 后不会渲染，错误态必须自己画出来。
  api.renderProviders();
  await settle();
  const html = getEl('providersBody').innerHTML;
  if (html.indexOf('读取失败') !== -1) throw new Error('读成功却显示读取失败（误报）');
  if (html.indexOf('真Provider') === -1) throw new Error('真实 provider 没渲染出来: ' + html.slice(0, 200));
  if (html.indexOf('sk-test-key-xxxxx') !== -1) throw new Error('混进了假 provider');
});
