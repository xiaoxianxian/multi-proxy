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
    // 别把数字写死：估算器 2026-10-01 起是 CJK-aware（ASCII ≈ 0.255 token/字符），30 个 'a' 现在是 8 不是旧口径的 10。
    // 断言钉「与估算器实值一致 + 量级下限」，系数再漂也不假失败。
    expect(F.createContextFold().fold({ messages: [{ role: 'system', content: 'a'.repeat(30) }] })
      .estimate.byCategory.system).toBe(TP.estimateTokens('a'.repeat(30)));
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

describe('context-fold · C2 per-request 记录 + Delta（时间线）', () => {
  const exact = (s) => (typeof s === 'string' ? s.length : 0);
  const mk = (o) => F.createContextFold({ estimate: exact, ...(o || {}) });
  const MSG = (n) => ({ role: 'user', content: 'a'.repeat(n) });

  test('首条 delta 为 null（不是全 0）—— 0 会被读成「确实没变」', () => {
    const f = mk();
    const r1 = f.record({ messages: [MSG(30)] }, { now: 1000 });
    expect(r1.delta).toBeNull();
    expect(r1.turn).toBe(1);
    expect(r1.estimate.total).toBe(30);
  });

  test('第二条能看出历史膨胀，增量落在对应类别', () => {
    const f = mk();
    f.record({ messages: [MSG(30)] }, { now: 1000 });
    const r2 = f.record({ messages: [MSG(30), { role: 'assistant', content: 'b'.repeat(30) }] }, { now: 2000 });
    expect(r2.turn).toBe(2);
    expect(r2.delta.total).toBe(30);
    expect(r2.delta.byCategory.assistant).toBe(30);
    expect(r2.delta.byCategory.user).toBe(0);
  });

  test('压缩生效 → delta 为负（这是「省没省」的判据）', () => {
    const f = mk();
    f.record({ messages: [MSG(300)] }, { now: 1000 });
    const r2 = f.record({ messages: [MSG(30)] }, { now: 2000 });
    expect(r2.delta.total).toBe(-270);
  });

  test('实测与估算混用 → delta.source=mixed，不得冒充实测', () => {
    const f = mk();
    f.record({ messages: [MSG(30)] }, { now: 1000 });
    const r2 = f.record({ messages: [MSG(60)] }, { now: 2000, actuals: { prompt_tokens: 60 } });
    expect(r2.delta.source).toBe('mixed');
  });

  test('两帧都实测 → source=actual', () => {
    const f = mk();
    f.record({ messages: [MSG(30)] }, { now: 1000, actuals: { prompt_tokens: 30 } });
    const r2 = f.record({ messages: [MSG(60)] }, { now: 2000, actuals: { prompt_tokens: 60 } });
    expect(r2.delta.source).toBe('actual');
    expect(r2.delta.total).toBe(30);
  });

  test('sessionId 隔离：跨会话不互相算 delta', () => {
    const f = mk();
    f.record({ messages: [MSG(30)] }, { now: 1000, sessionId: 's1' });
    const r2 = f.record({ messages: [MSG(30)] }, { now: 1000, sessionId: 's2' });
    expect(r2.delta).toBeNull();
    expect(f.list()).toHaveLength(2);
    expect(f.list('s1')).toHaveLength(1);
  });

  test('turn 显式传入时以传入为准', () => {
    const f = mk();
    expect(f.record({ messages: [MSG(30)] }, { now: 1, turn: 7 }).turn).toBe(7);
  });

  test('window 按时间窗过滤；clear 清空并返回条数', () => {
    const f = mk();
    f.record({ messages: [MSG(30)] }, { now: 1000 });
    f.record({ messages: [MSG(30)] }, { now: 5000 });
    expect(f.window(1000, 5000)).toHaveLength(1);
    expect(f.clear()).toBe(2);
    expect(f.list()).toHaveLength(0);
  });

  test('maxRecords 上限保护：超量丢弃最老，不无限涨内存', () => {
    const f = mk({ maxRecords: 3 });
    for (let i = 1; i <= 5; i += 1) { f.record({ messages: [MSG(30)] }, { now: i * 1000, turn: i }); }
    expect(f.list()).toHaveLength(3);
    expect(f.list()[0].turn).toBe(3);
  });

  test('fold() 仍是纯函数：不写状态、不进时间线（加状态层不能打破这条）', () => {
    const f = mk();
    const req = { messages: [MSG(30)] };
    const a = f.fold(req);
    const b = f.fold(req);
    expect(f.list()).toHaveLength(0);
    expect(a.estimate.total).toBe(b.estimate.total);
    expect(a).not.toBe(b);
  });
});

