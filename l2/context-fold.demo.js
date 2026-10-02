'use strict';
// context-fold 内核 · 真跑验证 demo（node l2/context-fold.demo.js）
// 全内存、纯函数、零 manager 依赖。
// 验收目标：给 injections / actuals / 异常 role / 图片等不同输入，七类组成都能算对且不丢数。
const F = require('./context-fold.js');
const TP = require('./token-policy.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}      -- ${e.message}`); } };

// 注入精确估算器（1 字符 = 1 token），让计数可被机械断言，不受默认 /3 启发式干扰
const exact = (s) => (typeof s === 'string' ? s.length : 0);
const mk = (o) => F.createContextFold({ estimate: exact, ...(o || {}) });

// 1. 七类齐全且顺序稳定（顺序 = 堆叠条从上到下，不能每次变）
check('1. 七类齐全且顺序固定', () => {
    assert.deepStrictEqual(F.CATEGORIES, ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']);
    const r = mk().fold({ messages: [] });
    assert.deepStrictEqual(Object.keys(r.estimate.byCategory), F.CATEGORIES, '返回对象的键顺序应与 CATEGORIES 一致');
});

// 2. 消息按 role 归五类（system / user / assistant / tool）
check('2. 消息按 role 归五类', () => {
    const r = mk().fold({
        messages: [
            { role: 'system', content: 'abcd' },        // 4
            { role: 'user', content: 'abcdef' },        // 6
            { role: 'assistant', content: 'xy' },       // 2
            { role: 'tool', content: '123456789' },     // 9
        ],
    });
    const c = r.estimate.byCategory;
    assert.strictEqual(c.system, 4, 'system=4');
    assert.strictEqual(c.user, 6, 'user=6');
    assert.strictEqual(c.assistant, 2, 'assistant=2');
    assert.strictEqual(c.tool, 9, 'tool=9');
    assert.strictEqual(r.estimate.total, 21, '总数=21');
});

// 3. tools 类只算 schema 声明，且与 assistant 的 tool_calls arguments 互不混淆
check('3. tools 类 = schema 声明；tool_calls arguments 归 assistant', () => {
    const schema = { type: 'function', function: { name: 'search' } };
    const schemaText = JSON.stringify(schema);
    const r = mk().fold({
        messages: [
            { role: 'assistant', content: 'ok', tool_calls: [{ function: { arguments: '{"q":"ab"}' } }] },
        ],
        tools: [schema],
    });
    const c = r.estimate.byCategory;
    assert.strictEqual(c.tools, schemaText.length, 'tools = schema JSON 长度');
    assert.strictEqual(c.assistant, 2 + '{"q":"ab"}'.length, 'assistant = 正文 + arguments');
});

// 4. developer role（o1 之后的系统级）归 system，不丢进 unclassified
check('4. developer role 归 system', () => {
    const r = mk().fold({ messages: [{ role: 'developer', content: 'rule12345' }] });
    assert.strictEqual(r.estimate.byCategory.system, 9, 'developer 计入 system');
    assert.strictEqual(r.estimate.unclassified, 0, '不产生未分类残量');
});

// 5. 注入进第七类，并按 source 出明细（C4 pack 入账的前提）
check('5. inject/skill 分类 + bySource 明细', () => {
    const r = mk().fold({ messages: [{ role: 'user', content: 'hi' }] }, {
        injections: [
            { sink: 'inject', source: 'rag', tokens: 30 },
            { sink: 'skill', source: 'curator-pack', tokens: 50 },
            { sink: 'skill', source: 'curator-pack', tokens: 20 },
        ],
    });
    const c = r.estimate.byCategory;
    assert.strictEqual(c.inject, 30, 'inject=30');
    assert.strictEqual(c.skill, 70, 'skill=30+... 两次注入累加=70');
    assert.strictEqual(r.bySource['curator-pack'].skill, 70, 'bySource 按来源聚合');
    assert.strictEqual(r.bySource.rag.inject, 30, 'rag 走 inject 桶');
});

// 6. 实测轨：七类之和必须精确等于 provider prompt_tokens（余数已校正）
check('6. 实测分摊：七类之和精确 == prompt_tokens', () => {
    const r = mk().fold({
        messages: [
            { role: 'system', content: 'a'.repeat(10) },
            { role: 'user', content: 'b'.repeat(30) },
        ],
    }, { actuals: { prompt_tokens: 100, completion_tokens: 5, cached_tokens: 12 } });
    assert.strictEqual(r.source, 'actual', '给了实测值 → source=actual');
    const sum = Object.values(r.actual.byCategory).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, 100, `七类分摊之和应精确等于 100，实得 ${sum}`);
    assert.strictEqual(r.actual.total, 100, '实测总数透传');
    assert.strictEqual(r.actual.cached, 12, '缓存命中 token 透传');
    // 比例应保持估算占比：10 : 30 → 25 : 75
    assert.strictEqual(r.actual.byCategory.system, 25, 'system 占 25');
    assert.strictEqual(r.actual.byCategory.user, 75, 'user 占 75');
});

// 7. 双轨并存：有实测时估算轨仍在，且两轨互不污染
check('7. 估算轨与实测轨并存互不污染', () => {
    const r = mk().fold({ messages: [{ role: 'user', content: 'c'.repeat(20) }] },
        { actuals: { prompt_tokens: 200 } });
    assert.strictEqual(r.estimate.total, 20, '估算轨保留原始值 20');
    assert.strictEqual(r.actual.total, 200, '实测轨保留上报值 200');
    assert.notStrictEqual(r.estimate.byCategory, r.actual.byCategory, '两轨是不同对象');
});

// 8. 没有实测值时必须明说（不得拿估算冒充实测）
check('8. 无实测 → source=estimate 且带告警', () => {
    const r = mk().fold({ messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(r.source, 'estimate', '没给 actuals 就不能标 actual');
    assert.strictEqual(r.actual, null, 'actual 应为 null');
    assert.ok(r.warnings.some((w) => w.includes('no-provider-actuals')), '必须告警说明这是估算');
});

// 9. 异常 role 不静默丢弃：进 unclassified 并告警
check('9. 未知 role 不静默丢弃', () => {
    const r = mk().fold({ messages: [{ role: 'mystery', content: 'zzzz' }] });
    assert.strictEqual(r.estimate.unclassified, 4, '未知 role 的 token 单列');
    assert.strictEqual(r.estimate.total, 0, '且不计入七类总数');
    assert.ok(r.warnings.some((w) => w.includes('unclassified')), '必须告警');
});

// 10. 图片 part 按兜底值估算并声明
check('10. 图片 part 兜底估算 + 告警', () => {
    const r = mk({ imageTokens: 512 }).fold({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ab' }, { type: 'image_url', image_url: { url: 'x' } }] }],
    });
    assert.strictEqual(r.estimate.byCategory.user, 2 + 512, '文本 + 图片兜底值');
    assert.ok(r.warnings.some((w) => w.includes('image-estimated')), '必须声明图片是估算');
});

// 11. 空请求不死、不造数
check('11. 空请求安全降级', () => {
    const r = mk().fold({});
    assert.strictEqual(r.estimate.total, 0, '空请求总数 0');
    assert.strictEqual(r.source, 'estimate', 'source 仍为 estimate');
    const r2 = mk().fold();
    assert.strictEqual(r2.estimate.total, 0, '不传参数也安全');
});

// 12. 估算总数为 0 而实测有值 → 无法分摊，必须告警而不是除零或硬编羼
check('12. 估算是 0 但实测有数 → 告警而非伪造', () => {
    const r = mk().fold({ messages: [] }, { actuals: { prompt_tokens: 42 } });
    assert.strictEqual(r.actual, null, '无法分摊时 actual 保持 null');
    assert.ok(r.warnings.some((w) => w.includes('estimate-total-is-zero')), '必须说明分摊失败原因');
});

// 13. 默认估算器直接用 token-policy.estimateTokens（AGENTS §3 复用不重造）
// ⚠️ 注意别把具体数值写死：2026-10-01 校准后估算器是 CJK-aware（ASCII ≈ 0.255 token/字符），
// 30 个 'a' 现在是 8 而不是 8 的旧口径 10。断言只钉「与估算器实值一致」，系数再漂也不假失败。
check('13. 默认估算器复用 token-policy.estimateTokens', () => {
    const r = F.createContextFold().fold({ messages: [{ role: 'system', content: 'a'.repeat(30) }] });
    assert.strictEqual(r.estimate.byCategory.system, TP.estimateTokens('a'.repeat(30)), '与估算器实值一致');
    assert.ok(r.estimate.total >= 8, `30 ASCII 字符下限 8，实际 ${r.estimate.total}`);
});

// ---- C2：per-request 折叠 + Delta（时间线）----

// 14. 首条没有参照物 → delta 必须是 null，不是全 0
check('14. record 首条 delta=null（不是全 0）', () => {
    const f = mk();
    const r1 = f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000 });
    assert.strictEqual(r1.delta, null, '首条无参照物，delta 必须是 null');
    assert.strictEqual(r1.turn, 1, '首条 turn=1');
    assert.strictEqual(r1.estimate.total, 30, '30 字符 = 30（本 demo 用精确估算器 1 字符 1 token）');
});

// 15. 第二条能看出膨胀：多出来的落在 assistant 类（历史在变长）
check('15. delta 反映上下文演进（膨胀可量化）', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000 });
    const r2 = f.record({
        messages: [
            { role: 'user', content: 'a'.repeat(30) },
            { role: 'assistant', content: 'b'.repeat(30) },
        ],
    }, { now: 2000 });
    assert.strictEqual(r2.turn, 2, 'turn 递增');
    assert.strictEqual(r2.delta.total, 30, '总量 +30');
    assert.strictEqual(r2.delta.byCategory.assistant, 30, '增量全落在 assistant（历史在膨胀）');
    assert.strictEqual(r2.delta.byCategory.user, 0, 'user 没变');
});

