// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 P3 接线测试：/api/skill-service 门控 + 单例 + CRUD + 4xx 转码 + 门控关零副作用。
// 镜像 tests/unit/orchestration-route.test.js 的 supertest + supertest gate 模式。
// 非侵入：门控默认关 → 403 零副作用；门控开 → 读写内存态 skill service，不触碰任何 agent 文件。

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('L2 P3 skill-service route (/api/skill-service)', () => {
    let app;
    const ROUTE = '../../routes/skill-service';
    const base = { name: 'lark-shared', trigger: 'setup', description: 'd', content: 'c', tags: ['auth'] };

    const build = () => {
        delete require.cache[require.resolve(ROUTE)];
        app = express();
        app.use(express.json());
        const r = require(ROUTE);
        r._resetForTest && r._resetForTest();
        app.use('/api/skill-service', r);
        return app;
    };

    beforeEach(() => {
        delete process.env.PROXY_L2_SKILL;
    });

    afterEach(() => {
        delete process.env.PROXY_L2_SKILL;
        delete process.env.L2_SKILL_DIR;
    });

    test('门控关(默认)：GET + POST 均 403 零副作用', async () => {
        build();
        const g = await request(app).get('/api/skill-service');
        expect(g.status).toBe(403);
        expect(g.body.error).toBe('skill-service-gate-closed');
        const p = await request(app)
            .post('/api/skill-service')
            .send(base);
        expect(p.status).toBe(403);
   });

    test('门控开 + POST create -> 201，version 1.0.0；GET / 命中；GET /:name 命中', async () => {
        process.env.PROXY_L2_SKILL = '1';
        build();
        const c = await request(app)
            .post('/api/skill-service')
            .send(base);
        expect(c.status).toBe(201);
        expect(c.body.version).toBe('1.0.0');
        expect(c.body.name).toBe('lark-shared');

        const g = await request(app).get('/api/skill-service');
        expect(g.status).toBe(200);
        expect(g.body.length).toBeGreaterThanOrEqual(1);

        const key = await request(app).get('/api/skill-service/lark-shared');
        expect(key.status).toBe(200);
        expect(key.body.version).toBe('1.0.0');
     });

    test('门控开 + update 原地自动 bump 到 1.0.1；再 bump 到 1.0.2；rollback 翻回 1.0.1', async () => {
        process.env.PROXY_L2_SKILL = '1';
        build();
        await request(app)
              .post('/api/skill-service')
              .send(base);
        const u = await request(app)
              .put('/api/skill-service/lark-shared')
              .send({ description: 'updated' });
        expect(u.status).toBe(200);
        expect(u.body.version).toBe('1.0.1');
        expect(u.body.description).toBe('updated');

        const b1 = await request(app).post('/api/skill-service/lark-shared/bump').send({});
        expect(b1.status).toBe(200);
        expect(b1.body.version).toBe('1.0.2');
        expect(b1.body.enabled).toBe(true);

        const rb = await request(app)
             .post('/api/skill-service/lark-shared/rollback')
             .send({ targetVersion: '1.0.1' });
        expect(rb.status).toBe(200);
        expect(rb.body.version).toBe('1.0.1');
        expect(rb.body.enabled).toBe(true);
        });

    test('门控开 + 非法 create(缺字段) -> 400 不冒泡', async () => {
        process.env.PROXY_L2_SKILL = '1';
        build();
        const p = await request(app)
            .post('/api/skill-service')
            .send({ name: 'only-name' });
        expect(p.status).toBe(400);
        expect(p.body.error).toBe('skill-service-create-failed');
     });

    test('门控开 + GET 不存在的 key -> 404', async () => {
        process.env.PROXY_L2_SKILL = '1';
        build();
        const g = await request(app).get('/api/skill-service/ghost');
        expect(g.status).toBe(404);
        expect(g.body.error).toBe('skill-not-found');
     });

    test('门控开 + 单例长寿命：reset 后状态清空', async () => {
        process.env.PROXY_L2_SKILL = '1';
        build();
        await request(app)
            .post('/api/skill-service')
            .send(base);
        const r = require(ROUTE);
        r._resetForTest();
        const g = await request(app).get('/api/skill-service');
        expect(g.body.length).toBe(0);
     });

    test('P3 持久化：设 L2_SKILL_DIR 才落盘，重建单例从文件读回', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-route-'));
        process.env.PROXY_L2_SKILL = '1';
        process.env.L2_SKILL_DIR = dir;
        build();
        await request(app)
            .post('/api/skill-service')
            .send(base);
        expect(fs.existsSync(path.join(dir, 'skills.json'))).toBe(true);

        build();                                  // 重建单例 = 模拟进程重启
        const g = await request(app).get('/api/skill-service');
        expect(g.status).toBe(200);
        expect(g.body.length).toBe(1);            // 不是从空内存开始，磁盘生效
    });

    test('未设 L2_SKILL_DIR = 纯内存：不产生任何文件', async () => {
        const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-route-mem-'));
        const cwd = process.cwd();
        process.chdir(probe);
        process.env.PROXY_L2_SKILL = '1';
        build();
        try {
            await request(app)
                .post('/api/skill-service')
                .send(base);
            expect(fs.readdirSync(probe).length).toBe(0);
        } finally {
            process.chdir(cwd);
        }
    });
});