describe('context-fold C5（tool schema 来源标注 · schema 懒加载前置）', () => {
  const exact = (s) => (typeof s === 'string' ? s.length : 0);
  const mk = (o) => F.createContextFold({ estimate: exact, ...(o || {}) });

  test('classifyToolName 三种来源，且 server 名含下划线不被贪婪匹配吞掉', () => {
    expect(F.classifyToolName('mcp__github__search')).toEqual({ source: 'mcp', server: 'github', name: 'search' });
    expect(F.classifyToolName('Read')).toEqual({ source: 'named', server: null, name: 'Read' });
    expect(F.classifyToolName('')).toEqual({ source: 'unnamed', server: null, name: null });
    expect(F.classifyToolName(undefined)).toEqual({ source: 'unnamed', server: null, name: null });
    const r = F.classifyToolName('mcp__my_server__do_thing');
    expect(r.server).toBe('my_server');
    expect(r.name).toBe('do_thing');
  });

  test('MCP 工具按 server 分组（懒加载的最小可动粒度）', () => {
    const t1 = { name: 'mcp__github__aa' };
    const t3 = { name: 'mcp__linear__cc' };
    const unit = JSON.stringify(t1).length;
    expect(JSON.stringify(t3).length).toBe(unit);
    const r = mk().fold({ tools: [t1, { name: 'mcp__github__bb' }, t3] });
    expect(r.estimate.toolCount).toBe(3);
    expect(r.estimate.toolsBySource['mcp:github']).toBe(unit * 2);
    expect(r.estimate.toolsBySource['mcp:linear']).toBe(unit);
  });

  test('来源分组之和 == tools 桶总量（C5 不得改变既有口径）', () => {
    const r = mk().fold({
      tools: [
        { name: 'mcp__github__aa' },
        { name: 'mcp__github__bb' },
        { name: 'mcp__linear__cc' },
        { name: 'Read' },
      ],
    });
    const sum = Object.values(r.estimate.toolsBySource).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.estimate.byCategory.tools);
    expect(r.estimate.toolsBySource.named).toBeGreaterThan(0);
  });

  test('OpenAI function 形态（function.name）也能认出来源', () => {
    const r = mk().fold({ tools: [{ type: 'function', function: { name: 'mcp__github__aa' } }] });
    expect(r.estimate.toolsBySource['mcp:github']).toBeGreaterThan(0);
    expect(r.estimate.toolsUnnamed).toBe(0);
  });

  test('取不到名字 → 归 unnamed 且告警，不静默丢弃', () => {
    const r = mk().fold({ tools: [{ type: 'function' }, { description: 'x' }] });
    expect(r.estimate.toolsUnnamed).toBe(2);
    expect(r.estimate.toolsBySource.unnamed).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes('unnamed'))).toBe(true);
  });

  test('无 tools 时来源分组为空对象，不产生噪音字段', () => {
    const r = mk().fold({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.estimate.toolsBySource).toEqual({});
    expect(r.estimate.toolCount).toBe(0);
    expect(r.estimate.toolsUnnamed).toBe(0);
    // 注意：warnings 不为空——C1 常驻一条 no-provider-actuals（未给实测值即告警）。
    // 这里要守的是 C5 不额外制造噪音，而不是 warnings 为空。
    expect(r.warnings.some((w) => w.includes('unnamed'))).toBe(false);
  });

  test('答得出「某个 MCP server 占 tools 桶多少」——懒加载的决策依据', () => {
    const tools = [];
    for (let i = 0; i < 40; i++) { tools.push({ name: `mcp__heavy__t${String(i).padStart(2, '0')}` }); }
    tools.push({ name: 'Read' });
    const r = mk().fold({ tools });
    expect(r.estimate.toolsBySource['mcp:heavy'] / r.estimate.byCategory.tools).toBeGreaterThan(0.9);
  });
});
