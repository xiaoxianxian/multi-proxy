'use strict';
// 桥在接 onToolOutput / onResponse 时新加的两个 curator policy 的保护网。
// 这两个 handler 在真链路上才第一次被跑到（单测只调纯函数），所以必须自己立规矩：
//   ① tool-output-guard：默认全关 → 零行为变更；开了只砍工具输出的中间段，保留头尾。
//   ② response-insight：三条对拍线不许互相读反（曾经把「真省 52.5%」报成「估算高估 52.5%」）。
const TG = require('../../../packs/curator/policies/tool-output-guard.js');
const RI = require('../../../packs/curator/policies/response-insight.js');

const LONG = 'HEAD-LINE\n' + Array.from({ length: 12 }, (_, i) => `  - item-${i}: 一长串描述文本用来把这条工具输出撑到两百字符以上`).join('\n') + '\nTAIL-LINE';

const longChat = () => ([
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool1', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'tool1', content: LONG },
]);
const longResponses = () => ([
  { type: 'function_call_output', call_id: 'c1', output: LONG },
]);

describe('curator/tool-output-guard（onToolOutput）', () => {
  let saved;
  beforeEach(() => { saved = { ...TG.params }; });
  afterEach(() => { Object.assign(TG.params, saved); });

  test('默认参数全 null → 直接 passthrough，零行为变更（非侵入铁律）', () => {
    const msgs = longChat();
    const o = TG.handler({ messages: msgs }, {});
    expect(o.reason).toBe('off');
    expect(o.netTokenDelta).toBeNull();
  });

  test('maxOutputChars 生效：只砍中间段，头尾保留', () => {
    TG.params.maxOutputChars = 200;
    const msgs = longChat();
    const o = TG.handler({ messages: msgs }, {});
    expect(o.truncated).toBe(1);
    expect(o.netTokenDelta).toBeLessThan(0);
    const out = o.messages[1].content;
    expect(out).toContain('HEAD-LINE');
    expect(out).toContain('TAIL-LINE');
    expect(out.length).toBeLessThan(LONG.length);
  });

  test('maxToolOutputs 生效：超出的折叠成占位，保留条数线索', () => {
    TG.params.maxToolOutputs = 1;
    const msgs = longChat().concat(longChat().slice(1)); // 两条工具输出，上限 1
    const o = TG.handler({ messages: msgs }, {});
    expect(o.folded).toBe(1);
    expect(o.netTokenDelta).toBeLessThan(0);
    expect(o.messages[1].content).toContain('[工具输出已折叠 · 原');
  });

  test('恰好等于上限时不折叠（overflow=0 就是没有要折的，别报 folded）', () => {
    TG.params.maxToolOutputs = 1;
    const o = TG.handler({ messages: longChat() }, {});
    expect(o.folded).toBe(0);
    expect(o.reason).toBe('all-passed');
  });

  test('认 responses 协议的 function_call_output（onHistory 的 m.role===\'tool\' 够不到它）', () => {
    TG.params.maxToolOutputs = 1;
    const msgs = longResponses().concat(longResponses());
    const o = TG.handler({ messages: msgs }, {});
    expect(o.folded).toBe(1);
  });

  test('一段都没动 → netTokenDelta 报 null 而不是 0（0 会被读成「跑了但确实没省」）', () => {
    TG.params.maxOutputChars = 100000;
    const o = TG.handler({ messages: longChat() }, {});
    expect(o.reason).toBe('all-passed');
    expect(o.netTokenDelta).toBeNull();
  });

  test('没有 messages → 不炸，返回 null', () => {
    expect(TG.handler({}, {}).netTokenDelta).toBeNull();
  });
});

