'use strict';

// 回归测试：sessions 路由在未通过 setStore 注入 store 时，
// getStore() 必须 lazy 实例化真实 SessionStore（new），而非把模块本身当 store。
// 历史上 getStore() 做 require('../lib/session-store') 但漏了 new，
// 导致线上 /api/sessions/* 全 400/500（create/list 不是函数）。
// 本用例不注入 mock store，直接走真实 lazy 路径。

const os = require('os');
const path = require('path');
const fs = require('fs');
const request = require('supertest');
const express = require('express');

// 把持久化目录指到 tmp，避免污染真实 ~/.multi-proxy-manager/sessions.json
// 必须在首次触发 getStore()（内部 require session-store）之前设置 HOME，
// 因为 DEFAULT_DIR 在 session-store.js 模块加载时按 process.env.HOME 捕获。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-lazy-'));
process.env.HOME = tmpDir;

const app = express();
app.use(express.json());
// 关键：不调用 app 上路由的 setStore —— 走真实 lazy 路径
app.use('/api/sessions', require('../../routes/sessions'));

afterEach(() => {
    // 清理 tmp，避免跨用例累积
    try {
        const f = path.join(tmpDir, '.multi-proxy-manager', 'sessions.json');
        if (fs.existsSync(f)) fs.unlinkSync(f);
     } catch (e) { /* ignore */ }
});

describe('Sessions API — lazy store 实例化（回归 getStore() 漏 new 的 bug）', () => {
    test('GET /api/sessions 在未注入 store 时返回 200 空列表（而非 500 create/list 缺失）', async () => {
        const res = await request(app).get('/api/sessions');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.sessions).toEqual([]);
     });

    test('POST /api/sessions 在未注入 store 时创建成功（201，非 400/500）', async () => {
        const res = await request(app)
            .post('/api/sessions')
            .send({ proxy: 'codex', task: { type: 'coding', prompt: 'regression' } });
        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);
        expect(res.body.session.sessionId).toBeTruthy();
        // 持久化落盘确认
        const listRes = await request(app).get('/api/sessions');
        expect(listRes.body.count).toBeGreaterThan(0);
     });

    test('完整状态机：create -> abort -> resume -> delete（真实 store）', async () => {
        const createRes = await request(app)
            .post('/api/sessions')
            .send({ proxy: 'hermes', task: { type: 'coding' } });
        expect(createRes.status).toBe(201);
        const id = createRes.body.session.sessionId;

        // abort: running -> aborted
        const abortRes = await request(app)
            .post(`/api/sessions/${id}/abort`)
            .send({ by: 'user' });
        expect(abortRes.status).toBe(200);
        expect(abortRes.body.session.status).toBe('aborted');

        // resume: aborted -> running
        const resumeRes = await request(app).post(`/api/sessions/${id}/resume`);
        expect(resumeRes.status).toBe(200);
        expect(resumeRes.body.session.status).toBe('running');
        expect(resumeRes.body.session.resumedAt).toBeTruthy();

        // delete
        const delRes = await request(app).delete(`/api/sessions/${id}`);
        expect(delRes.status).toBe(200);
        const after = await request(app).get(`/api/sessions/${id}`);
        expect(after.status).toBe(404);
     });
});
