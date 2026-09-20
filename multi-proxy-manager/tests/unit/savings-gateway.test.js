'use strict';
const G = require('../../../l2/savings-gateway/gateway.js');
const S = require('../../../l2/savings-gateway/server.js');
const A = require('../../../l2/alert.js');

// 省钱网关内核（task1 一期 · shadow 模拟 delta + 难度路由 + 喂 alert.js cost 信号）
// 五决策：形态B / 18795 / dummy key gw_ / shadow 模拟 delta 接 alert.js / 按难度档位
describe('savings-gateway kernel (l2/savings-gateway/gateway.js)', () => {
  const USAGE = { prompt_tokens: 1000, completion_tokens: 500 };
  const KEY = G.DUMMY_KEY_PREFIX + 'default-large';

  let gw;
  beforeEach(() => { gw = G.createSavingsGateway(); });

  test('鉴权：非 dummy key → 401 invalid_api_key', () => {
    let e = null;
    try { gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage: USAGE }, { key: 'sk-real' }); } catch (err) { e = err; }
    expect(e).not.toBeNull();
    expect(e.httpStatus).toBe(401);
    expect(e.message).toBe('invalid_api_key');
  });

  test('鉴权：前缀对但未签发 → 401 unknown_api_key', () => {
    let e = null;
    try { gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }] }, { key: G.DUMMY_KEY_PREFIX + 'ghost' }); } catch (err) { e = err; }
    expect(e.httpStatus).toBe(401);
    expect(e.message).toBe('unknown_api_key');
  });

  test('难度路由：low→small(agnes) / medium→medium(deepseek) / high→large(qwen)', () => {
    const low = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'low', usage: USAGE }, { key: KEY });
    const med = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'medium', usage: USAGE }, { key: KEY });
    const high = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'high', usage: USAGE }, { key: KEY });
    expect(low.model).toBe('agnes');
    expect(med.model).toBe('deepseek');
    expect(high.model).toBe('qwen');
    expect(low.x_savings.actualTier).toBe('small');
    expect(high.x_savings.actualTier).toBe('large');
  });

  test('模拟 delta：planned=large 基线 32/128 CNY per 1M（1000in+500out → 0.096）', () => {
    const low = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'low', usage: USAGE }, { key: KEY });
    expect(low.x_savings.plannedCost).toBe(0.096);
    expect(low.x_savings.actualCost).toBe(0);          // small 免费档
    expect(low.x_savings.saved).toBe(0.096);
    const high = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'high', usage: USAGE }, { key: KEY });
    expect(high.x_savings.saved).toBe(0);               // large 打 large = 无省
    const med = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'medium', usage: USAGE }, { key: KEY });
    expect(med.x_savings.actualCost).toBe(0.003);       // deepseek ¥1/¥4 per 1M
    expect(med.x_savings.saved).toBe(0.093);
  });

  test('无 usage → 启发式估算并诚实标 estimated=true', () => {
    const est = gw.handleChatCompletions({ messages: [{ role: 'user', content: '你好世界' }] }, { key: KEY });
    expect(est.x_savings.estimated).toBe(true);
    expect(est.usage.prompt_tokens).toBeGreaterThanOrEqual(1);
    const real = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }, { key: KEY });
    expect(real.x_savings.estimated).toBe(false);
    expect(real.usage.prompt_tokens).toBe(7);
  });

  test('OpenAI 兼容信封：id/object/model/choices/usage', () => {
    const r = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage: USAGE }, { key: KEY });
    expect(r.object).toBe('chat.completion');
    expect(r.choices[0].message.role).toBe('assistant');
    expect(r.usage.total_tokens).toBe(1500);
  });

  test('省钱报告：分档计数 + 累计 + shadow 标记', () => {
    for (const c of ['low', 'medium', 'high']) gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], complexity: c, usage: USAGE }, { key: KEY });
    const rep = gw.savingsReport();
    expect(rep.requestCount).toBe(3);
    expect(rep.perTier.small.requestCount).toBe(1);
    expect(rep.perTier.medium.requestCount).toBe(1);
    expect(rep.perTier.large.requestCount).toBe(1);
    expect(rep.shadow).toBe(true);
    expect(rep.totalSaved).toBe(0.096 + 0.093);        // small 全省 + medium 省 0.003
  });

  test('窗口裁剪：windowMs 按最近 ts 倒推 cutoff', () => {
    gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage: USAGE }, { key: KEY, now: 1000 });
    gw.handleChatCompletions({ messages: [{ role: 'user', content: 'y' }], usage: USAGE }, { key: KEY, now: 9000 });
    const rep = gw.savingsReport(1000);
    expect(rep.requestCount).toBe(1);                    // cutoff=9000-1000=8000，只有 ts=9000 在窗口内
    // ts=9000 那笔无 complexity → 默认 medium 档（deepseek ¥1/¥4）：0.096 − 0.003 = 0.093
    expect(rep.totalSaved).toBe(0.093);
  });

  test('端到端：cost 信号 → alert.js cost-budget-exceeded（超预算触发/预算内不触发/无预算不告警）', () => {
    gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage: USAGE }, { key: KEY });
    const fired = A.evaluate(gw.produceCostSignal({ budget: 0.000001 }));
    expect(fired).toHaveLength(1);
    expect(fired[0].rule).toBe('cost-budget-exceeded');
    expect(fired[0].severity).toBe('warning');
    expect(A.evaluate(gw.produceCostSignal({ budget: 9999 }))).toHaveLength(0);
    const noBudget = gw.produceCostSignal();
    expect(noBudget.budget).toBeUndefined();
    expect(A.evaluate(noBudget)).toHaveLength(0);
  });

  test('pricing 可注入（large 基线可覆盖）+ PROXY_PRICING_LARGE env', () => {
    const g2 = G.createSavingsGateway({ pricing: { large: { input: 10, output: 20 } } });
    const r = g2.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], complexity: 'high', usage: USAGE }, { key: KEY });
    expect(r.x_savings.plannedCost).toBe(10 / 1e6 * 1000 + 20 / 1e6 * 500); // 0.02
  });

  test('custom dummyKeys 注入（gateway 可签发任意多把 key，映射档位意图）', () => {
    const g3 = G.createSavingsGateway({ dummyKeys: { [G.DUMMY_KEY_PREFIX + 'a-low']: 'low' } });
    expect(g3.getDummyKeys()).toHaveProperty(G.DUMMY_KEY_PREFIX + 'a-low');
    expect(g3.getDummyKeys()).not.toHaveProperty(KEY); // 未传默认 key 时不自带
  });

  test('非侵入：shadow 默认开 / 门控默认关 / 不往 process.env 注入网关键', () => {
    expect(gw.isShadow()).toBe(true);
    expect(G.gateOpen()).toBe(false);
    expect(process.env.SAVE_GATEWAY).toBeUndefined();
    expect(process.env.SAVE_GATEWAY_PORT).toBeUndefined();
  });

  test('shadow off + 无 executor = 不触真实上游（二期缝）', () => {
    gw.setShadowMode(false);
    const r = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage: USAGE }, { key: KEY });
    expect(r.x_savings.shadow).toBe(false);
    expect(r.choices[0].message.role).toBe('assistant');
  });

  test('实例隔离：两个 gateway 账目互不影响', () => {
    const b = G.createSavingsGateway();
    gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage: USAGE }, { key: KEY });
    expect(gw.savingsReport().requestCount).toBe(1);
    expect(b.savingsReport().requestCount).toBe(0);
  });
});

