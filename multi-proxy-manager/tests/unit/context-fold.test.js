'use strict';
// 28 号文档 C1 + C3 的保护网。
// C1 = context-fold 七类组成内核（秤）；C3 = token-policy 账本记真数。
const F = require('../../../l2/context-fold.js');
const TP = require('../../../l2/token-policy.js');

describe('context-fold kernel (l2/context-fold.js · 28 号文档 C1「秤」)', () => {
  // 精确估算器：1 字符 = 1 token，让计数可被机械断言，不受默认 /3 启发式干扰
  const exact = (s) => (typeof s === 'string' ? s.length : 0);
  const mk = (o) => F.createContextFold({ estimate: exact, ...(o || {}) });

  test('七类坐标系（对齐 dsh-context categories.ts:27-35）', () => {
    expect(F.CATEGORIES).toEqual(['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']);
    expect(Object.keys(mk().fold({}).estimate.byCategory)).toEqual(F.CATEGORIES);
  });

  test('消息按 role 归五类', () => {
    const r = mk().fold({
      messages: [
        { role: 'system', content: 'abcd' },
        { role: 'user', content: 'abcdef' },
        { role: 'assistant', content: 'xy' },
        { role: 'tool', content: '123456789' },
      ],
    });
    expect(r.estimate.byCategory).toMatchObject({ system: 4, user: 6, assistant: 2, tool: 9 });
    expect(r.estimate.total).toBe(21);
  });

  test('tools 类只算 schema；assistant 的 tool_calls arguments 不混进 tools', () => {
    const schema = { type: 'function', function: { name: 'search' } };
    const r = mk().fold({
      messages: [{ role: 'assistant', content: 'ok', tool_calls: [{ function: { arguments: '{"q":"ab"}' } }] }],
      tools: [schema],
    });
    expect(r.estimate.byCategory.tools).toBe(JSON.stringify(schema).length);
    expect(r.estimate.byCategory.assistant).toBe(2 + '{"q":"ab"}'.length);
  });

  test('developer role 归 system（o1 之后的系统级 role）', () => {
    const r = mk().fold({ messages: [{ role: 'developer', content: 'rule12345' }] });
    expect(r.estimate.byCategory.system).toBe(9);
    expect(r.estimate.unclassified).toBe(0);
  });

  test('第七类：inject / skill 分开记账并出 bySource 明细（C4 pack 入账前提）', () => {
    const r = mk().fold({ messages: [{ role: 'user', content: 'hi' }] }, {
      injections: [
        { sink: 'inject', source: 'rag', tokens: 30 },
        { sink: 'skill', source: 'curator-pack', tokens: 50 },
        { sink: 'skill', source: 'curator-pack', tokens: 20 },
      ],
    });
    expect(r.estimate.byCategory.inject).toBe(30);
    expect(r.estimate.byCategory.skill).toBe(70);
    expect(r.bySource['curator-pack']).toEqual({ inject: 0, skill: 70 });
  });

  test('实测分摊：七类之和精确等于 provider prompt_tokens（余数已校正）', () => {
    const r = mk().fold({
      messages: [{ role: 'system', content: 'a'.repeat(10) }, { role: 'user', content: 'b'.repeat(30) }],
    }, { actuals: { prompt_tokens: 100, cached_tokens: 12 } });
    expect(r.source).toBe('actual');
    expect(Object.values(r.actual.byCategory).reduce((a, b) => a + b, 0)).toBe(100);
    expect(r.actual.byCategory).toMatchObject({ system: 25, user: 75 });
    expect(r.actual.cached).toBe(12);
  });

  test('没给实测值就不得标 actual，且必须告警（不得拿估算冒充实测）', () => {
    const r = mk().fold({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.source).toBe('estimate');
    expect(r.actual).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/no-provider-actuals/);
  });

  test('未知 role 不静默丢弃：单列 unclassified 并告警', () => {
    const r = mk().fold({ messages: [{ role: 'mystery', content: 'zzzz' }] });
    expect(r.estimate.unclassified).toBe(4);
    expect(r.estimate.total).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/unclassified/);
  });

  test('估算总数为 0 而实测有值 → 不分摊、告警，不除零不伪造', () => {
    const r = mk().fold({ messages: [] }, { actuals: { prompt_tokens: 42 } });
    expect(r.actual).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/estimate-total-is-zero/);
  });

  test('默认估算器复用 token-policy.estimateTokens（AGENTS §3 不重复实现）', () => {
    expect(F.createContextFold().fold({ messages: [{ role: 'system', content: 'a'.repeat(30) }] })
      .estimate.byCategory.system).toBe(10);
  });
});

describe('token-policy 账本记真数（l2/token-policy.js · 28 号文档 C3）', () => {
  let tp;
  beforeEach(() => { tp = TP.createTokenPolicy({ gate: false }); });

  test('handler 上报 netTokenDelta → 记进 result 并累加到 estSavedTokens', () => {
    tp.registerPolicy({ hook: 'onHistory', name: 'compact', cost: 10, handler: () => ({ netTokenDelta: -50 }) });
    const run = tp.apply('onHistory', { agentType: 'coding' });
    expect(run.results[0].netTokenDelta).toBe(-50);
    expect(tp.report().estSavedTokens).toBe(-50);
  });

  test('handler 未上报 → netTokenDelta 为 null 而非 0（拒绝假数字）', () => {
    tp.registerPolicy({ hook: 'onHistory', name: 'noop', cost: 10, handler: () => ({ out: 'anything' }) });
    const run = tp.apply('onHistory', { agentType: 'coding' });
    expect(run.results[0].netTokenDelta).toBeNull();
    expect(tp.report().estSavedTokens).toBe(0);
  });

  test('handler 抛错 → 该 result 同样记 null，不伪造', () => {
    tp.registerPolicy({ hook: 'onHistory', name: 'boom', cost: 10, handler: () => { throw new Error('x'); } });
    const run = tp.apply('onHistory', { agentType: 'coding' });
    expect(run.results[0].netTokenDelta).toBeNull();
    expect(run.results[0].ok).toBe(false);
  });

  test('单次调用多 policy 的 delta 累加', () => {
    tp.registerPolicy({ hook: 'onRoute', name: 'a', cost: 10, handler: () => ({ netTokenDelta: -30 }) });
    tp.registerPolicy({ hook: 'onRoute', name: 'b', cost: 10, handler: () => ({ netTokenDelta: -12 }) });
    tp.apply('onRoute', { agentType: 'coding' });
    expect(tp.report().estSavedTokens).toBe(-42);
  });

  test('单例可读执行留痕 _runHistory（外部可读）', () => {
    expect(Array.isArray(TP._runHistory)).toBe(true);
  });
});
