#!/usr/bin/env node
'use strict';
// token-policy-bridge · 把 apply() 接进真实转发链路的旁挂桥
//
// 目的：让 5 个 hook 跑在真实流量上。此前 apply() 全仓只有 demo 与单测调用，
//       「省了多少」永远是 policy 执行层估计，称不到真流量。
// 形态：独立进程 + 独立端口，agent 的 base_url 指到本端口，本进程转发给 UPSTREAM。
//       codex-proxy/proxy.js 保持 0 diff——热路径铁律不受影响，回滚 = base_url 指回上游。
//
// 为什么独立文件而不是改 token-baseline-sidecar：
//   那份探针的文件头契约是「只度量、不改包」，它产出的 jsonl 是基线数据。
//   给它加改写会让基线数据失去可信度（「这份数是被策略改过的吗」），必须分开。
//
// 用法：
//   node tools/token-policy-bridge.js                      # observe（默认，原样转发）
//   BRIDGE_MODE=rewrite node tools/token-policy-bridge.js  # 改写后转发
//   PORT=18794 UPSTREAM=http://127.0.0.1:18790 node tools/token-policy-bridge.js
//   BRIDGE_STUB=1 node tools/token-policy-bridge.js        # 桩响应，不消耗 token
//   BRIDGE_LOG_BODY=1 node tools/token-policy-bridge.js    # 额外把请求正文落成语料
//
// 隐私：默认不落请求正文，只落类别分布 / delta / policy 名与净增量。
//   需要语料时显式开 BRIDGE_LOG_BODY=1 —— 正文写入**独立**的 bridge-corpus-*.jsonl，
//   不混进主日志（主日志是运营/度量数据，混进正文会让「这份数是被策略改过的吗」
//   重新变成问句，也会让日志失去可公开性）。语料供 tools/bridge-dryrun.js 消费。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const KE = require('./cache-k-estimator.js'); // k 自测器：白拿 usage 估「退回段是否按未命中价计」

const PORT = Number(process.env.PORT || 18794);
const BINDING = process.env.BINDING || '127.0.0.1';
const UPSTREAM = (process.env.UPSTREAM || 'http://127.0.0.1:18790').replace(/\/$/, '');
const DEFAULT_MODE = 'observe'; // observe | rewrite；运行时读 env，便于同一进程内切换做对照
const STUB = process.env.BRIDGE_STUB === '1';
const CAPTURE_BODY = process.env.BRIDGE_LOG_BODY === '1';
const AGENT_TYPE = process.env.BRIDGE_AGENT_TYPE || 'coding';
// 只有这几个字段允许写回请求体。handler 返回别的字段一律忽略并计数——
// 未知字段写进上游请求等于赌 provider 会容忍，赢了没收益、输了直接 400。
const MERGE_FIELDS = ['messages', 'systemPrompt', 'history', 'tools'];
// curator pack 是否真正启用（BRIDGE_CURATOR=1 才打开）。
// pack 自身默认关是非侵入铁律④，这里不替 pack 破例：注册始终发生，
// 但只有显式开关才 enabled=true，apply() 才会跑到它。
const CURATOR_ENABLED = process.env.BRIDGE_CURATOR === '1';
// 工具类型归一化（BRIDGE_NORMALIZE_TOOLS=1 才生效）。
// 落在 L1 转发路径上、会改真实发出去的工具 schema，默认关——需要显式开。
// 见 normalizeTools() 上的成因说明，别关掉就当它是死开关。
const NORMALIZE_TOOLS = process.env.BRIDGE_NORMALIZE_TOOLS === '1';
// 请求侧要跑的 hook。🔴 不能只跑 onRequestAssemble——历史压缩挂在 onHistory，
// 它是最大的那一档杠杆（实测 41 轮会话折叠 tool 输出省 53.7%），
// 只跑一个 hook 等于把最值钱的策略晾在真实链路之外。
const REQUEST_HOOKS = ['onHistory', 'onToolOutput', 'onRequestAssemble'];
const LOG_DIR = process.env.BRIDGE_LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_PATH = path.join(LOG_DIR, `token-policy-bridge-${new Date().toISOString().slice(0, 10)}.jsonl`);
const CORPUS_PATH = path.join(LOG_DIR, `bridge-corpus-${new Date().toISOString().slice(0, 10)}.jsonl`);

const TP = require('../l2/token-policy.js');
const CF = require('../l2/context-fold.js');

