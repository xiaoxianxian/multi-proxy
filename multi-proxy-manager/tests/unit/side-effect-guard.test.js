// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// jest test for SideEffectGuard（B 类副作用故障端到端链路）
const fs = require('fs');
const { SideEffectGuard } = require('../../lib/side-effect-guard');
const { ActionAudit } = require('../../lib/action-audit');
const { SessionStore } = require('../../lib/session-store');

describe('SideEffectGuard', () => {
    let tmpDir;
    let audit;
    let guard;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync('/tmp/side-effect-guard-');
        audit = new ActionAudit({ dir: tmpDir, enabled: true });
        guard = new SideEffectGuard({ audit, enabled: true, manualDeadlineMs: 1000 });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ---------- 门控 ----------

    test('disabled by default does not intervene', () => {
        const off = new SideEffectGuard({ audit }); // enabled 未传且无 env
        expect(off.enabled).toBe(false);
        expect(off.beforeAction({ toolName: 'edit' }).reason).toBe('guard-disabled');
    });

    // ---------- ① 权限门禁 ----------

    test('blocks action denied by gate', () => {
        const g = new SideEffectGuard({
            audit, enabled: true,
            gate: (tool) => ({ blocked: tool === 'delete', reason: 'blocked:deny' }),
        });
        const r = g.beforeAction({ toolName: 'delete', idempotencyKey: 'k1' });
        expect(r.proceed).toBe(false);
        expect(r.reason).toBe('blocked-by-gate');
    });

    test('allows action permitted by gate and records proposed', () => {
        const g = new SideEffectGuard({
            audit, enabled: true,
            gate: (tool) => ({ blocked: tool === 'delete' }),
        });
        const r = g.beforeAction({ toolName: 'edit', idempotencyKey: 'k-allow' });
        expect(r.proceed).toBe(true);
        const h = audit.queryByIdempotencyKey('k-allow');
        expect(h).toHaveLength(1);
        expect(h[0].result).toBe('proposed');
    });

    // ---------- ② 幂等：已完成的跳过 ----------

    test('skips action already completed (no duplicate side effect)', () => {
        guard.beforeAction({ toolName: 'edit', idempotencyKey: 'k-dup' });
        guard.recordResult({ idempotencyKey: 'k-dup', result: 'completed', sourceOfTruth: 'source-system' });

        const again = guard.beforeAction({ toolName: 'edit', idempotencyKey: 'k-dup' });
        expect(again.proceed).toBe(false);
        expect(again.reason).toBe('already-completed');
    });

    test('does not skip when only proposed (never confirmed)', () => {
        guard.beforeAction({ toolName: 'edit', idempotencyKey: 'k-prop' });
        const again = guard.beforeAction({ toolName: 'edit', idempotencyKey: 'k-prop' });
        expect(again.proceed).toBe(true); // proposed 不算完成，放行重试路径（最终由 reconcile 裁决）
    });

    // ---------- ③ 对账决策 ----------

    test('reconcile: completed -> skip', () => {
        audit.record({ idempotencyKey: 'k1', result: 'proposed' });
        audit.record({ idempotencyKey: 'k1', result: 'completed' });
        const r = guard.reconcile('k1');
        expect(r.decision).toBe('skip');
        expect(r.reason).toBe('already-completed');
    });

    test('reconcile: explicit failure -> retry', () => {
        audit.record({ idempotencyKey: 'k2', result: 'failed' });
        const r = guard.reconcile('k2');
        expect(r.decision).toBe('retry');
        expect(r.reason).toBe('explicit-failure');
    });

    // 🔴 本模块存在的核心理由
    test('reconcile: unknown NEVER auto-retries (within deadline)', () => {
        audit.record({ idempotencyKey: 'k3', result: 'unknown' });
        const r = guard.reconcile('k3', { now: Date.now() });
        expect(r.decision).not.toBe('retry');
        expect(r.decision).toBe('manual');
        expect(r.reason).toBe('unknown-awaiting-reconciliation');
    });

    test('reconcile: unknown past deadline -> manual (do not wait forever)', () => {
        audit.record({ idempotencyKey: 'k4', result: 'unknown' });
        const later = Date.now() + 5000; // 超过 manualDeadlineMs=1000
        const r = guard.reconcile('k4', { now: later });
        expect(r.decision).toBe('manual');
        expect(r.reason).toBe('unknown-past-deadline');
    });

    test('reconcile: accepted but not confirmed -> manual (receipt is not completion)', () => {
        audit.record({ idempotencyKey: 'k5', result: 'accepted' });
        const r = guard.reconcile('k5');
        expect(r.decision).toBe('manual');
        expect(r.reason).toBe('accepted-not-confirmed');
    });

    test('reconcile: no history -> manual (no ledger evidence)', () => {
        const r = guard.reconcile('never-seen');
        expect(r.decision).toBe('manual');
        expect(r.reason).toBe('no-history');
    });

    // ---------- 崩溃后队列 ----------

    test('pendingReconciliation lists unknown actions, deduped by key', () => {
        audit.record({ idempotencyKey: 'a', result: 'unknown' });
        audit.record({ idempotencyKey: 'a', result: 'unknown' });
        audit.record({ idempotencyKey: 'b', result: 'completed' });
        audit.record({ idempotencyKey: 'c', result: 'unknown' });
        const pending = guard.pendingReconciliation();
        expect(pending).toHaveLength(2);
        expect(pending.map((e) => e.idempotencyKey).sort()).toEqual(['a', 'c']);
    });

    // ---------- 端到端：完整链路 ----------

    test('end-to-end: propose -> accepted -> reconcile says manual -> confirm completed -> skip', () => {
        const key = 'e2e-order-1';
        // 1. 执行前放行
        const before = guard.beforeAction({ toolName: 'update:order', idempotencyKey: key, actor: 'agent:1', resource: 'order:1@v7' });
        expect(before.proceed).toBe(true);
        // 2. 业务只回了受理回执（不是完成）
        guard.recordResult({ idempotencyKey: key, result: 'accepted', sourceOfTruth: 'gateway-receipt' });
        // 3. 此时对账：不能重试也不能算完成
        expect(guard.reconcile(key).decision).toBe('manual');
        // 4. 源系统确认完成
        guard.recordResult({ idempotencyKey: key, result: 'completed', sourceOfTruth: 'source-system' });
        // 5. 之后任何重复触发都跳过
        expect(guard.reconcile(key).decision).toBe('skip');
        expect(guard.beforeAction({ toolName: 'update:order', idempotencyKey: key }).reason).toBe('already-completed');
        // 6. 审计留痕完整：proposed -> accepted -> completed
        expect(audit.queryByIdempotencyKey(key).map((e) => e.result))
            .toEqual(['proposed', 'accepted', 'completed']);
    });

    test('end-to-end: crash mid-flight leaves unknown, never silently retried', () => {
        const key = 'e2e-crash';
        guard.beforeAction({ toolName: 'refund', idempotencyKey: key });
        // 进程崩了，没记任何结果 → 补一条 unknown（代表「不知道成没成」）
        guard.recordResult({ idempotencyKey: key, result: 'unknown' });
        expect(guard.pendingReconciliation()).toHaveLength(1);
        const r = guard.reconcile(key);
        expect(r.decision).toBe('manual'); // 🔴 绝不是 retry
    });
});
