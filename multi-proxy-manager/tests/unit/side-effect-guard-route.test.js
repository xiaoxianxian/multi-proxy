// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// 必须在 require action-audit 实例化前设好（ActionAudit.enabled 构造时读 env）
process.env.MULTI_PROXY_ACTION_AUDIT = '1';

const request = require('supertest');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = require('../../routes/side-effect-guard');
const { SideEffectGuard } = require('../../lib/side-effect-guard');
const { ActionAudit } = require('../../lib/action-audit');
const { SessionStore } = require('../../lib/session-store');

const TEST_DIR = path.join(os.tmpdir(), 'seg-route-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

function makeGuard(enabled) {
    return new SideEffectGuard({
        audit: new ActionAudit({ dir: TEST_DIR }),
        store: new SessionStore({ dir: TEST_DIR }),
        gate: null,
        enabled,
    });
}

const app = express();
app.use(express.json());
app.use('/api/guard', router);

afterAll(() => { fs.rmSync(TEST_DIR, { recursive: true, force: true }); });

describe('side-effect-guard business route (enabled)', () => {
    beforeAll(() => { router.setGuard(makeGuard(true)); });

    const KEY = 'test-output:row-1';

    test('before-action proceeds when no history', async () => {
        const r = await request(app).post('/api/guard/before-action')
            .send({ action: 'submit', idempotencyKey: KEY, actor: 't', resource: 'test-output' });
        expect(r.body.proceed).toBe(true);
        expect(r.body.reason).toBe('ok');
    });

    test('record-result marks completed', async () => {
        const r = await request(app).post('/api/guard/record-result')
            .send({ idempotencyKey: KEY, result: 'completed', action: 'submit', resource: 'test-output' });
        expect(r.body.ok).toBe(true);
    });

    test('before-action skips when already completed', async () => {
        const r = await request(app).post('/api/guard/before-action')
            .send({ action: 'submit', idempotencyKey: KEY, actor: 't', resource: 'test-output' });
        expect(r.body.proceed).toBe(false);
        expect(r.body.reason).toBe('already-completed');
    });

    test('reconcile returns skip for completed', async () => {
        const r = await request(app).post('/api/guard/reconcile').send({ idempotencyKey: KEY });
        expect(r.body.decision).toBe('skip');
    });

    test('pending empty after resolved', async () => {
        const r = await request(app).get('/api/guard/reconcile/pending');
        expect(r.body.items).toHaveLength(0);
    });

    test('pending lists unresolved proposed orphan → reconcile manual', async () => {
        const k2 = 'test-output:row-2';
        await request(app).post('/api/guard/before-action')
            .send({ action: 'submit', idempotencyKey: k2, actor: 't', resource: 'test-output' });
        const pending = await request(app).get('/api/guard/reconcile/pending');
        expect(pending.body.items.some((e) => e.idempotencyKey === k2)).toBe(true);
        const rec = await request(app).post('/api/guard/reconcile').send({ idempotencyKey: k2 });
        expect(rec.body.decision).toBe('manual'); // proposed orphan → 不自动重试
    });
});

describe('side-effect-guard business route (disabled)', () => {
    afterAll(() => { router.setGuard(makeGuard(true)); }); // 复位，不影响别的用例
    test('before-action returns guard-disabled (zero intervention)', async () => {
        router.setGuard(makeGuard(false));
        const r = await request(app).post('/api/guard/before-action')
            .send({ action: 'submit', idempotencyKey: 'x', actor: 't', resource: 'r' });
        expect(r.body.proceed).toBe(false);
        expect(r.body.reason).toBe('guard-disabled');
    });
    test('record-result no-op when disabled', async () => {
        const r = await request(app).post('/api/guard/record-result')
            .send({ idempotencyKey: 'x', result: 'completed' });
        expect(r.body.skipped).toBe('guard-disabled');
    });
});
