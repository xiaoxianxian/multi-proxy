'use strict';

// L2 P1.1a 记忆服务内核单测：merge + 冲突策略 + 非侵入 envInject + 可热插拔适配器。
// 纪律：全默认零网络零文件零 LLM。envInject 永不写 process.env / 不碰 agent 文件（§5.2 非侵入）。
const M = require('../../../l2/memory-merge.js');

const E = (o) => Object.assign({
    id: 'e', type: 'note', scope: 'shared', key: 'k', value: 'v',
    tags: [], source: 's', createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z', specVersion: '1.0.0',
}, o);
const shared = {
    specVersion: '1.0.0',
    entries: [
        E({ id: 'mem-pref', type: 'preference', key: 'response-language', value: '简体中文', updatedAt: '2026-09-01T00:00:00Z' }),
        E({ id: 'mem-ep', type: 'error-pattern', key: 'etimedout', value: 'NO_PROXY 裸 *', updatedAt: '2026-09-01T00:00:00Z' }),
    ],
};
const personal = {
    specVersion: '1.0.0',
    entries: [
        E({ id: 'mem-pref-p', type: 'preference', scope: 'codex', key: 'response-language', value: '称老板', updatedAt: '2026-09-10T00:00:00Z' }),
    ],
};

describe('P1.1a memory-merge · merge', () => {
    test('默认个性覆盖公共（同 key）', () => {
        const m = M.merge(shared, personal);
        const pref = m.entries.find((e) => e.key === 'response-language');
        expect(pref.scope).toBe('codex');
        expect(pref.value).toBe('称老板');
        expect(m.meta.total).toBe(2);
      });
    test('strategy=error 记录冲突、不静默覆盖', () => {
        const m = M.merge(shared, personal, { strategy: 'error' });
        expect(m.meta.conflicts.length).toBeGreaterThanOrEqual(1);
        expect(m.meta.conflicts.some((c) => c.key === 'response-language')).toBe(true);
      });
    test('strategy=shared 公共胜出', () => {
        const m = M.merge(shared, personal, { strategy: 'shared' });
        const pref = m.entries.find((e) => e.key === 'response-language');
        expect(pref.value).toBe('简体中文');
      });
    test('裸数组当 entries；非法 entry 被过滤', () => {
        const m = M.merge([{ id: 'good', type: 'note', key: 'ok', value: 1, tags: [], source: 's', createdAt: 't', updatedAt: 't', specVersion: '1.0.0' }], [{ bogus: true }]);
        expect(m.meta.total).toBe(1);
        expect(m.entries[0].id).toBe('good');
      });
});

describe('P1.1a memory-merge · envInject 非侵入（§5.2）', () => {
    test('产出映射含三类目标变量，且不写 process.env', () => {
        const env = M.envInject(M.merge(shared, personal));
        expect(env).toHaveProperty('AGENT_SYSTEM_PROMPT');
        expect(env).toHaveProperty('AGENT_ERROR_PATTERNS');
        expect(env).not.toHaveProperty('AGENT_TOOLS_ALLOWED'); // 样例无 template 类
        // 关键：内核绝不泄漏进 process.env
        expect(process.env.AGENT_SYSTEM_PROMPT).toBeUndefined();
        expect(process.env.AGENT_ERROR_PATTERNS).toBeUndefined();
      });
    test('多类目标各自独立（不串扰）', () => {
        const env = M.envInject(M.merge(shared, personal));
        expect(env.AGENT_SYSTEM_PROMPT).toContain('称老板');
        expect(env.AGENT_ERROR_PATTERNS).toContain('NO_PROXY');
        expect(env.AGENT_SYSTEM_PROMPT).not.toContain('NO_PROXY');
      });
    test('空合并 → 空 env；空 envMap → 不投影任何 type', () => {
        expect(M.envInject({ specVersion: '1.0.0', entries: [] })).toEqual({});
        expect(M.envInject(M.merge(shared, personal), { envMap: {} })).toEqual({});
      });
    test('自定义 envMap 改变投影目标', () => {
        const env = M.envInject(M.merge(shared, personal), { envMap: { preference: 'MY_PROMPT' } });
        expect(env).toHaveProperty('MY_PROMPT');
        expect(env).not.toHaveProperty('AGENT_SYSTEM_PROMPT');
      });
    test('多同类倒序 + 超长截断', () => {
        const merged = {
            specVersion: '1.0.0',
            entries: [
                E({ id: 'n1', key: 'n1', value: 'new', updatedAt: '2026-09-15T00:00:00Z' }),
                E({ id: 'n2', key: 'n2', value: 'old', updatedAt: '2026-09-01T00:00:00Z' }),
            ],
        };
        const full = M.envInject(merged);
        expect(full.AGENT_MEMORY_CONTEXT.indexOf('n1')).toBeLessThan(full.AGENT_MEMORY_CONTEXT.indexOf('n2'));
        const truncated = M.envInject(merged, { contextMaxLen: 8 });
        expect(truncated.AGENT_MEMORY_CONTEXT).toContain('…[truncated]');
      });
    test('env 基线：传入 env 上追加而非覆盖未列键', () => {
        const env = M.envInject(M.merge(shared, personal), { env: { PRESET: '1' } });
        expect(env.PRESET).toBe('1');
        expect(env).toHaveProperty('AGENT_SYSTEM_PROMPT');
      });
});

describe('P1.1a memory-merge · 适配器可热插拔（§4.8）', () => {
    test('json 适配器规范往返', () => {
        const a = M.getAdapters().json;
        const doc = a.toDoc(shared);
        expect(a.fromDoc(doc).entries.length).toBe(2);
      });
    test('yaml 文本适配器往返取回条目', () => {
        const a = M.getAdapters().yaml;
        const text = a.toDoc(shared);
        expect(text).toContain('id: mem-pref');
        expect(a.fromDoc(text).entries.length).toBe(2);
      });
    test('registerAdapter 热插拔新方案 + 校验参数', () => {
        expect(() => M.registerAdapter('csv-text', { toDoc: () => '' })).toThrow();
        M.registerAdapter('csv-text', {
            name: 'csv-text',
            toDoc: (r) => (Array.isArray(r) ? r : r.entries).map((e) => [e.id, e.key, e.value].join(',')).join('\n'),
            fromDoc: (t) => String(t).split('\n').filter(Boolean).map((l) => {
                const [id, key, value] = l.split(',');
                return { id, key, value };
              }),
        });
        const out = M.getAdapters()['csv-text'].toDoc(shared);
        expect(out).toContain('mem-pref');
        expect(M.getAdapters()['csv-text'].fromDoc(out).length).toBe(2);
      });
});

describe('P1.1a memory-merge · 规范校验', () => {
    test('接好 doc / 拒坏 doc', () => {
        expect(M.validateMemoryDoc(shared).valid).toBe(true);
        expect(M.validateMemoryDoc({ specVersion: '9.9.9', entries: [] }).valid).toBe(false);
        expect(M.validateMemoryDoc({ entries: [] }).valid).toBe(false);
    });
});