describe('savings-gateway server (l2/savings-gateway/server.js · thin HTTP, 端口 18795)', () => {
  let server;
  let base;
  const KEY = G.DUMMY_KEY_PREFIX + 'default-large';
  const USAGE = { prompt_tokens: 1000, completion_tokens: 500 };

  beforeAll(async () => {
    server = S.createServer();
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  test('门控关（默认）→ POST /v1/chat/completions 403 gate-closed；/health 放行', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe('savings-gateway gate closed');
    const h = await fetch(`${base}/health`);
    expect(h.status).toBe(200);
    expect((await h.json()).gateOpen).toBe(false);
  });

  test('门控开 → 200 难度路由 + x_savings delta；401 鉴权；400 缺 messages', async () => {
    process.env[G.GATE_ENV] = '1';
    try {
      const ok = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], complexity: 'low', usage: USAGE }),
      });
      expect(ok.status).toBe(200);
      const b = await ok.json();
      expect(b.model).toBe('agnes');
      expect(b.x_savings.saved).toBe(0.096);
      expect(b.x_savings.shadow).toBe(true);

      // high 档走 HTTP 路由（large=qwen，¥32/¥128 → actualCost 0.096，saved 0）——为信号测试提供 cost>0
      const high = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], complexity: 'high', usage: USAGE }),
      });
      expect(high.status).toBe(200);
      const hb = await high.json();
      expect(hb.model).toBe('qwen');
      expect(hb.x_savings.saved).toBe(0);

      const badKey = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-nope' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      });
      expect(badKey.status).toBe(401);

      const noMsg = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({}),
      });
      expect(noMsg.status).toBe(400);
    } finally { delete process.env[G.GATE_ENV]; }
  });

  test('GET /savings/report + /savings/signal（看板只读，门控关也放行）', async () => {
    const rep = await fetch(`${base}/savings/report`);
    expect(rep.status).toBe(200);
    const rb = await rep.json();
    expect(rb.requestCount).toBeGreaterThanOrEqual(1);
    expect(rb.gate).toBe('closed(observe)');

    const sig = await fetch(`${base}/savings/signal?budget=0.000001`);
    expect(sig.status).toBe(200);
    const sb = await sig.json();
    expect(sb.source).toBe('cost');
    expect(sb.providerId).toBe('savings-gateway');
    expect(sb.budget).toBe(0.000001);
    const fired = A.evaluate(sb);
    expect(fired[0].rule).toBe('cost-budget-exceeded');
  });

  test('404 未知路由', async () => {
    const r = await fetch(`${base}/v1/models`);
    expect(r.status).toBe(404);
  });
});
