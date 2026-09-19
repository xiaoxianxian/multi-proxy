'use strict';

// L2 P3 接线测试：/api/memory-merge 门控 + 合并/校验/投影 + 4xx 转码 + 门控关零副作用。
// 镜像 skill-service-route.test.js / orchestration-route.test.js 的 supertest + gate 模式。
// 内核无状态（merge/validateMemoryDoc/envInject 纯函数）→ 无单例；_resetForTest 为 no-op。

const express = require('express');
const request = require('supertest');

const E = (o) =>
    Object.assign(
       {
         id: 'e',
         type: 'note',
         scope: 'shared',
         key: 'k',
         value: 'v',
         tags: [],
         source: 's',
         createdAt: '2026-01-01T00:00:00Z',
         updatedAt: '2026-01-01T00:00:00Z',
         specVersion: '1.0.0',
       },
       o,
    );

const shared = {
    specVersion: '1.0.0',
    entries: [
        E({ id: 'mem-pref', type: 'preference', key: 'response-language', value: '简体中文' }),
    ],
};
const personal = {
    specVersion: '1.0.0',
    entries: [
        E({ id: 'mem-pref-p', type: 'preference', scope: 'codex', key: 'response-language', value: '称老板' }),
    ],
};

describe('L2 P3 memory-merge route (/api/memory-merge)', () => {
    let app;
    const ROUTE = '../../routes/memory-merge';
    const build = () => {
        delete require.cache[require.resolve(ROUTE)];
        app = express();
        app.use(express.json());
        const r = require(ROUTE);
        r._resetForTest && r._resetForTest();
        app.use('/api/memory-merge', r);
        return app;
    };

    beforeEach(() => {
        delete process.env.PROXY_L2_MEMORY;
    });
    afterEach(() => {
        delete process.env.PROXY_L2_MEMORY;
    });

    test('门控关(默认)：merge + validate 均 403 零副作用', async () => {
        build();
        const m = await request(app).post('/api/memory-merge/merge').send({ shared, personal });
        expect(m.status).toBe(403);
        expect(m.body.error).toBe('memory-merge-gate-closed');
        const v = await request(app).post('/api/memory-merge/validate').send({ doc: shared });
        expect(v.status).toBe(403);
    });

    test('门控开 + 默认合并：同 key 个性覆盖公共(DEFAULT_STRATEGY=personal，dedupe 为 1)', async () => {
        process.env.PROXY_L2_MEMORY = '1';
        build();
        const m = await request(app).post('/api/memory-merge/merge').send({ shared, personal });
        expect(m.status).toBe(200);
        const pref = m.body.entries.find((e) => e.key === 'response-language');
        expect(pref.value).toBe('称老板');
        expect(pref.scope).toBe('codex');
        expect(m.body.meta.total).toBe(1);
      });

    test('门控开 + strategy=error：记录冲突不静默覆盖', async () => {
        process.env.PROXY_L2_MEMORY = '1';
        build();
        const m = await request(app)
            .post('/api/memory-merge/merge')
            .send({ shared, personal, strategy: 'error' });
        expect(m.status).toBe(200);
        expect(m.body.meta.conflicts.length).toBeGreaterThanOrEqual(1);
        expect(m.body.meta.conflicts.some((c) => c.key === 'response-language')).toBe(true);
      });

    test('门控开 + validate 合法 doc -> 200 valid:true', async () => {
        process.env.PROXY_L2_MEMORY = '1';
        build();
        const v = await request(app).post('/api/memory-merge/validate').send({ doc: shared });
        expect(v.status).toBe(200);
        expect(v.body.valid).toBe(true);
    });

    test('门控开 + validate 非法 doc(缺 entries) -> 400 valid:false', async () => {
        process.env.PROXY_L2_MEMORY = '1';
        build();
        const v = await request(app)
            .post('/api/memory-merge/validate')
            .send({ doc: { specVersion: '1.0.0' } });
        expect(v.status).toBe(400);
        expect(v.body.valid).toBe(false);
    });

    test('门控开 + env-inject -> 200 返回分组投影', async () => {
        process.env.PROXY_L2_MEMORY = '1';
        build();
        const r = await request(app)
            .post('/api/memory-merge/env-inject')
            .send({ merged: shared });
        expect(r.status).toBe(200);
        expect(r.body).toBeDefined();
    });
});