// 16. 压缩生效时 delta 为负 —— 这条才是「省没省」的真正判据
check('16. 压缩生效 → delta 为负（省没省看得见）', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(300) }] }, { now: 1000 });
    const r2 = f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 2000 });
    assert.strictEqual(r2.delta.total, -270, '300 → 30，净省 270');
});

// 17. 一帧实测一帧估算 → 标 mixed，不许冒充实测
check('17. 实测与估算混用 → delta.source=mixed', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000 });
    const r2 = f.record(
        { messages: [{ role: 'user', content: 'a'.repeat(60) }] },
        { now: 2000, actuals: { prompt_tokens: 60 } },
    );
    assert.strictEqual(r2.delta.source, 'mixed', '混血不得标 actual');
});

// 18. sessionId 隔离：不同会话不互相算 delta
check('18. sessionId 隔离（跨会话不串味）', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000, sessionId: 's1' });
    const r2 = f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000, sessionId: 's2' });
    assert.strictEqual(r2.delta, null, '新会话首条不应与 s1 比');
    assert.strictEqual(f.list().length, 2, '两条都在时间线里');
    assert.strictEqual(f.list('s1').length, 1, '按会话可筛');
});

// 19. window 时间窗过滤 + clear 可清空（测试隔离靠它）
check('19. window 过滤 + clear', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000 });
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 5000 });
    assert.strictEqual(f.window(1000, 5000).length, 1, '窗口内只留最近 1 条');
    assert.strictEqual(f.clear(), 2, 'clear 返回清掉条数');
    assert.strictEqual(f.list().length, 0, '清空后为空');
});

