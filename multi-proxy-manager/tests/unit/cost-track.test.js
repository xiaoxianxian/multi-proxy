'use strict';
const CT = require('../../lib/cost-track.js');

// L2 P2 A路·token×单价埋点内核（热路径内存累计，门控 PROXY_COST_TRACK 默认关）
describe('cost-track (P2 A路·token×单价埋点 · 门控非侵入)', () => {
  beforeEach(() => { CT.reset(); delete process.env.PROXY_COST_TRACK; });
  afterEach(() => { CT.reset(); delete process.env.PROXY_COST_TRACK; });

  // ---- 门控：默认关 ----
  test('门控默认关：enabled()=false，热路径零行为', () => {
    expect(CT.enabled()).toBe(false);
    CT.setPricing('openai', { input: 10, output: 20 });
    CT.accumulate('openai', { prompt_tokens: 1000, completion_tokens: 500 });
    // 门控关时 accumulate 不提取、不累计
    expect(CT.getCost('openai')).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, requestCount: 0 });
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
  test('非侵入：模块不写盘（无 fs 操作，纯内存）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('p', { input: 10, output: 10 });
    for (let i = 0; i < 10; i++) CT.accumulate('p', { prompt_tokens: 100, completion_tokens: 100 });
    // 不写盘——cost-track 是纯内存累计器，持久化由 alert.js/persist 负责
    expect(CT.getCost('p').requestCount).toBe(10);
   });

  test('门控关时 accumulate 不创建 state（零副作用，不污染全局 _state）', () => {
    // 门控 default off
    expect(CT.getAll()).toEqual({});
    CT.accumulate('openai', { prompt_tokens: 100, completion_tokens: 50 });
     // 门控关 → 没创建 _state['openai']
    expect(CT.getAll()).toEqual({});
    expect(CT.getCost('openai')).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, requestCount: 0 });
   });

  test('reset 全清（测试隔离 + 重启语义）', () => {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing('openai', { input: 10, output: 20 });
    CT.accumulate('openai', { prompt_tokens: 1000000, completion_tokens: 1000000 });
    expect(CT.getCost('openai').cost).toBe(30);
    CT.reset();
    expect(CT.getAll()).toEqual({});
    expect(CT.getCost('openai')).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, requestCount: 0 });
   });
});