// curator pack 注册。packs/curator 目前没有 loader 入口（没有 pack.js / index.js），
// 所以之前日志里 policies=[] 既不是「没 handler」也不是白名单问题——是压根没人注册过它。
// 这里按 manifest 直接注册（applyPack 会把名字加 [curator] 前缀）。
// 注意：apply() 给 handler 传的 io.budget 是它自己构造的 {remaining,max}，
// 我们传不进去，所以 tools-lazyload 的阈值只认它自己的 env（CURATOR_MAX_HIDE_RATIO），别在这套 budget。
if (CURATOR_ENABLED) {
  try {
    const LAZY = require('../packs/curator/policies/tools-lazyload.js');
    const reg = TP.applyPack({
      name: 'curator',
      appliesTo: ['coding'],
      enabled: true, // 仅此处受 BRIDGE_CURATOR 开关控制；pack 文件本身不动，默认关的约定未被破坏
      priority: 10,
      hooks: { [LAZY.hook]: [{ name: LAZY.name, handler: LAZY.handler }] },
    });
    console.log('[bridge] curator pack 已注册 ×' + reg.length + ':', LAZY.hook + '/' + LAZY.name);
  } catch (e) {
    console.error('[bridge] curator pack 注册失败:', e && e.message);
  }
  // 58 号方案 P3（工具摘要降级）。默认 off：handler 直接返回 null，不产出 tools 字段，
  // 桥的 MERGE_FIELDS 写不进东西 ⇒ 请求体一个字节都不动。
  // 开法：CURATOR_SUMMARY_MODE=light|aggressive（与 tools-lazyload 互斥，见 policy 头注释）。
  try {
    const SD = require('../packs/curator/policies/tools-summary-downgrade.js');
    const reg2 = TP.applyPack({
      name: 'curator-summary',
      appliesTo: ['coding'],
      enabled: true,
      priority: 11, // 略高于 lazyload(10)：同为 onRequestAssemble，让 P3 后写、覆盖掉 lazyload
      hooks: { [SD.hook]: [{ name: SD.name, handler: SD.handler }] },
    });
    console.log('[bridge] curator-summary 已注册 ×' + reg2.length + ':', SD.hook + '/' + SD.name,
      '(CURATOR_SUMMARY_MODE=' + (process.env.CURATOR_SUMMARY_MODE || 'off') + ')');
  } catch (e) {
    console.error('[bridge] curator-summary 注册失败:', e && e.message);
  }
}
// onToolOutput：工具输出**只保留头尾**（与 onHistory 的 foldToolOutput「整条替身」分工，
// 见该 policy 头注释——两者打的其实是同一批条目，同时开会重复记账，所以各自默认关）。
// 接它的理由是补位不是重复：responses 协议的工具输出 { type:'function_call_output' }
// 没有 role，早期 fold 的入口 `m.role==='tool'` 够不到它，只能靠 onToolOutput 这条路径。
if (CURATOR_ENABLED && process.env.CURATOR_TOOL_GUARD === '1') {
  try {
    const TG = require('../packs/curator/policies/tool-output-guard.js');
    const reg3 = TP.applyPack({
      name: 'curator-tool-guard',
      appliesTo: ['coding'],
      enabled: true,
      priority: 5, // 排在 onHistory(默认)/onRequestAssemble 之间：历史先压完，本 handler 再决定留头还是留尾
      hooks: { [TG.hook]: [{ name: TG.name, handler: TG.handler }] },
    });
    console.log('[bridge] curator-tool-guard 已注册 ×' + reg3.length + ':', TG.hook + '/' + TG.name,
      '(CURATOR_TOOL_GUARD=1)');
  } catch (e) {
    console.error('[bridge] curator-tool-guard 注册失败:', e && e.message);
  }
}
// onResponse：只**记账**不改字节（见 response-insight.js 头注释的流式红线）。
// 它的价值是把「各 policy 自报省了多少」跟上游真实 usage 对拍 —— 这是代理层唯一能白拿
// 真实 usage 的位置，也是 est 高估（实测同请求 est≈12860 vs actual≈11610）唯一能校准的口子。
const RESPONSE_OBSERVE = process.env.CURATOR_RESPONSE_INSIGHT === '1';
if (RESPONSE_OBSERVE) {
  try {
    const RI = require('../packs/curator/policies/response-insight.js');
    const reg4 = TP.applyPack({
      name: 'curator-response-insight',
      appliesTo: ['coding'],
      enabled: true,
      priority: 1,
      hooks: { [RI.hook]: [{ name: RI.name, handler: RI.handler }] },
    });
    console.log('[bridge] curator-response-insight 已注册 ×' + reg4.length + ':', RI.hook + '/' + RI.name);
  } catch (e) {
    console.error('[bridge] curator-response-insight 注册失败:', e && e.message);
  }
}

// ---------- 纯函数：协议归一（可独立测） ----------

/**
 * 从 OpenAI 请求体构造 token-policy 的 ctx。
 * 两种协议归一成同一形状：chat/completions 的 messages、responses 的 input/instructions。
 * @returns {{agentType:string, model:string, api:string, messages:Array, systemPrompt:string, history:Array, tools:Array}}
 */
/**
 * 工具类型归一化：把上游不认的 codex 工具 type 转成它认的那种。
 *
 * 成因（2026-10-01 用 ~/.codex/config.toml 真 key 直连 agnes 二分探针实测）：
 * codex 0.159.3 走 responses 协议会发 `type:'namespace'`（multi_agent_v1 子代理容器）
 * 与 `type:'web_search'` 两种工具，而 agnes 只认 function / web_search_preview /
 * code_interpreter / mcp 四种 → 整包 400 `unknown variant namespace, expected one of ...`。
 * 无工具的请求全 200，所以症状是「一装子代理就挂」，不是桥坏了。
 *
 * 两条规则，只动 type 不做能力阉割：
 *   namespace → 把它的 function 子工具抬到顶层（摊平，能力不丢）；
 *               没有子工具时退化成无参 function 壳，至少整包不发 400。
 *   web_search → 改写成 web_search_preview，其余字段原样保留。
 *
 * @returns {{body:object, changed:boolean, from:string[]}} from = 命中改写的原始 type
 */
