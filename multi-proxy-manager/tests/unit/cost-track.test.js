'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const CT = require('../../lib/cost-track.js');

// ⚠️ 账本落盘测试必须用 tmp 目录：ledgerFile() 每次读 PROXY_COST_LEDGER，
// 不重定向的话测试会把假账写进 ~/.multi-proxy-manager/cost-ledger.jsonl（实测踩过：
// 一次 jest 往真账本塞了 24 行假数据）。
const LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cost-ledger-'));
const LEDGER = path.join(LEDGER_DIR, 'cost-ledger.jsonl');

// 🔴 必须在 beforeEach 里设，不能模块级设 —— jest.setup-afterenv.js 每个用例跑完会把
// process.env 恢复成 worker 加载时的快照，删掉当时还不存在的新 key。模块级设的 env
// 活不过第一个用例：ledgerFile() 在调用时读 env，读到 undefined 就静默回落到
// ~/.multi-proxy-manager/cost-ledger.jsonl，假账直接写进真账本。
beforeEach(() => { process.env.PROXY_COST_LEDGER = LEDGER; });

// L2 P2 A路·token×单价埋点内核（热路径内存累计，门控 PROXY_COST_TRACK 默认关）
describe('cost-track (P2 A路·token×单价埋点 · 门控非侵入)', () => {
  beforeEach(() => { CT.reset(); delete process.env.PROXY_COST_TRACK; });
  afterEach(() => { CT.reset(); delete process.env.PROXY_COST_TRACK; });

  // ---- 门控：默认关 ----
  test('门控默认关：enabled()=false，热路径零行为', () => {
    expect(CT.enabled()).toBe(false);
    CT.setPricing('openai', { input: 10, output: 20 });
    CT.accumulate('openai', { prompt_tokens: 1000, completion_tokens: 500 });
    // 门控关时 accumulate 不提取、不累计。
    // ⚠️ 逐字段显式校验，不用整对象 toEqual —— getCost() 后加字段（如 latencyP50）不该炸掉这条测试。
    const c0 = CT.getCost('openai');
    expect(c0.promptTokens).toBe(0);
    expect(c0.completionTokens).toBe(0);
    expect(c0.totalTokens).toBe(0);
    expect(c0.cost).toBe(0);
    expect(c0.requestCount).toBe(0);
    expect(c0.latencyP50).toBeNull(); // 无样本 ⇒ null，绝不 0
   });

  test('门控开（=1/true/on）：enabled()=true', () => {
    process.env.PROXY_COST_TRACK = '1';
    expect(CT.enabled()).toBe(true);
    process.env.PROXY_COST_TRACK = 'true';
    expect(CT.enabled()).toBe(true);
    process.env.PROXY_COST_TRACK = 'on';
    expect(CT.enabled()).toBe(true);
   });

  test('门控 off 的其它写法：=0/false/no/空 均不启用', () => {
    for (const v of ['0', 'false', 'no', '', undefined]) {
      process.env.PROXY_COST_TRACK = v;
      expect(CT.enabled()).toBe(false);
     }
   });

  // ---- 门控开：提取 + 累计 ----
  test('门控开 + pricing：prompt×input/1M + completion×output/1M 累计 cost', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('openai', { input: 10, output: 20 });
    CT.accumulate('openai', { prompt_tokens: 1000000, completion_tokens: 1000000 });
    const c = CT.getCost('openai');
    // 1M tokens × 10 + 1M tokens × 20 = 30
    expect(c.promptTokens).toBe(1000000);
    expect(c.completionTokens).toBe(1000000);
    expect(c.totalTokens).toBe(2000000);
    expect(c.requestCount).toBe(1);
    expect(c.cost).toBe(30);
   });

  test('多次 accumulate 累加（同 proxy 多次请求）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('deepseek', { input: 0.5, output: 1.0 });
    CT.accumulate('deepseek', { prompt_tokens: 500000, completion_tokens: 500000 });
    CT.accumulate('deepseek', { prompt_tokens: 500000, completion_tokens: 500000 });
    const c = CT.getCost('deepseek');
    expect(c.requestCount).toBe(2);
    expect(c.promptTokens).toBe(1000000);
    expect(c.completionTokens).toBe(1000000);
    // 1M×0.5 + 1M×1.0 = 1.5
    expect(c.cost).toBe(1.5);
   });

  test('cacheHit 折扣：cache_read_input_tokens 走 cacheHit 单价（Anthropic 语义）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('anthropic', { input: 25, output: 125, cacheHit: 3 });
     // 1M input of which 400k is cache hit
    CT.accumulate('anthropic', { prompt_tokens: 1000000, completion_tokens: 100000, cache_read_input_tokens: 400000 });
    const c = CT.getCost('anthropic');
     // (1M-0.4M)×25/1M + 0.1M×125/1M + 0.4M×3/1M = 0.6×25 + 0.1×125 + 0.4×3 = 15+12.5+1.2 = 28.7
    expect(c.cost).toBeCloseTo(28.7, 5);
   });

  test('Anthropic 字段名兼容（input_tokens/output_tokens）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('anthropic', { input: 25, output: 125 });
    CT.accumulate('anthropic', { input_tokens: 1000000, output_tokens: 1000000 });
    const c = CT.getCost('anthropic');
    expect(c.promptTokens).toBe(1000000);
    expect(c.completionTokens).toBe(1000000);
    // 1M×25 + 1M×125 = 150
    expect(c.cost).toBe(150);
   });

  test('未设 pricing 的 proxy：token 仍累计但 cost=0（不崩、不静默吞）', () => {
    process.env.PROXY_COST_TRACK = '1';
    // 不设 pricing 直接 accumulate
    CT.accumulate('local-model', { prompt_tokens: 100, completion_tokens: 50 });
    const c = CT.getCost('local-model');
    expect(c.promptTokens).toBe(100);
    expect(c.completionTokens).toBe(50);
    expect(c.cost).toBe(0);
   });

  test('pricing 全 0（本地模型 type=local）：token 累计但 cost=0', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('local-model', { input: 0, output: 0 });
    CT.accumulate('local-model', { prompt_tokens: 100, completion_tokens: 50 });
    expect(CT.getCost('local-model').cost).toBe(0);
   });

  test('usage 缺失/部分：无 completion_tokens 时只累计 prompt', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('openai', { input: 10 });
    CT.accumulate('openai', { prompt_tokens: 500000 });
    const c = CT.getCost('openai');
    expect(c.promptTokens).toBe(500000);
    expect(c.completionTokens).toBe(0);
    expect(c.totalTokens).toBe(500000);
   });

  test('getAll 返回所有 proxy 累计；未访问的 proxy 不出现', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('openai', { input: 10, output: 20 });
    CT.setPricing('deepseek', { input: 1, output: 1 });
    CT.accumulate('openai', { prompt_tokens: 1000000, completion_tokens: 0 });
    const all = CT.getAll();
    expect(Object.keys(all)).toEqual(expect.arrayContaining(['openai']));
    expect(all.openai.cost).toBe(10);
   });

  test('cost 四舍五入到 6 位（与 alert.js cost signal 一致）', () => {
    process.env.PROXY_COST_TRACK = '1';
    // 1 token × 10 / 1M = 0.000010 → round to 6 = 0.00001
    CT.setPricing('p', { input: 10, output: 0 });
    CT.accumulate('p', { prompt_tokens: 1 });
    expect(CT.getCost('p').cost).toBe(0.00001);
   });

  // ---- 非侵入验证 ----
  // （原这条只断言了 requestCount，从没真的校验「不写盘」——名不副实。
  //   账本落盘后它的语义改为「门控带来的额外开销仍然只有一次 env 读 + 一次 append」。）
  test('非侵入：门控开时热路径只多一次 append，不改写响应', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 10 });
    fs.writeFileSync(LEDGER, '');        // 本 describe 前面的用例也落过账，先清空再数
    for (let i = 0; i < 10; i++) CT.accumulate('p', { prompt_tokens: 100, completion_tokens: 100 });
    expect(CT.getCost('p').requestCount).toBe(10);
    // 落盘 ≠ 改写：账本行数 = 落账次数，不多不少
    const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
    expect(rows).toHaveLength(10);
   });

  test('门控关时 accumulate 不创建 state（零副作用，不污染全局 _state）', () => {
    // 门控 default off
    expect(CT.getAll()).toEqual({});
    CT.accumulate('openai', { prompt_tokens: 100, completion_tokens: 50 });
     // 门控关 → 没创建 _state['openai']
    expect(CT.getAll()).toEqual({});
    const cz = CT.getCost('openai');
    expect(cz.promptTokens).toBe(0);
    expect(cz.completionTokens).toBe(0);
    expect(cz.totalTokens).toBe(0);
    expect(cz.cost).toBe(0);
    expect(cz.requestCount).toBe(0);
    expect(cz.latencyP50).toBeNull();
   });

  test('reset 全清（测试隔离 + 重启语义）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('openai', { input: 10, output: 20 });
    CT.accumulate('openai', { prompt_tokens: 1000000, completion_tokens: 1000000 });
    expect(CT.getCost('openai').cost).toBe(30);
    CT.reset();
    expect(CT.getAll()).toEqual({});
    const cz = CT.getCost('openai');
    expect(cz.promptTokens).toBe(0);
    expect(cz.completionTokens).toBe(0);
    expect(cz.totalTokens).toBe(0);
    expect(cz.cost).toBe(0);
    expect(cz.requestCount).toBe(0);
    expect(cz.latencyP50).toBeNull();
   });

  // ---- latencyP50（floor view 要读它；lib/cost-track.js 新增字段，此前零覆盖）----
  // 只补测试、不动实现：在途改动还没入库，这里先钉住它的可观测契约，
  // 免得实现侧改坏（比如把 null 写成 0）没人发现。
  test('latencyP50：无样本返 null，绝不 0（0 会被 floor view 读成「零延迟」假数据）', () => {
    CT.recordLatency('openai', 100);           // 门控默认关 ⇒ 直接返回，不进样本
    expect(CT.latencyP50('openai')).toBeNull();
    process.env.PROXY_COST_TRACK = '1';
    CT.reset();
    expect(CT.latencyP50('openai')).toBeNull();
   });

  test('latencyP50：门控开取中位数 + 环形窗口裁剪 + 非法输入不污染 + reset 清空', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.reset();
    for (const ms of [10, 20, 30, 40, 50]) CT.recordLatency('p', ms);
    expect(CT.latencyP50('p')).toBe(30);       // 中位数

    for (let i = 0; i < 60; i++) CT.recordLatency('p', 7);  // 灌爆窗口
    CT.recordLatency('p', 999);                             // 触发 splice，只留最近 50 条
    expect(CT.latencyP50('p')).toBe(7);

    for (const bad of [-1, NaN, Infinity, 'abc', undefined]) CT.recordLatency('p', bad);
    CT.recordLatency('p');                     // 缺 ms 参数
    expect(CT.latencyP50('p')).toBe(7);        // 非法值一律不进样本

    CT.reset();
    expect(CT.latencyP50('p')).toBeNull();
   });

  // ---- thinking_tokens（纯可观测：单独计数，绝不重复计费）----
  test('Anthropic 线：thinking_tokens 单列 + 不重复计费 + 不进 totalTokens', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('anthropic', { input: 25, output: 125 });
    // Kimi 真上游形态（64 号 §七坑 6）：output 27 里 23 是思考
    CT.accumulate('anthropic', { input_tokens: 20, output_tokens: 27, output_tokens_details: { thinking_tokens: 23 } });
    const c = CT.getCost('anthropic');
    expect(c.thinkingTokens).toBe(23);
    expect(c.completionTokens).toBe(27);              // 上游已含，不额外累加
    expect(c.totalTokens).toBe(47);                   // = input 20 + output 27，thinking 不另计
    expect(c.cost).toBe(20 / 1e6 * 25 + 27 / 1e6 * 125); // 按 output 27 算一遍，不加第二遍
   });

  test('thinking_tokens 扁平形态（裸 usage.thinking_tokens）与缺失兜底', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.reset();
    CT.accumulate('p', { prompt_tokens: 10, completion_tokens: 5, thinking_tokens: 3 });
    expect(CT.getCost('p').thinkingTokens).toBe(3);
    CT.accumulate('p', { prompt_tokens: 10, completion_tokens: 5 });   // OpenAI 线无该字段
    const c = CT.getCost('p');
    expect(c.thinkingTokens).toBe(3);                 // 缺字段 = 0 增量，不崩
    expect(c.requestCount).toBe(2);
   });
});