describe('curator/response-insight（onResponse）', () => {
  test('三条线各自算得出来：realSaving / estBiasAfter / claimBias', () => {
    // 改写前基线 1000，policy 自报省 400（改写后估算 600），上游真实 700
    const o = RI.handler({
      estTotal: 1000, estAfter: 600, estSaved: -400,
      response: JSON.stringify({ usage: { prompt_tokens: 700, completion_tokens: 30 } }),
    }, {});
    expect(o.actualPrompt).toBe(700);
    expect(o.realSaving).toBeCloseTo(0.3, 6);      // 基线 1000 → 真实 700，净省 30%
    expect(o.estBiasAfter).toBeCloseTo(700 / 600 - 1, 6); // 改写后估算 600 vs 真实 700 = 低估 ~16.7%
    // 自报省 400、真实省 300（1000→700）→ 虚报 100 token，占真实省的 33.3%
    expect(o.claimSavedTokens).toBe(400);
    expect(o.realSavedTokens).toBe(300);
    expect(o.overclaimTokens).toBe(100);
    expect(o.overclaimRatio).toBeCloseTo(100 / 300, 6);
    expect(o.note).toContain('real-saving-30.0%');
    expect(o.note).toContain('est-bias-under');
    expect(o.note).toContain('claim-over-33.3%');
  });

  test('🔴 绝不再报 est-off-high/low 这种会把净利润读成估算偏差的标签', () => {
    const o = RI.handler({ estTotal: 3257, estAfter: 929, estSaved: 2328, response: JSON.stringify({ usage: { prompt_tokens: 1546 } }) }, {});
    expect(JSON.stringify(o)).not.toMatch(/est-off-/);
    expect(o.note).toContain('real-saving-52.5%');
  });

  test('上游不吐 usage → 全 null，不许填 0', () => {
    const o = RI.handler({ estTotal: 1000, estAfter: 900, estSaved: -100, response: JSON.stringify({ id: 'x' }) }, {});
    expect(o.actualPrompt).toBeNull();
    expect(o.realSaving).toBeNull();
    expect(o.estBiasAfter).toBeNull();
    expect(o.overclaimTokens).toBeNull();
    expect(o.overclaimRatio).toBeNull();
    expect(o.note).toBe('usage-unavailable');
  });

  test('没给改写后估算 → estBiasAfter 为 null（不拿 estTotal 冒充改写后）', () => {
    const o = RI.handler({ estTotal: 1000, estSaved: -200, response: JSON.stringify({ usage: { prompt_tokens: 800 } }) }, {});
    expect(o.realSaving).toBeCloseTo(0.2, 6);
    expect(o.estBiasAfter).toBeNull();
    // 自报省 200（−estSaved）与真实省（1000−800）正好一致 → 0 是**算出来的真值**，不是「没数」。
    expect(o.overclaimTokens).toBe(0);
    expect(o.overclaimRatio).toBe(0);
  });

  test('SSE 累积文本：从末几个 data: 块里抽 usage', () => {
    const sse = 'data: {"x":1}\n\ndata: {"usage":{"prompt_tokens":900,"completion_tokens":10}}\n\n';
    const o = RI.handler({ estTotal: 1000, estAfter: 950, estSaved: -50, response: sse }, {});
    expect(o.actualPrompt).toBe(900);
    expect(o.actualCompletion).toBe(10);
  });

  test('改写后的估算一室抽不到 usage → hitRatio 仍可算（hit/miss 都在的时候）', () => {
    const o = RI.handler({ estTotal: 1000, estAfter: 950, estSaved: -50,
      response: JSON.stringify({ usage: { prompt_tokens: 950, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 50 } }) }, {});
    expect(o.hitRatio).toBeCloseTo(900 / 950, 6);
  });
});

// 「改写前真实」没有上游可问（不改写那一版没人发），只能拿 estTotal 当代理；
// 而 A/B 双发实测它相对真实高估 +5.6%（logs/bridge-ab-2026-10-02.json，4 组真包）。
// 这条 describe 锁住「代理 + 标定系数」这套换算别被改坏。
describe('curator/response-insight · 改写前真实代理与标定系数', () => {
  const RI_PATH = require.resolve('../../../packs/curator/policies/response-insight.js');
  const loadRI = (bias) => {
    // 🔴 必须用 jest.resetModules()：jest 有自己的 module registry，清 require.cache
    // （node:test 那套）对它无效 → 模块拿到的是上一份、标定的 env 根本没读到。
    jest.resetModules();
    if (bias == null) delete process.env.CURATOR_EST_BIAS_BEFORE;
    else process.env.CURATOR_EST_BIAS_BEFORE = String(bias);
    return require(RI_PATH);
  };
  afterAll(() => { delete process.env.CURATOR_EST_BIAS_BEFORE; jest.resetModules(); });

  // 真包 v1 的实测数：estTotal=3125，上游真实改写后 prompt=1538，policy 自报省 2183
  const RAW = { estTotal: 3125, estAfter: 942, estSaved: -2183, response: JSON.stringify({ usage: { prompt_tokens: 1538 } }) };

  test('没设标定系数 → 代理就是 estTotal 本身（旧行为零变化）', () => {
    const o = loadRI(null).handler(RAW, {});
    expect(o.estBiasBeforeCalibration).toBe(1);
    expect(o.estTotalProxy).toBe(3125);
    expect(o.realSaving).toBeCloseTo((3125 - 1538) / 3125, 6); // 0.508
  });

  test('标定 1.056（A/B 实测）→ realSaving 从 50.8% 修正到 53.4%，overclaim 跟着落到 421 tok', () => {
    const o = loadRI(1.056).handler(RAW, {});
    expect(o.estTotalProxy).toBeCloseTo(3300, 6);
    expect(o.realSavedTokens).toBe(1762);            // 3300 − 1538
    expect(o.realSaving).toBeCloseTo(1762 / 3300, 6);
    expect(o.claimSavedTokens).toBe(2183);
    expect(o.overclaimTokens).toBe(421);            // 自报 2183 − 真实净省 1762
    expect(o.overclaimRatio).toBeCloseTo(421 / 1762, 6);
    expect(o.overclaimRatio).toBeGreaterThan(0.2);  // 自报确实虚报 >20%（A/B 实测 13~21%）
  });

  test('标定了但上游没 usage → 全 null，不许拿标定后的代理值凑一个实测评比', () => {
    const o = loadRI(1.056).handler({ estTotal: 3125, estAfter: 942, estSaved: -2183, response: JSON.stringify({ id: 'x' }) }, {});
    expect(o.actualPrompt).toBeNull();
    expect(o.realSaving).toBeNull();
    expect(o.realSavedTokens).toBeNull();
    expect(o.overclaimTokens).toBeNull();
    expect(o.note).toBe('usage-unavailable');
  });
});