// 上游 /v1/responses 认的工具类型（agnes 实测报的四个变体）。
// 白名单之外的一律剔除，这样 codex 以后再冒出第五种类型也不会整包 400——
// 退化成「少几个工具」比「整个请求死掉」好。
const UPSTREAM_TOOL_TYPES = new Set(['function', 'web_search_preview', 'code_interpreter', 'mcp']);

function normalizeTools(body) {
  const list = body && Array.isArray(body.tools) ? body.tools : null;
  if (!list) return { body, changed: false, from: [] };
  const from = [];
  const flat = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') { flat.push(t); continue; }

    if (t.type === 'namespace') {
      from.push('namespace');
      const inner = Array.isArray(t.tools) ? t.tools.filter((x) => x && typeof x === 'object' && x.type === 'function') : [];
      if (inner.length) { flat.push(...inner); continue; }
      // 无子工具：宁可给个空壳也别让整包 400——功能会退化，但请求还能打出去
      flat.push({
        type: 'function',
        name: typeof t.name === 'string' && t.name ? t.name : 'subagent',
        description: typeof t.description === 'string' ? t.description : '',
        strict: false,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      });
      continue;
    }
    if (t.type === 'web_search') {
      from.push('web_search');
      const { type, ...rest } = t; // eslint-disable-line no-unused-vars
      flat.push({ type: 'web_search_preview', ...rest });
      continue;
    }
    // 走到这里的都是上游不认、且映射不过去的（实测：codex 0.159.3 的 custom =
    // apply_patch，freeform 编辑工具；tool_search，客户端执行的工具发现器）。
    // 为什么是**剔除**而不是压成无参 function 壳——壳是「给上游一个假工具」，
    // 而这两类本来就是 codex 客户端执行的能力，上游不需要知道；与其让上游拿个
    // 没参数定义的 function 去猜，不如不给（能力退化，但整包不死）。
    // 只有 namespace 这种「装着 function 子工具的容器」才摊平/退壳。
    if (!UPSTREAM_TOOL_TYPES.has(t.type)) {
      from.push(t.type);
      continue;
    }
    flat.push(t);
  }
  let changed = false;
  try { changed = JSON.stringify(flat) !== JSON.stringify(list); } catch { changed = false; }
  return { body: changed ? { ...body, tools: flat } : body, changed, from };
}

function ctxFromRequest(body, api) {
  const b = body || {};
  let messages = [];
  let systemPrompt = '';
  if (api === 'responses') {
    // responses 的 input 可能是字符串（单轮）或数组（多轮）
    if (typeof b.input === 'string') { messages = [{ role: 'user', content: b.input }]; }
    else if (Array.isArray(b.input)) { messages = b.input; }
    systemPrompt = typeof b.instructions === 'string' ? b.instructions
      : (Array.isArray(b.instructions) ? b.instructions.join('\n') : '');
  } else {
    messages = Array.isArray(b.messages) ? b.messages : [];
    systemPrompt = messages
      .filter((m) => m && m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
  }
  const nonSystem = messages.filter((m) => m && m.role !== 'system');
  return {
    agentType: AGENT_TYPE,
    model: b.model || '',
    api,
    messages: nonSystem,
    systemPrompt,
    // history = 除最后一条外的部分。历史裁剪类 policy 需要它，缺了就静默不生效
    // （token-policy 在 ctx 缺 agentType 时是静默跳过，这里必须显式给全）。
    history: nonSystem.slice(0, -1),
    tools: Array.isArray(b.tools) ? b.tools : [],
  };
}

/**
 * 把 handler 的输出合并回原请求体（仅白名单字段）。
 * @returns {{body:object, applied:string[], ignored:string[], changed:boolean}}
 */
function mergeOutToRequest(body, out, api, originBody) {
  const applied = [];
  const ignored = [];
  if (!out || typeof out !== 'object') return { body, applied, ignored, changed: false };
  const origin = originBody || body; // 「原始请求体」参照：多次合并时必须传最原始那个
  for (const k of Object.keys(out)) {
    if (k === 'netTokenDelta' || k === 'ok') continue;
    if (!MERGE_FIELDS.includes(k)) { ignored.push(k); continue; }
  }
  let next = body;
  const put = (field, value) => { next = { ...next, [field]: value }; applied.push(field); };

  // 🔴 handler 原样返回 messages 时**不写回**。
  //    这不是洁癖：passthrough 型 policy（如 curator 的 prompt-assemble）会把
  //    ctx.messages 原样吐回来，一旦写回就把前一个 hook（onHistory 历史压缩）
  //    刚改好的内容整个盖掉——压缩完全失效，且日志上看不出异常。
  //    「没改的东西就不写」才是正确语义。
  //
  //    比的对象必须是**原始请求体**，不是中间态：handler 拿到的 ctx 来自原始包，
  //    拿中间态比会因为「前一个 hook 已改动」而误判成有变化，覆盖照旧发生。
  const originalMsgs = api === 'responses' ? (origin.input || []) : (origin.messages || []);
  const unchangedMessages = (candidate) => {
    if (!Array.isArray(originalMsgs) || originalMsgs.length !== candidate.length) return false;
    try { return JSON.stringify(originalMsgs) === JSON.stringify(candidate); } catch { return false; }
  };

  if (Array.isArray(out.messages) && out.messages.length && !unchangedMessages(out.messages)) {
    put(api === 'responses' ? 'input' : 'messages', api === 'responses'
      ? out.messages
      : (body.systemPrompt != null || systemCount(body) ? withSystem(body, out.messages) : out.messages));
  } else if (Array.isArray(out.history)) {
    // history 是「除最后一条外」，写回时要拼回最后一条，否则会吞掉当前这轮输入
    const last = (api === 'responses' ? (Array.isArray(body.input) ? body.input.slice(-1) : [])
      : (Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role !== 'system').slice(-1) : []));
    const merged = out.history.concat(last);
    put(api === 'responses' ? 'input' : 'messages', api === 'responses'
      ? merged
      : withSystem(body, merged));
  }
  // tools 写回（chat=completions 与 responses 都是顶层 tools 字段）。
  // 语义同 messages：内容没变就不写——懒加载在首轮（无调用证据）必须原样全发，
  // 写回等于把「没改的东西」标成已改写，日志会骗人。
  if (Array.isArray(out.tools) && JSON.stringify(out.tools) !== JSON.stringify(Array.isArray(body.tools) ? body.tools : null)) {
    put('tools', out.tools);
  }
  if (typeof out.systemPrompt === 'string') {
    if (api === 'responses') { put('instructions', out.systemPrompt); }
    else { next = { ...next, messages: replaceSystem(next.messages || [], out.systemPrompt) }; if (!applied.includes('messages')) applied.push('messages'); }
  }
  return { body: next, applied, ignored, changed: applied.length > 0 };
}