// ===== 持久账本 + 三模型字段（2026-10-03 补；抄 CC Switch proxy_request_logs 的记账三件套）=====
describe('cost-track 持久账本 + 三模型字段', () => {
  // LEDGER / readRows / clearLedger 见文件顶部（模块级，beforeEach 里重设 env）
  const readRows = () => fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // 截断而不是删文件：文件恒存在，readRows 才不会 ENOENT，toHaveLength 断言才有意义
  const clearLedger = () => fs.writeFileSync(LEDGER, '');

  beforeEach(() => {
    CT.reset();
    delete process.env.PROXY_COST_TRACK;
    clearLedger();
  });
  afterEach(() => {
    CT.reset();
    delete process.env.PROXY_COST_TRACK;
    clearLedger();
  });

  test('落账往账本追加一行（append-only，不重写整文件）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('codex-proxy', { input: 10, output: 20 });
    CT.accumulate('codex-proxy', { prompt_tokens: 1000, completion_tokens: 500 });
    CT.accumulate('codex-proxy', { prompt_tokens: 100, completion_tokens: 100 });
    expect(readRows()).toHaveLength(2);
    expect(readRows()[0].prompt).toBe(1000);          // 先写的那行还在 ⇒ 是 append 不是 rewrite
    expect(readRows()[1].prompt).toBe(100);
   });

  test('账本路径默认在 ~/.multi-proxy-manager/，PROXY_COST_LEDGER 可覆盖', () => {
    expect(CT.ledgerFile()).toBe(LEDGER);
    delete process.env.PROXY_COST_LEDGER;              // 文件级 beforeEach 下个用例会重新设回来
    expect(CT.ledgerFile()).toBe(path.join(os.homedir(), '.multi-proxy-manager', 'cost-ledger.jsonl'));
   });

  test('loadLedger 读回合并进内存态，返回行数', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 10 });
    CT.accumulate('p', { prompt_tokens: 1000, completion_tokens: 500 });   // cost = 1000/1e6*10 + 500/1e6*10 = 0.015
    expect(CT.getCost('p').cost).toBe(0.015);

    // 模拟重启：只清内存（门控仍开 —— loadLedger 内部走 applyTokens，门控一关就全不记，
    // 真实 server.js 也是 loadPricingFromEnv + 门控开的状态下调它）
    CT.reset();
    const n = CT.loadLedger();
    expect(n).toBe(1);
    expect(CT.getCost('p').cost).toBe(0.015);         // 历史账原样回来
    expect(CT.getCost('p').promptTokens).toBe(1000);
    expect(CT.getCost('p').requestCount).toBe(1);
   });

  test('🔴 读回期间不回写：loadLedger 不会把历史账再追加一遍', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 10 });
    CT.accumulate('p', { prompt_tokens: 1000, completion_tokens: 500 });
    const before = readRows().length;                   // = 1

    CT.reset();
    CT.loadLedger();
    expect(readRows()).toHaveLength(before);           // 还是 1；不加倍（回归守卫：_loading）
    CT.reset();
    CT.loadLedger();
    expect(readRows()).toHaveLength(before);           // 读两次也不涨
   });

  test('🔴 读回用行内冻结的 cost，不按现价重算（价表变了历史账单不漂）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 10 });
    // 第一次记账按 input=10：1000000/1e6 × 10 = **10**（不是 0.01，别少看三个数量级）
    CT.accumulate('p', { prompt_tokens: 1000000, completion_tokens: 0 });
    CT.reset();

    // 价表翻倍到 20/20 后重启
    CT.setPricing('p', { input: 20, output: 20 });
    CT.loadLedger();
    expect(CT.getCost('p').cost).toBe(10);             // 仍是旧价算的 10，不是按新价 20
   });

  test('无账本 / 空行 / 半行损坏都不算错（跳过损坏行，不炸）', () => {
    fs.writeFileSync(LEDGER, '{"proxy":"p","prompt":10}\n\n{"proxy":"p","prompt":20\nnot-json\n');
    process.env.PROXY_COST_TRACK = '1';
    expect(CT.loadLedger()).toBe(1);                   // 只有中间那行是完整 JSON
    expect(CT.getCost('p').promptTokens).toBe(10);
   });

  test('reset 只清内存，不删账本（账本是持久资产）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 10 });
    CT.accumulate('p', { prompt_tokens: 10, completion_tokens: 10 });
    CT.reset();
    expect(fs.existsSync(LEDGER)).toBe(true);          // 文件还在
    expect(CT.loadLedger()).toBe(1);                   // 还能读回来
   });

  // ---- 三模型字段 ----
  test('三模型字段入账：model=实际计费模型，requestModel=请求侧模型', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('codex-proxy', { input: 10, output: 10 });
    CT.accumulate('codex-proxy', { prompt_tokens: 1000, completion_tokens: 0 }, {
      model: 'agnes-3.0-flash', requestModel: 'claude-haiku-4-5',
    });

    const row = readRows()[0];
    expect(row.model).toBe('agnes-3.0-flash');         // 账记在实际计费模型上
    expect(row.requestModel).toBe('claude-haiku-4-5');

    const c = CT.getCost('codex-proxy');
    expect(Object.keys(c.models)).toEqual(['agnes-3.0-flash']);
    expect(c.models['agnes-3.0-flash'].promptTokens).toBe(1000);
    // 请求侧那个模型挂在下面，才答得出「那批 haiku 烧了多少」
    expect(Object.keys(c.models['agnes-3.0-flash'].requestModels)).toEqual(['claude-haiku-4-5']);
   });

  test('route-engine 重写场景：多请求归到同一 model，各自的 requestModel 分开记', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 0 });
    CT.accumulate('p', { prompt_tokens: 1000 }, { model: 'agnes-3.0-flash', requestModel: 'claude-haiku-4-5' });
    CT.accumulate('p', { prompt_tokens: 2000 }, { model: 'agnes-3.0-flash', requestModel: 'gpt-4o' });
    CT.accumulate('p', { prompt_tokens: 500 },  { model: 'deepseek-v3',     requestModel: 'claude-haiku-4-5' });

    const c = CT.getCost('p');
    expect(c.models['agnes-3.0-flash'].promptTokens).toBe(3000);   // 两个 haiku + gpt 都落在这
    expect(Object.keys(c.models['agnes-3.0-flash'].requestModels).sort()).toEqual(['claude-haiku-4-5', 'gpt-4o']);
    expect(c.models['agnes-3.0-flash'].requestModels['claude-haiku-4-5'].promptTokens).toBe(1000);
    expect(c.models['deepseek-v3'].promptTokens).toBe(500);
   });

  test('🔴 模型缺失落 <unknown>，绝不猜模型名（猜错就是假数据）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 0 });
    CT.accumulate('p', { prompt_tokens: 100 });        // 没给 model
    expect(readRows()[0].model).toBe('<unknown>');
    expect(Object.keys(CT.getCost('p').models)).toEqual(['<unknown>']);
   });

  test('pricingModel 可显式指定（价表切换留痕）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 0 });
    CT.accumulate('p', { prompt_tokens: 100 }, { model: 'new-model', pricingModel: 'legacy-price' });
    expect(readRows()[0].model).toBe('legacy-price');   // 按哪套价记的账
   });

  test('models 无数据时返回 null，不返回空字典（与 latencyP50 同口径）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 0 });
    const c = CT.getCost('p');
    expect(c.models).toBeNull();
    expect(c.requestModels).toBeNull();
   });

  test('🔴 reqId 幂等：同一次响应重报只记一笔（tee 双触发实测 252=126×2）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 0 });
    CT.applyTokens('p', { prompt: 100, completion: 0, cacheHit: 0, thinking: 0 }, 10, { reqId: 'r-1' });
    CT.applyTokens('p', { prompt: 100, completion: 0, cacheHit: 0, thinking: 0 }, 10, { reqId: 'r-1' });
    expect(CT.getCost('p').requestCount).toBe(1);
    expect(readRows()).toHaveLength(1);
   });

  test('没有 reqId 就不去重（照记，不猜、不静默丢账）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 0 });
    CT.applyTokens('p', { prompt: 100, completion: 0, cacheHit: 0, thinking: 0 }, 10, {});
    CT.applyTokens('p', { prompt: 100, completion: 0, cacheHit: 0, thinking: 0 }, 10, {});
    expect(CT.getCost('p').requestCount).toBe(2);
   });

  test('跨进程上报透传三模型字段 + reqId', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('codex-proxy', { input: 10, output: 10 });
    CT.reportUsage({
      agent: 'codex-proxy', latencyMs: 10, reqId: 'r-9',
      model: 'agnes-3.0-flash', requestModel: 'claude-haiku-4-5',
      raw: { prompt_tokens: 1000, completion_tokens: 500 },
    });
    const row = readRows()[0];
    expect(row.model).toBe('agnes-3.0-flash');
    expect(row.requestModel).toBe('claude-haiku-4-5');
    expect(row.reqId).toBe('r-9');
   });

  test('门控关时一切不落盘（含账本）', () => {
    expect(CT.enabled()).toBe(false);
    CT.setPricing('p', { input: 10, output: 10 });
    CT.accumulate('p', { prompt_tokens: 100, completion_tokens: 100 });
    expect(readRows()).toHaveLength(0);                 // 账本是空的（= 一行都没追加）
    expect(CT.getCost('p').requestCount).toBe(0);
   });
});
