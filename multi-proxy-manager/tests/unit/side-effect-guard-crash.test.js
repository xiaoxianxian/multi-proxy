'use strict';

// 真实崩溃恢复演练 —— 不用 mock 模拟崩溃，而是真的 fork 一个子进程并 SIGKILL 它。
//
// 与既有 crash-recovery.test.js 的分工：
//   那个测的是**日志系统**（appendLog + rotation，且是重新实现一遍逻辑来验证）；
//   这个测的是**业务动作账本**在真进程猝死下的存活 + 事后对账决策。两回事。
//
// 演练的是原文那张图最要命的一格：
//   副作用已发出、结果还没回来、进程死了 —— 重启后到底该不该重做？
//   答案：不该。没有终态 = 不知道成没成 = 必须先查源系统（manual），绝不能 retry。

const { fork } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { ActionAudit } = require('../../lib/action-audit');
const { SessionStore } = require('../../lib/session-store');
const { SideEffectGuard } = require('../../lib/side-effect-guard');

const CHILD = path.join(__dirname, '..', 'fixtures', 'crash-child.js');

let tmpDir;
let key;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-drill-'));
    key = `drill-${Date.now()}`;
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// 跑子进程并等它被杀死
function runCrashChild() {
    return new Promise((resolve, reject) => {
        const child = fork(CHILD, [], {
            env: { ...process.env, CRASH_DIR: tmpDir, CRASH_KEY: key, CRASH_SESSION: 'crash-s1' },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('child timeout')); }, 15000);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

describe('真实崩溃恢复演练（SIGKILL，非 mock）', () => {
    test('子进程确实是被 SIGKILL 杀死的（不是正常退出）', async () => {
        const { code, signal } = await runCrashChild();
        expect(signal).toBe('SIGKILL');
        expect(code).toBeNull();
    }, 20000);

    test('猝死后账本存活：只剩 proposed，没有任何终态', async () => {
        await runCrashChild();
        // 重启视角：全新实例，只读同一目录
        const audit = new ActionAudit({ dir: tmpDir, enabled: true });
        const history = audit.queryByIdempotencyKey(key);
        expect(history.length).toBeGreaterThan(0);
        const results = history.map((e) => e.result);
        expect(results).toContain('proposed');
        // 关键：没有 completed / failed —— 正因如此才不许自动重试
        expect(results).not.toContain('completed');
        expect(results).not.toContain('failed');
    }, 20000);

    test('🔴 崩溃后对账：manual，绝不是 retry', async () => {
        await runCrashChild();
        const audit = new ActionAudit({ dir: tmpDir, enabled: true });
        const guard = new SideEffectGuard({ audit, enabled: true });

        const verdict = guard.reconcile(key);
        expect(verdict.decision).toBe('manual');
        expect(verdict.decision).not.toBe('retry');
        expect(verdict.reason).toBe('unresolved-state');
    }, 20000);

    test('崩溃后待对账队列能列出它（重启后知道有笔烂账）', async () => {
        await runCrashChild();
        const audit = new ActionAudit({ dir: tmpDir, enabled: true });
        const guard = new SideEffectGuard({ audit, enabled: true });
        const pending = guard.pendingReconciliation();
        expect(pending.length).toBe(1);
        expect(pending[0].idempotencyKey).toBe(key);
        expect(pending[0].result).toBe('proposed');
    }, 20000);

    test('人工查源系统确认完成后 → 决策翻转为 skip，且不再进待办', async () => {
        await runCrashChild();
        const audit = new ActionAudit({ dir: tmpDir, enabled: true });
        const guard = new SideEffectGuard({ audit, enabled: true });

        expect(guard.reconcile(key).decision).toBe('manual');

        // 查源系统：确认这个动作其实已经成了
        guard.recordResult({
            idempotencyKey: key, result: 'completed',
            action: 'edit', sourceOfTruth: 'source-system',
            meta: { confirmedBy: 'human-drill' },
        });

        expect(guard.reconcile(key).decision).toBe('skip');
        expect(guard.pendingReconciliation()).toHaveLength(0);
    }, 20000);

    test('session 幂等键跨进程存活：重启后 replayStep 查得回来', async () => {
        await runCrashChild();
        // 新进程视角：sessions.json 是原子写（tmp→rename），猝死不该丢
        const store = new SessionStore({ dir: tmpDir });
        const step = store.replayStep('crash-s1', key);
        expect(step).toBeTruthy();
        expect(step.idempotencyKey || step.idempotency_key).toBe(key);
    }, 20000);
});