/**
 * 依次应用多个 hook 的输出。每个 hook 单独走一次白名单合并，不叠加。
 * 为什么要支持多个：历史压缩（onHistory）与请求组装（onRequestAssemble）改的是
 * 请求体的不同部分，只应用后者会让前者白算。
 */
function mergeMany(body, outs, api) {
  const origin = body; // 后面每次合并都以它为「原始」参照，不能用中间态
  let cur = body;
  const applied = [];
  const ignored = [];
  for (const out of outs || []) {
    if (!out || typeof out !== 'object') continue;
    const m = mergeOutToRequest(cur, out, api, origin);
    cur = m.body;
    if (m.applied && m.applied.length) applied.push(...m.applied);
    if (m.ignored && m.ignored.length) ignored.push(...m.ignored);
  }
  return { body: cur, applied, ignored, changed: applied.length > 0 };
}

function systemCount(body) {
  return Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role === 'system').length : 0;
}
function withSystem(body, msgs) {
  const sys = (body.messages || []).filter((m) => m && m.role === 'system');
  return sys.concat(msgs);
}
function replaceSystem(messages, text) {
  const rest = (messages || []).filter((m) => m && m.role !== 'system');
  return text ? [{ role: 'system', content: text }].concat(rest) : rest;
}

// ---------- 转发 ----------

// hop-by-hop 头不能透传（连接级语义，换一跳就失效；content-length 会因改写后的
// body 长度对不上而挂死；content-encoding 也不能留——fetch 已解压，再透传会让
// 客户端二次解压报错）
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding']);

/**
 * 挑选要透传给上游的请求头。只放行鉴权、OpenAI 系与自定义 x- 头，
 * 其余一律不带——带未知头等于赌上游容忍度，赢了没收益，输了直接 400。
 */
function pickRequestHeaders(src) {
  const out = { 'Content-Type': 'application/json' };
  for (const k of Object.keys(src || {})) {
    const lk = String(k).toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'authorization' || lk === 'api-key' || lk.startsWith('openai-') || lk.startsWith('x-')) {
      out[k] = src[k];
    }
  }
  return out;
}

function pickResponseHeaders(headers) {
  const out = {};
  try {
    headers.forEach((v, k) => {
      const lk = String(k).toLowerCase();
      if (HOP_BY_HOP.has(lk)) return;
      out[k] = v;
    });
  } catch { /* 极端情况下 headers 不可迭代，回退到只有 content-type */ }
  if (!out['Content-Type'] && !out['content-type']) out['Content-Type'] = 'application/json';
  return out;
}

/**
 * 拼接上游 URL。
 * 🔴 这里必须处理版本前缀重复：base_url 常带 /v1（如 https://x.cn/v1），客户端
 *    请求路径也常带 /v1（/v1/responses），直接拼会得到 /v1/v1/responses → 上游 404。
 *    实测踩过：桥起起来一切正常，只有真实请求全 404。
 */
