'use strict';
// P1.1a 记忆服务内核 · 真跑验证 demo（node l2/memory-merge.demo.js）
// 全默认零网络零文件、零 LLM。重点证明 §5.2「非侵入」：envInject 只产出映射，绝不写 process.env / 不碰 agent 文件。
const assert = require('assert');
const M = require('./memory-merge.js');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}   -- ${e.message}`); } };
// 公共 + 个性 两层样例（specVersion 1.0.0，与 specs/agent-memory.json 同构）
const shared = {
    specVersion: '1.0.0',
    entries: [
        { id: 'mem-etimedout-no-proxy', type: 'error-pattern', scope: 'shared', key: 'etimedout-after-proxy-bypass',
          value: 'NO_PROXY 含裸 * 致 ETIMEDOUT', tags: ['network'], source: 'shared:error-patterns.json',
          createdAt: '2026-07-03T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z', specVersion: '1.0.0' },
        { id: 'mem-pref-response', type: 'preference', scope: 'shared', key: 'response-language',
          value: '简体中文作答', tags: ['i18n'], source: 'shared:user-profile.json',
          createdAt: '2026-07-04T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z', specVersion: '1.0.0' },
    ],
};
const personal = {
    specVersion: '1.0.0',
    entries: [
        // 个性化覆盖公共的 response-language（更晚 updatedAt + 个性层，默认覆盖）
        { id: 'mem-pref-response-personal', type: 'preference', scope: 'codex', key: 'response-language',
          value: '称用户为『老板』，禁小微笑', tags: ['i18n', 'persona'], source: 'codex:local',
          createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z', specVersion: '1.0.0' },
        { id: 'mem-codex-allowed-tools', type: 'template', scope: 'codex', key: 'tools-allowed',
          value: 'bash,git,node', tags: ['config'], source: 'codex:local',
          createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', specVersion: '1.0.0' },
    ],
};

// 1. 合并 + 默认个性覆盖公共
check('merge: 公共+个性，默认个人覆盖公共', () => {
    const m = M.merge(shared, personal);
    assert.strictEqual(m.specVersion, '1.0.0');
    assert.ok(m.meta.total >= 3, 'total>=3');
    const pref = m.entries.find(e => e.key === 'response-language');
    assert.strictEqual(pref.scope, 'codex', 'response-language 被个性覆盖');
    assert.strictEqual(pref.value, '称用户为『老板』，禁小微笑');
});
// 2. 冲突策略 error：记录冲突但不覆盖
check('merge: strategy=error 记录冲突', () => {
    const m = M.merge(shared, personal, { strategy: 'error' });
    assert.ok(m.meta.conflicts.length >= 1, 'conflicts>=1');
    assert.ok(m.meta.conflicts.some(c => c.key === 'response-language'));
});
// 3. 冲突策略 shared：公共胜出
check('merge: strategy=shared 公共胜出', () => {
    const m = M.merge(shared, personal, { strategy: 'shared' });
    const pref = m.entries.find(e => e.key === 'response-language');
    assert.strictEqual(pref.value, '简体中文作答', '公共值胜出');
});

// 4. envInject 默认零副作用（不写 process.env，只产映射）—— 非侵入核心证明
check('envInject: 非侵入，不写 process.env（§5.2）', () => {
    const before = Object.keys(process.env).filter(k => k.startsWith('AGENT_')).sort();
    const env = M.envInject(M.merge(shared, personal));
     // 产出映射含 §5.2 三类目标
    assert.ok(env.AGENT_SYSTEM_PROMPT, 'preference -> AGENT_SYSTEM_PROMPT');
    assert.ok(env.AGENT_ERROR_PATTERNS, 'error-pattern -> AGENT_ERROR_PATTERNS');
    assert.ok(env.AGENT_TOOLS_ALLOWED, 'template -> AGENT_TOOLS_ALLOWED');
     // process.env 未被 mutate（无新增 AGENT_* 键）
    const after = Object.keys(process.env).filter(k => k.startsWith('AGENT_')).sort();
    assert.deepStrictEqual(after, before, 'process.env 无新增 AGENT_* 键');
     // 映射对象是独立产物，不在 process.env 里
    assert.strictEqual(process.env.AGENT_SYSTEM_PROMPT, undefined, 'AGENT_SYSTEM_PROMPT 未泄漏进 process.env');
});
// 5. 默认零副作用：空合并 → 空 env；未映射 type 不进 env
check('envInject: 空合并→空 env；自定义映射外 type 不注', () => {
    assert.deepStrictEqual(M.envInject({ specVersion: '1.0.0', entries: [] }), {});
    const cfg = M.envInject({ specVersion: '1.0.0', entries: [
        { id: 'x', type: 'note', key: 'k', value: 'hi', tags: [], source: 's', createdAt: 't', updatedAt: 't', specVersion: '1.0.0' }]},
        { envMap: {} });
    assert.deepStrictEqual(cfg, {}, '空 envMap → 无任何 type 被投影');
});
// 6. 多同类按 updatedAt 倒序并入 + 截断
check('envInject: 多同类倒序 + 超长截断', () => {
    const merged = { specVersion: '1.0.0', entries: [
         { id: 'n1', type: 'note', key: 'a', value: 'new', tags: [], source: 's', createdAt: 't', updatedAt: '2026-09-15T00:00:00Z', specVersion: '1.0.0' },
         { id: 'n2', type: 'note', key: 'b', value: 'old', tags: [], source: 's', createdAt: 't', updatedAt: '2026-09-01T00:00:00Z', specVersion: '1.0.0' },
     ]};
    const env = M.envInject(merged);                      // 默认不截断：两条都进倒序 JSON，new 在前
    assert.ok(env.AGENT_MEMORY_CONTEXT.includes('new') && env.AGENT_MEMORY_CONTEXT.includes('old'));
    const order = env.AGENT_MEMORY_CONTEXT;
    assert.ok(order.indexOf('n1') < order.indexOf('n2'), '按 updatedAt 倒序：new(n1) 在 old(n2) 前');
    const truncated = M.envInject(merged, { contextMaxLen: 20 });
    assert.ok(truncated.AGENT_MEMORY_CONTEXT.includes('…[truncated]'), '超长被截断');
});
// 7. json 适配器规范往返
check('adapter json: toDoc/fromDoc 往返无损', () => {
    const a = M.getAdapters().json;
    const doc = a.toDoc(shared);
    const back = a.fromDoc(doc);
    assert.strictEqual(back.entries.length, shared.entries.length);
    assert.strictEqual(back.entries[0].id, shared.entries[0].id);
});
// 8. yaml-text 适配器往返（纯文本、零依赖）
check('adapter yaml: 文本往返取回 entries', () => {
    const a = M.getAdapters().yaml;
    const text = a.toDoc(shared);
    assert.ok(text.includes('id: mem-etimedout-no-proxy'));
    const back = a.fromDoc(text);
    assert.strictEqual(back.entries.length, 2, '文本往返取回 2 条');
});
// 9. 热插拔新适配器
check('registerAdapter: 热插拔新方案', () => {
    M.registerAdapter('csv-text', {
        name: 'csv-text',
        toDoc: (r) => (Array.isArray(r) ? r : r.entries).map(e => [e.id, e.key, e.value].join(',')).join('\n'),
        fromDoc: (t) => String(t).split('\n').filter(Boolean).map(line => {
            const [id, key, value] = line.split(',');
            return { id, key, value };
        }),
    });
    const out = M.getAdapters()['csv-text'].toDoc(shared);
    assert.ok(out.includes('mem-etimedout-no-proxy'));
    assert.strictEqual(M.getAdapters()['csv-text'].fromDoc(out).length, 2);
});
// 10. validateMemoryDoc
check('validateMemoryDoc: 接好 doc / 拒坏 doc', () => {
    assert.strictEqual(M.validateMemoryDoc(shared).valid, true);
    assert.strictEqual(M.validateMemoryDoc({ specVersion: '9.9.9', entries: [] }).valid, false, 'specVersion 错被拒');
    assert.strictEqual(M.validateMemoryDoc({ entries: [] }).valid, false, '缺 specVersion 被拒');
    const missing = M.validateMemoryDoc({ specVersion: '1.0.0', entries: [{ id: 'x' }] });
    assert.strictEqual(missing.valid, false, 'entry 缺 key 被拒');
});
// 11. 非侵入终极证明：整个 demo 跑完，内核产出的 5 个 AGENT_* env 键无一泄漏进 process.env
check('整库非侵入：内核 AGENT_* env 键全程未泄漏进 process.env', () => {
    const kernelKeys = ['AGENT_SYSTEM_PROMPT', 'AGENT_ERROR_PATTERNS', 'AGENT_TOOLS_ALLOWED', 'AGENT_CONFIG', 'AGENT_MEMORY_CONTEXT'];
    const leaked = kernelKeys.filter(k => process.env[k] !== undefined);
    assert.strictEqual(leaked.length, 0, `内核 env 键不应泄漏，实得 ${leaked.join(',')}`);
});

console.log(`\n[Memory-Merge demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