// 20. 上限保护：长会话不会无限涨内存
check('20. maxRecords 上限保护（丢弃最老）', () => {
    const f = mk({ maxRecords: 3 });
    for (let i = 1; i <= 5; i += 1) {
        f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: i * 1000, turn: i });
    }
    assert.strictEqual(f.list().length, 3, '只保留 3 条');
    assert.strictEqual(f.list()[0].turn, 3, '最老的 1、2 被丢弃');
});

// ---- C5：tool schema 来源标注（schema 懒加载的前置）----
// 断言一律用「关系」而非硬编码绝对值，估算器口径变了也不会假失败。

check('21. classifyToolName 三种来源：MCP / named / unnamed', () => {
    assert.deepStrictEqual(F.classifyToolName('mcp__github__search'), { source: 'mcp', server: 'github', name: 'search' });
    assert.deepStrictEqual(F.classifyToolName('Read'), { source: 'named', server: null, name: 'Read' });
    assert.deepStrictEqual(F.classifyToolName(''), { source: 'unnamed', server: null, name: null });
    assert.deepStrictEqual(F.classifyToolName(null), { source: 'unnamed', server: null, name: null });
    // server 名含下划线：非贪婪匹配不能被吞掉
    assert.strictEqual(F.classifyToolName('mcp__my_server__do_thing').server, 'my_server');
    assert.strictEqual(F.classifyToolName('mcp__my_server__do_thing').name, 'do_thing');
});