function joinUrl(upstream, urlPath) {
  const base = String(upstream || '').replace(/\/+$/, '');
  const p = String(urlPath || '/');
  const m = base.match(/\/v\d+$/);
  if (m && p.startsWith(m[0] + '/')) return base + p.slice(m[0].length);
  if (m && p === m[0]) return base;
  return base + p;
}

/**
 * 从 SSE 文本里抽 usage。流式下 provider 不给 JSON 响应体，usage 只在最后一个
 * 事件里——拿不到它，实测轨（actualPromptTokens）在流式场景就全废了。
 * 两种协议都认：responses 的 response.usage.input_tokens、chat 的 usage.prompt_tokens。
 * 抽不到返回 null（绝不填 0，延续 C3 纪律）。
 */
function extractUsageFromSSE(text) {
  if (typeof text !== 'string' || !text) return null;
  let last = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj = null;
    try { obj = JSON.parse(payload); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const u = (obj.response && obj.response.usage) || obj.usage || null;
    if (u && (Number.isFinite(u.input_tokens) || Number.isFinite(u.prompt_tokens))) last = u;
  }
  if (!last) return null;
  const pick = (...vs) => { for (const v of vs) if (Number.isFinite(v)) return v; return null; };
  const details = last.prompt_tokens_details || last.input_tokens_details || {};
  return {
    prompt_tokens: pick(last.input_tokens, last.prompt_tokens),
    completion_tokens: pick(last.output_tokens, last.completion_tokens),
    // 🔴 必须连 hit/miss 一起抽：否则流式下 actualCacheMiss 恒 null → observeSample
    //    直接 return，k 在 codex 主路径（全流式）永远测不到（55 号遗留下来的缺口）。
    //    抽不到就是 null，绝不填 0。
    // ⚠️ 口径照抄上游字段（miss = prompt_cache_miss_tokens）：该字段语义 ≠「未命中的
    //    输入 token」——53 号实测裁工具后 miss 反而变少。只搬运，不做换算。
    hit: pick(last.prompt_cache_hit_tokens, details.cached_tokens, details.cache_read),
    miss: pick(last.prompt_cache_miss_tokens, details.cache_creation),
  };
}

async function forward(req, bodyStr) {
  const started = Date.now();
  try {
    const res = await fetch(joinUrl(UPSTREAM, req.url), {
      method: req.method,
      headers: pickRequestHeaders(req.headers),
      body: req.method === 'GET' ? undefined : bodyStr,
      signal: AbortSignal.timeout(120000),
    });
    const headers = pickResponseHeaders(res.headers);
    const ctype = res.headers.get('content-type') || '';
    // 🔴 流式必须 pipe，不能 await 全部读完：codex 走 SSE，攒成整块再返回会把
    //    首字节延迟顶到超时上限，表现为「codex 卡住不动」
    if (/text\/event-stream/i.test(ctype) && res.body) {
      return { status: res.status, headers, stream: res.body, ms: Date.now() - started };
    }
    return { status: res.status, headers, body: await res.text(), ms: Date.now() - started };
  } catch (e) {
    return {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: `bridge upstream unreachable: ${e.message}` }),
      ms: Date.now() - started,
    };
  }
}

function logRecord(rec) {
  try {
    if (!loggedBoot) { fs.mkdirSync(LOG_DIR, { recursive: true }); loggedBoot = true; }
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n');
  } catch (e) { console.error('[bridge] write fail:', e.message); }
}
let loggedBoot = false;

/**
 * 落请求正文语料（仅在 BRIDGE_LOG_BODY=1 时调用）。
 * 落的是**转发前的原始包**，不是改写后的——dry-run 要的就是「原始输入」，
 * 改写结果是它自己算出来的，存进去反而会让语料污染。
 */
function captureCorpus(urlPath, api, body, model) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(CORPUS_PATH, JSON.stringify({
      ts: new Date().toISOString(), path: urlPath, api, model: model || null,
      agentType: AGENT_TYPE, body,
    }) + '\n');
  } catch (e) { console.error('[bridge] corpus write fail:', e.message); }
}

