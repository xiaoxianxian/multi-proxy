'use strict';

// Sessions 路由 × B 类副作用故障链路接线测试
//
// 钉死两条：
//   ① 门控关 → 零行为变更（跟没接这个模块时一模一样）
//   ② unknown 的对账决策永远是 manual，绝不是 retry（本链路存在的全部理由）
//
// 另钉一条工程事实：/reconcile* 路由必须排在 /:id 之前，否则被通配吃掉。
// （测试 8 的 count 断言隐含覆盖：若被吃掉会走到 GET /:id 返回 session=null）

const request = require('supertest');
const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');

const router = require('../../routes/sessions');
const { SessionStore } = require('../../lib/session-store');
const { ActionAudit } = require('../../lib/action-audit');
const { SideEffectGuard } = require('../../lib/side-effect-guard');

let tmpDir;

function buildApp({ guardEnabled = false, gate = null } = {}) {
    const store = new SessionStore({ dir: tmpDir });
    const audit = new ActionAudit({ dir: tmpDir, enabled: true });
    const guard = new SideEffectGuard({ audit, store, gate, enabled: guardEnabled });
    router.setStore(store);
    router.setGuard(guard);
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', router);
    return { app, store, audit, guard };
}

function seed(store) {
    return store.create({ sessionId: 's1', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-guard-'));
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('sessions 路由 × side-effect-guard', () => {
    test('门控关：step 行为完全不变（不加拦截、不查幂等、不记审计）', async () => {
        const { app, store, audit } = buildApp({ guardEnabled: false });
        seed(store);
        const r = await request(app).post('/api/sessions/s1/step')
            .send({ step: 1, tool: 'edit', status: 'done', idempotencyKey: 'k-off' });
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.skipped).toBeUndefined();
        expect(r.body.session.steps).toHaveLength(1);
        // 门控关时审计账本不该有任何东西
        expect(audit.queryByIdempotencyKey('k-off')).toHaveLength(0);
    });

    test('门控开：未授权工具 → 403 tool-not-permitted，且不落 step', async () => {
        const { app, store } = buildApp({
            guardEnabled: true,
            gate: (t) => ({ blocked: t === 'rm', reason: 'blocked:deny' }),
        });
        seed(store);
        const r = await request(app).post('/api/sessions/s1/step')
            .send({ step: 1, tool: 'rm', idempotencyKey: 'k-rm' });
        expect(r.status).toBe(403);
        expect(r.body.error).toBe('tool-not-permitted');
        expect(r.body.gateReason).toBe('blocked:deny');
        expect(store.get('s1').steps).toHaveLength(0);
    });

    test('门控开：幂等键已完成 → skipped，真的不重复执行', async () => {
        const { app, store, guard } = buildApp({ guardEnabled: true });
        seed(store);
        guard.recordResult({ idempotencyKey: 'k-done', result: 'completed', action: 'edit', sourceOfTruth: 'source-system' });
        const r = await request(app).post('/api/sessions/s1/step')
            .send({ step: 1, tool: 'edit', idempotencyKey: 'k-done' });
        expect(r.status).toBe(200);
        expect(r.body.skipped).toBe(true);
        expect(r.body.reason).toBe('already-completed');
        expect(r.body.existing).toBeTruthy();
        // 关键：session 里没新增 step —— 不是「记了一条然后照做」，是真的跳过了
        expect(store.get('s1').steps).toHaveLength(0);
    });

    test('门控开：放行 → addStep 成功，且账本留了 proposed', async () => {
        const { app, store, audit } = buildApp({ guardEnabled: true });
        seed(store);
        const r = await request(app).post('/api/sessions/s1/step')
            .send({ step: 1, tool: 'edit', idempotencyKey: 'k2', status: 'done' });
        expect(r.status).toBe(200);
        expect(r.body.session.steps).toHaveLength(1);
        const results = audit.queryByIdempotencyKey('k2').map((e) => e.result);
        expect(results).toContain('proposed');
    });

    test('门控开：body.result 补记终态（proposed → completed 账本完整）', async () => {
        const { app, store, audit } = buildApp({ guardEnabled: true });
        seed(store);
        await request(app).post('/api/sessions/s1/step')
            .send({ step: 1, tool: 'edit', idempotencyKey: 'k3', result: 'completed', sourceOfTruth: 'caller' });
        const results = audit.queryByIdempotencyKey('k3').map((e) => e.result);
        expect(results).toEqual(['proposed', 'completed']);

        // 此时再触发一次 → 已被识别为完成，跳过
        const r2 = await request(app).post('/api/sessions/s1/step')
            .send({ step: 2, tool: 'edit', idempotencyKey: 'k3' });
        expect(r2.body.skipped).toBe(true);
    });

    test('门控开：有 unknown → resume 拒绝盲继续（409），session 不被置回 running', async () => {
        const { app, store, guard } = buildApp({ guardEnabled: true });
        seed(store);
        store.markFailed('s1', new Error('crash'));
        guard.recordResult({ idempotencyKey: 'kx', result: 'unknown', action: 'edit', sourceOfTruth: 'unknown' });

        const r = await request(app).post('/api/sessions/s1/resume').send({});
        expect(r.status).toBe(409);
        expect(r.body.error).toBe('unreconciled-unknown-actions');
        expect(r.body.pending).toHaveLength(1);
        // 关键：没被置回 running —— 盲继续就是重复执行
        expect(store.get('s1').status).toBe('failed');
    });

    test('门控开：无 unknown → resume 正常放行', async () => {
        const { app, store } = buildApp({ guardEnabled: true });
        seed(store);
        store.markFailed('s1', new Error('crash'));
        const r = await request(app).post('/api/sessions/s1/resume').send({});
        expect(r.status).toBe(200);
        expect(store.get('s1').status).toBe('running');
    });

    test('门控关：resume 行为不变（即使账本里躺着 unknown）', async () => {
        const { app, store, guard } = buildApp({ guardEnabled: false });
        seed(store);
        store.markFailed('s1', new Error('crash'));
        guard.recordResult({ idempotencyKey: 'kx', result: 'unknown', action: 'edit', sourceOfTruth: 'unknown' });
        const r = await request(app).post('/api/sessions/s1/resume').send({});
        expect(r.status).toBe(200);
        expect(store.get('s1').status).toBe('running');
    });

    test('GET /reconcile/pending：待对账队列，按 key 去重', async () => {
        const { app, guard } = buildApp({ guardEnabled: true });
        guard.recordResult({ idempotencyKey: 'a', result: 'unknown', action: 'x', sourceOfTruth: 'unknown' });
        guard.recordResult({ idempotencyKey: 'a', result: 'unknown', action: 'x', sourceOfTruth: 'unknown' });
        guard.recordResult({ idempotencyKey: 'b', result: 'completed', action: 'x', sourceOfTruth: 's' });
        const r = await request(app).get('/api/sessions/reconcile/pending');
        expect(r.status).toBe(200);
        expect(r.body.count).toBe(1);
        expect(r.body.pending[0].idempotencyKey).toBe('a');
    });

    test('POST /reconcile：unknown → manual（🔴 绝不是 retry）', async () => {
        const { app, guard } = buildApp({ guardEnabled: true });
        guard.recordResult({ idempotencyKey: 'u1', result: 'unknown', action: 'edit', sourceOfTruth: 'unknown' });
        const r = await request(app).post('/api/sessions/reconcile').send({ idempotencyKey: 'u1' });
        expect(r.status).toBe(200);
        expect(r.body.decision).toBe('manual');
        expect(r.body.decision).not.toBe('retry');
        expect(r.body.history.length).toBeGreaterThan(0);
    });

    test('POST /reconcile：completed → skip，failed → retry', async () => {
        const { app, guard } = buildApp({ guardEnabled: true });
        guard.recordResult({ idempotencyKey: 'c1', result: 'completed', action: 'edit', sourceOfTruth: 's' });
        guard.recordResult({ idempotencyKey: 'f1', result: 'failed', action: 'edit', sourceOfTruth: 's' });

        const rc = await request(app).post('/api/sessions/reconcile').send({ idempotencyKey: 'c1' });
        expect(rc.body.decision).toBe('skip');

        const rf = await request(app).post('/api/sessions/reconcile').send({ idempotencyKey: 'f1' });
        expect(rf.body.decision).toBe('retry');
    });

    test('POST /reconcile：无历史 → manual（没有账本依据不敢自动重试）', async () => {
        const { app } = buildApp({ guardEnabled: true });
        const r = await request(app).post('/api/sessions/reconcile').send({ idempotencyKey: 'nope' });
        expect(r.body.decision).toBe('manual');
        expect(r.body.reason).toBe('no-history');
    });

    test('POST /reconcile：缺 idempotencyKey → 400', async () => {
        const { app } = buildApp({ guardEnabled: true });
        const r = await request(app).post('/api/sessions/reconcile').send({});
        expect(r.status).toBe(400);
    });
});