check('22. MCP 工具按 server 分组（懒加载的最小可动粒度）', () => {
    const t1 = { name: 'mcp__github__aa' };
    const t2 = { name: 'mcp__github__bb' };
    const t3 = { name: 'mcp__linear__cc' };
    const unit = JSON.stringify(t1).length;
    assert.strictEqual(JSON.stringify(t3).length, unit, '构造前提：三条声明等长，便于倍数断言');
    const r = mk().fold({ tools: [t1, t2, t3] });
    assert.strictEqual(r.estimate.toolCount, 3, 'toolCount=3');
    assert.strictEqual(r.estimate.toolsBySource['mcp:github'], unit * 2, 'github 两条');
    assert.strictEqual(r.estimate.toolsBySource['mcp:linear'], unit, 'linear 一条');
});

check('23. 来源分组之和 == tools 桶总量（C5 不得改变既有口径）', () => {
    const r = mk().fold({
        tools: [
            { name: 'mcp__github__aa' },
            { name: 'mcp__github__bb' },
            { name: 'mcp__linear__cc' },
            { name: 'Read' },
        ],
    });
    const sum = Object.values(r.estimate.toolsBySource).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, r.estimate.byCategory.tools, '分组求和必须等于 tools 桶总量');
    assert.ok(r.estimate.toolsBySource.named > 0, '非 MCP 具名工具落 named');
});

check('24. OpenAI function 形态（function.name）也能认出来源', () => {
    const r = mk().fold({ tools: [{ type: 'function', function: { name: 'mcp__github__aa' } }] });
    assert.ok(r.estimate.toolsBySource['mcp:github'] > 0, 'function.name 应被识别为 MCP 来源');
    assert.strictEqual(r.estimate.toolsUnnamed, 0, '不该被判为无名');
});

check('25. 取不到名字 → 归 unnamed 且告警（不静默丢弃）', () => {
    const r = mk().fold({ tools: [{ type: 'function' }, { description: 'x' }] });
    assert.strictEqual(r.estimate.toolsUnnamed, 2, '两条都无名字');
    assert.ok(r.estimate.toolsBySource.unnamed > 0, 'unnamed 桶必须有量，不能丢');
    assert.ok(r.warnings.some((w) => w.includes('unnamed')), '必须告警');
});