const server = http.createServer(async (req, res) => {
  const tReq = Date.now();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mode: process.env.BRIDGE_MODE || DEFAULT_MODE, upstream: UPSTREAM, agentType: AGENT_TYPE, normalizeTools: NORMALIZE_TOOLS, log: LOG_PATH }));
  }

  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* 非 JSON 原样转发 */ }

  const isResponses = req.url.startsWith('/v1/responses');
  const isChat = req.url.startsWith('/v1/chat/completions') || isResponses;
  const api = isResponses ? 'responses' : 'chat-completions';

  const MODE = process.env.BRIDGE_MODE || DEFAULT_MODE;
  let outBody = raw;
  const rec = { ts: new Date().toISOString(), path: req.url, mode: MODE, api, model: body.model || null, agentType: AGENT_TYPE };

  // 🔴 ctx 必须在 if 外层：finishRecord（响应侧）要拿它构造 onResponse 的 rctx。
  //    原先写成块内的 `const ctx`，响应侧引用直接 ReferenceError「ctx is not defined」
  //    ——被 catch 吞成 rec.onResponseError，日志上看像「onResponse 没跑」而不是「它崩了」。
  // （非 chat 路径恒为 null：ctxFromRequest 只在 chat 侧构造。）
  let ctx = null;
  if (isChat) {
    if (CAPTURE_BODY) captureCorpus(req.url, api, body, body.model);
    const t0 = Date.now();
    ctx = ctxFromRequest(body, api);
    // ① 度量：真实请求体的七类组成。
    //    ⚠️ 必须先把 responses 的 input/instructions 归一成 messages 再喂 fold——
    //    fold 只认 messages，直接喂原包会让 responses 请求七类全 0，
    //    而 codex 主力走 responses（config.toml wire_api="responses"），
    //    测不到它就等于这条链路白接。
    try {
      const sys = ctx.systemPrompt ? [{ role: 'system', content: ctx.systemPrompt }] : [];
      const f = CF.fold({ ...body, messages: sys.concat(ctx.messages) });
      rec.byCategory = f.estimate.byCategory;
      rec.estTotal = f.estimate.total;
      rec.toolsBySource = f.estimate.toolsBySource || {};
      if (body.usage) { rec.actualPrompt = body.usage.prompt_tokens ?? null; }
    } catch (e) { rec.foldError = String(e && e.message || e); }

    // ②-a 工具类型归一化（默认关）。必须排在 apply 之前：
    // 否则 rewrite 的 merge 以原始 tools 为基线，归一化改动会被算成
    // 「pack 改的」记进 appliedFields，等于把上游兼容修复记到 token 策略账上。
    let norm = { body, changed: false, from: [] };
    if (NORMALIZE_TOOLS) {
      try {
        norm = normalizeTools(body);
        if (norm.changed) { body = norm.body; rec.normalizedFrom = norm.from; }
      } catch (e) { rec.normError = String(e && e.message || e); }
    }

    // ② 执行：真正跑 apply()。出错不得影响转发——这是桥的底线
    try {
      rec.ctxMsgs = ctx.messages.length;
      rec.ctxHistory = ctx.history.length;
      rec.ctxTools = ctx.tools.length;

      // 🔴 必须链式喂回：把上一个 hook 的输出并进 ctx 再喂给下一个。
      //    否则后一个 hook 拿到的还是原始 ctx，它返回的 messages 会把前一个 hook
      //    刚压缩好的历史整个盖掉——压缩白算，日志上却看不出来。
      const runs = [];
      let chained = ctx;
      for (const hook of REQUEST_HOOKS) {
        const res = TP.apply(hook, chained);
        runs.push({ hook, res });
        const top = (res.results || [])[0];
        if (top && top.out && typeof top.out === 'object') {
          const next = { ...chained };
          if (Array.isArray(top.out.history)) next.history = top.out.history;
          if (Array.isArray(top.out.messages)) next.messages = top.out.messages;
          if (typeof top.out.systemPrompt === 'string') next.systemPrompt = top.out.systemPrompt;
          chained = next;
        }
      }
      // 🔴 reason 必须一起记。policy 各条 fallback 分支（no-usage-evidence /
      // would-over-hide / tail-used-blocked / nothing-to-hide …）在账面上长得一模一样
      // —— 都是 estSaved=0。不记 reason，只看 saved 分不清「跑了但被闸门挡住」和
      // 「压根没算过」，只能靠离线直调 handler 反推（57 号就这么破的案）。
      rec.policies = runs.flatMap((x) => (x.res.results || [])
        .map((r) => ({
          hook: x.hook, p: r.policy, ok: r.ok, d: r.netTokenDelta,
          reason: r.out && r.out.reason, kept: r.out && r.out.kept, hidden: r.out && r.out.hiddenTools,
        })));
      rec.estSaved = runs.reduce((a, x) => (Number.isFinite(x.res.estSaved) ? a + x.res.estSaved : a), 0);
      // estSaved 是各 policy 自报净增量之和；policy 没上报时该项为 null，
      // 累加时会跳过——所以 0 可能是「没人上报」而非「确实没省」，口径要标清
      rec.reported = runs.reduce((a, x) => a
        + (x.res.results || []).filter((r) => Number.isFinite(r.netTokenDelta)).length, 0);

      // 换挡观测要的两个输入：断点落在哪（policy 的 breakpointSchemaTokens）、藏掉了多少（saved）。
      // 取不到就是 null —— k 宁可估不出来，也不许拿 0 当真值去改裁剪模式。
      const lazy = runs.flatMap((x) => x.res.results || []).map((r) => r.out)
        .find((o) => o && Number.isFinite(o.breakpointSchemaTokens));
      if (lazy) {
        rec.breakpointTokens = lazy.breakpointSchemaTokens;
        rec.hiddenTokens = Number.isFinite(lazy.saved) ? lazy.saved : null;
        rec.k = Number.isFinite(lazy.k) ? lazy.k : null;
        rec.kStar = Number.isFinite(lazy.kStar) ? lazy.kStar : null;
        rec.pruneReason = lazy.reason;
      }

      if (MODE === 'rewrite') {
        // 每个 hook 取优先级最高那条（results[0]）主导改写，不叠加同 hook 内的多条
        const outs = runs.map((x) => (x.res.results || [])[0]).filter(Boolean).map((r) => r.out);
        const m = mergeMany(body, outs, api);
        rec.rewrote = m.changed;
        rec.appliedFields = m.applied;
        rec.ignoredFields = m.ignored;
        if (m.changed) {
          const s = JSON.stringify(m.body);
          // 序列化失败就回退原包——宁可不省，也不能把坏请求发给上游
          if (typeof s === 'string') { outBody = s; rec.bytesBefore = raw.length; rec.bytesAfter = s.length; }
          else { rec.rewrote = false; rec.mergeError = 'serialize-failed'; }
        }
      }
    } catch (e) {
      rec.applyError = String(e && e.message || e);
    }
    // ②-b 归一化改过 tools、但 rewrite 没产出新 outBody 时，必须把归一化后的
    //     结果发出去，否则归一化等于白做。没改动就完全不碰 outBody——
    //     宁可少序列化一次，也不能给普通 curl 请求平添字节差。
    if (norm.changed && !rec.rewrote) {
      try {
        const s = JSON.stringify(body);
        if (typeof s === 'string') { outBody = s; rec.bytesBefore = raw.length; rec.bytesAfter = s.length; }
      } catch (e) { rec.normError = 'serialize-failed'; }
    }

    rec.bridgeMs = Date.now() - t0;
  }

  let out;
  if (STUB) {
    out = { status: 200, ms: 0, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'stub', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) };
  } else {
    out = await forward(req, outBody);
  }

  const observeSample = (rec) => {
    if (!Number.isFinite(rec.actualPromptTokens) || !Number.isFinite(rec.actualCacheMiss)) return;
    const prev = kPrevByModel.get(rec.model) || null;
    // round 必须推进：k 估算是「两轮做差」，前几轮是冷态（见 cache-k-estimator 的
    // WARMUP_ROUNDS）——轮次不递增的话，永远停在同一轮重算一遍，冷态样本一个都丢不掉。
    // ⚠️ prev 必须先于 cur 取：早先把它写在 cur 之后，这里撞 TDZ 直接 ReferenceError
    //     把桥打崩（流式是主路径，而这条线没有任何单测走到，只能靠真起桥发现）。
    const cur = {
      prompt: rec.actualPromptTokens, hit: rec.actualCacheHit, miss: rec.actualCacheMiss,
      breakpoint: Number.isFinite(rec.breakpointTokens) ? rec.breakpointTokens : null,
      saved: Number.isFinite(rec.hiddenTokens) ? rec.hiddenTokens : null,
      round: Number.isFinite(rec.round) ? rec.round
        : (prev && Number.isFinite(prev.round) ? prev.round + 1 : 1),
    };
    const est = KE.observe(cur, prev);
    console.log(`[k] r=${cur.round} miss=${cur.miss} bp=${cur.breakpoint} saved=${cur.saved} prevBp=${prev ? prev.breakpoint : '-'} prevSaved=${prev ? prev.saved : '-'} prune=${rec.pruneReason ?? '-'} est=${est ? JSON.stringify({ k: est.k, r: est.residual, why: est.reason }) : '-'}`);
    kPrevByModel.set(rec.model, cur);
    if (!est || est.k === null) return;
    rec.kHat = est.k;
    rec.kSamples = est.samples;
    rec.suggestedPrune = est.mode;
    KE.write(est);
  };

  const finishRecord = (extra) => {
    if (extra) Object.assign(rec, extra);
    if (!isChat) return;
    rec.upstreamStatus = out.status;
    rec.upstreamMs = out.ms;
    // onResponse：在落盘之前跑，让 response-insight 有机会把上游真实 usage 与
    // 各 policy 自报的 estSaved 对拍。🔴 只记账不回写字节 —— 流式是 pipe 出去的，
    // 任何「攒完再发」的改写会把首字节延迟拉到整段生成时间（codex 直接当卡死）。
    if (RESPONSE_OBSERVE) {
      try {
        // 🔴 estTotal 是「改写前」基线（第 ① 步 fold 算的，早于 hook 链），
        //     改写后的估算要另给：estTotal + Σ netTokenDelta（负值=省）。
        //     只给基线会让 response-insight 把「真省了 52.5%」读成「估算高估 52.5%」——
        //     同一个数读反，结论从「改写很值」变成「改写没意义」。
        //     estSaved 为 null（没人上报）时 estAfter 也必须是 null，不许当 0。
        const estAfter = Number.isFinite(rec.estSaved) && Number.isFinite(rec.estTotal)
          ? rec.estTotal + rec.estSaved : null;
        const rctx = {
          ...ctx,
          response: rec.responseText != null ? rec.responseText : (out.body || null),
          estTotal: rec.estTotal != null ? rec.estTotal : null,
          estAfter,
          estSaved: Number.isFinite(rec.estSaved) ? rec.estSaved : null,
          api, model: rec.model,
        };
        const r = TP.apply('onResponse', rctx);
        const o = (r.results || [])[0] && (r.results || [])[0].out;
        if (o) {
          rec.onResponse = {
            note: o.note || null,
            reason: o.reason || null,
            actualPrompt: o.actualPrompt != null ? o.actualPrompt : (rec.actualPromptTokens ?? null),
            actualCompletion: o.actualCompletion != null ? o.actualCompletion : (rec.actualCompletionTokens ?? null),
            hit: o.actualHit != null ? o.actualHit : (rec.actualCacheHit ?? null),
            miss: o.actualMiss != null ? o.actualMiss : (rec.actualCacheMiss ?? null),
            estTotal: o.estTotal != null ? o.estTotal : null,
            estAfter: o.estAfter != null ? o.estAfter : null,
            estSaved: o.estSaved != null ? o.estSaved : null,
            realSaving: o.realSaving != null ? o.realSaving : null,
            estBiasAfter: o.estBiasAfter != null ? o.estBiasAfter : null,
            realSavedTokens: o.realSavedTokens != null ? o.realSavedTokens : null,
            claimSavedTokens: o.claimSavedTokens != null ? o.claimSavedTokens : null,
            overclaimTokens: o.overclaimTokens != null ? o.overclaimTokens : null,
            overclaimRatio: o.overclaimRatio != null ? o.overclaimRatio : null,
            hitRatio: o.hitRatio != null ? o.hitRatio : null,
          };
        }
      } catch (e) { rec.onResponseError = String(e && e.message || e); }
    }
    console.log(`[bridge:${MODE}] ${req.url} model=${rec.model} est=${rec.estTotal ?? '-'} tok | saved=${rec.estSaved ?? '-'} (${rec.reported ?? 0} 条上报) | rewrote=${rec.rewrote ?? false} | reason=${rec.pruneReason ?? '-'} | bridge=${rec.bridgeMs}ms status=${out.status} ${out.ms}ms`);
    logRecord(rec);
    observeSample(rec);
  };

  if (out.stream) {
    // 流式：先把响应头写出去（含上游的 text/event-stream），再 pipe。
    // 同时累积文本只为事后抽 usage——不改变转发内容本身。
    res.writeHead(out.status, out.headers);
    let acc = '';
    const src = Readable.fromWeb(out.stream);
    src.on('data', (c) => { acc += Buffer.isBuffer(c) ? c.toString('utf8') : String(c); });
    src.on('error', () => { try { res.end(); } catch { /* 已断开 */ } });
    src.on('end', () => {
      const u = extractUsageFromSSE(acc);
      finishRecord({
        streamed: true,
        upstreamTotalMs: Date.now() - tReq,
        actualPromptTokens: u ? u.prompt_tokens : null,
        actualCompletionTokens: u ? u.completion_tokens : null,
        actualCacheHit: u ? u.hit : null,
        actualCacheMiss: u ? u.miss : null,
      });
    });
    src.pipe(res);
    return;
  }

  if (isChat) {
    let usage = null;
    try { usage = (JSON.parse(out.body) || {}).usage || null; } catch { /* 非 JSON */ }
    finishRecord({
      actualPromptTokens: usage ? (usage.prompt_tokens ?? usage.input_tokens ?? null) : null,
      actualCompletionTokens: usage ? (usage.completion_tokens ?? usage.output_tokens ?? null) : null,
      // 流式路径的 usage 只抽到 prompt/completion 两个字段（见 extractUsageFromSSE），
      // hit/miss 取不到 → observeSample 会直接 return，不编数。
      actualCacheHit: usage ? (usage.prompt_cache_hit_tokens ?? (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) ?? null) : null,
      actualCacheMiss: usage ? (usage.prompt_cache_miss_tokens ?? null) : null,
    });
  }

  res.writeHead(out.status, out.headers);
  res.end(out.body);
});

if (require.main === module) {
  // ⚠️ 这里只能用 DEFAULT_MODE，不能引用 MODE——MODE 是请求处理函数内的局部变量，
  //    模块级没有它。上一版就是在这里 ReferenceError 崩掉的，而 demo/单测都是
  //    require 本模块（不触发 listen），这个崩溃从没被任何用例覆盖到。
  //    已加「真能启动」的端到端用例（spawn 子进程 + 读 /health）堵住这个盲区。
  server.listen(PORT, BINDING, () => {
    console.log(`[bridge] listening http://${BINDING}:${PORT} → ${STUB ? 'STUB' : UPSTREAM} | mode=${process.env.BRIDGE_MODE || DEFAULT_MODE} agentType=${AGENT_TYPE}`);
    console.log(`[bridge] metrics → ${LOG_PATH}`);
  });
}

// k 观测的跨请求状态，按 model 分桶。
// ⚠️ 必须活在每个请求回调**之外**：早先把它写在 createServer 回调里，每轮请求都重置成 null，
//    换挡样本永远拿不到上一轮，实测现象是观测器一直打 no-sample、配置源文件永远不生成
//    （能跑通但不产数，比报错更难发现）。
const kPrevByModel = new Map();

module.exports = { ctxFromRequest, mergeOutToRequest, mergeMany, normalizeTools, server, MERGE_FIELDS, REQUEST_HOOKS, extractUsageFromSSE, pickRequestHeaders, joinUrl };