check('26. 答得出「某个 MCP server 占 tools 桶多少」——懒加载的决策依据', () => {
    const tools = [];
    for (let i = 0; i < 40; i++) { tools.push({ name: `mcp__heavy__t${String(i).padStart(2, '0')}` }); }
    tools.push({ name: 'Read' });
    const r = mk().fold({ tools });
    const ratio = r.estimate.toolsBySource['mcp:heavy'] / r.estimate.byCategory.tools;
    assert.ok(ratio > 0.9, `单个重型 server 应占 tools 桶九成以上，实测 ${(ratio * 100).toFixed(1)}%`);
});

// ---- C2：per-request 折叠 + Delta（时间线）----

// 14. 首条没有参照物 → delta 必须是 null，不是全 0
check('14. record 首条 delta=null（不是全 0）', () => {
    const f = mk();
    const r1 = f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000 });
    assert.strictEqual(r1.delta, null, '首条无参照物，delta 必须是 null');
    assert.strictEqual(r1.turn, 1, '首条 turn=1');
    assert.strictEqual(r1.estimate.total, 30, '30 字符 = 30（本 demo 用精确估算器 1 字符 1 token）');
});

// 15. 第二条能看出膨胀：多出来的落在 assistant 类（历史在变长）
check('15. delta 反映上下文演进（膨胀可量化）', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000 });
    const r2 = f.record({
        messages: [
            { role: 'user', content: 'a'.repeat(30) },
            { role: 'assistant', content: 'b'.repeat(30) },
        ],
    }, { now: 2000 });
    assert.strictEqual(r2.turn, 2, 'turn 递增');
    assert.strictEqual(r2.delta.total, 30, '总量 +30');
    assert.strictEqual(r2.delta.byCategory.assistant, 30, '增量全落在 assistant（历史在膨胀）');
    assert.strictEqual(r2.delta.byCategory.user, 0, 'user 没变');
});

// 16. 压缩生效时 delta 为负 —— 这条才是「省没省」的真正判据
check('16. 压缩生效 → delta 为负（省没省看得见）', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(300) }] }, { now: 1000 });
    const r2 = f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 2000 });
    assert.strictEqual(r2.delta.total, -270, '300 → 30，净省 270');
});

// 17. 一帧实测一帧估算 → 标 mixed，不许冒充实测
check('17. 实测与估算混用 → delta.source=mixed', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000 });
    const r2 = f.record(
        { messages: [{ role: 'user', content: 'a'.repeat(60) }] },
        { now: 2000, actuals: { prompt_tokens: 60 } },
    );
    assert.strictEqual(r2.delta.source, 'mixed', '混血不得标 actual');
});

// 18. sessionId 隔离：不同会话不互相算 delta
check('18. sessionId 隔离（跨会话不串味）', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000, sessionId: 's1' });
    const r2 = f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000, sessionId: 's2' });
    assert.strictEqual(r2.delta, null, '新会话首条不应与 s1 比');
    assert.strictEqual(f.list().length, 2, '两条都在时间线里');
    assert.strictEqual(f.list('s1').length, 1, '按会话可筛');
});

// 19. window 时间窗过滤 + clear 可清空（测试隔离靠它）
check('19. window 过滤 + clear', () => {
    const f = mk();
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 1000 });
    f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: 5000 });
    assert.strictEqual(f.window(1000, 5000).length, 1, '窗口内只留最近 1 条');
    assert.strictEqual(f.clear(), 2, 'clear 返回清掉条数');
    assert.strictEqual(f.list().length, 0, '清空后为空');
});

// 20. 上限保护：长会话不会无限涨内存
check('20. maxRecords 上限保护（丢弃最老）', () => {
    const f = mk({ maxRecords: 3 });
    for (let i = 1; i <= 5; i += 1) {
        f.record({ messages: [{ role: 'user', content: 'a'.repeat(30) }] }, { now: i * 1000, turn: i });
    }
    assert.strictEqual(f.list().length, 3, '只保留 3 条');
    assert.strictEqual(f.list()[0].turn, 3, '最老的 1、2 被丢弃');
});

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
