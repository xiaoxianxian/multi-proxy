'use strict';

// jest test for session-keepalive（M7 方向六 P3-c：session ↔ tmux 保活胶水）
// 真 SessionStore + 真 TmuxKeepalive（3.7c 已装）联调：bind / resume / 崩溃重建 / 无 checkpoint 报错。
const { SessionStore } = require('../../lib/session-store');
const { TmuxKeepalive } = require('../../lib/tmux-keepalive');
const { bindSessionKeepalive, resumeSessionKeepalive } = require('../../lib/session-keepalive');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

describe('session-keepalive（P3-c 胶水层）', () => {
    let store;
    let ka;
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync('/tmp/sk-');
        store = new SessionStore({ dir: tmpDir });
        ka = new TmuxKeepalive();
    });
    afterEach(() => {
        // 清真 tmux session + tmpDir
        for (const id of ['sk-bind', 'sk-resume', 'sk-restore', 'sk-nocp']) {
            spawnSync('tmux', ['kill-session', '-t', 'm7-' + id], { stdio: 'ignore' });
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('create session（前置: checkpoint=null, 不绑定时不受影响）', () => {
        const s = store.create({ sessionId: 'sk-null', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        expect(s.checkpoint).toBeNull();
    });

    it('bind: 起 tmux session 并写进 checkpoint', async () => {
        store.create({ sessionId: 'sk-bind', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        const r = await bindSessionKeepalive(store, ka, 'sk-bind', { cwd: tmpDir });
        expect(r.ok).toBe(true);
        expect(r.tmuxSession).toBe('m7-sk-bind');
        expect(r.checkpoint.boundAt).toMatch(/T/);
        // checkpoint 落进 session（经 store.update）
        expect(store.get('sk-bind').checkpoint.tmuxSession).toBe('m7-sk-bind');
        // tmux session 真在跑
        expect(await ka.isLive('sk-bind')).toBe(true);
    });

    it('bind 保留 prevCheckpoint 里已有的自定义字段', async () => {
        store.create({ sessionId: 'sk-bind', proxy: 'codex', task: { type: 'coding', prompt: 'x' },
            checkpoint: { idempotencyKey: 'ik-1', custom: 42 } });
        await bindSessionKeepalive(store, ka, 'sk-bind', { cwd: tmpDir });
        const cp = store.get('sk-bind').checkpoint;
        expect(cp.idempotencyKey).toBe('ik-1');
        expect(cp.custom).toBe(42);
        expect(cp.tmuxSession).toBe('m7-sk-bind');
    });

    it('resume: session 活着 → 返回 alive:true', async () => {
        store.create({ sessionId: 'sk-resume', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        await bindSessionKeepalive(store, ka, 'sk-resume', { cwd: tmpDir });
        const r = await resumeSessionKeepalive(store, ka, 'sk-resume');
        expect(r.ok).toBe(true);
        expect(r.alive).toBe(true);
        expect(r.tmuxSession).toBe('m7-sk-resume');
    });

    it('resume: 模拟崩溃(tmux 没了) → 从 checkpoint 重建 → alive:false, rebuilt:true', async () => {
        store.create({ sessionId: 'sk-restore', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        await bindSessionKeepalive(store, ka, 'sk-restore', { cwd: tmpDir });
        // 模拟崩溃：杀掉 tmux session（daemon 还在，只是 session 没了）
        spawnSync('tmux', ['kill-session', '-t', 'm7-sk-restore'], { stdio: 'ignore' });
        expect(await ka.isLive('sk-restore')).toBe(false);
        const r = await resumeSessionKeepalive(store, ka, 'sk-restore');
        expect(r.ok).toBe(true);
        expect(r.alive).toBe(false);
        expect(r.rebuilt).toBe(true);
        expect(r.tmuxSession).toBe('m7-sk-restore');
        // 重建后 session 又活了
        expect(await ka.isLive('sk-restore')).toBe(true);
    });

    it('resume: session 无 checkpoint → 抛(防误调用)', async () => {
        store.create({ sessionId: 'sk-nocp', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        await expect(resumeSessionKeepalive(store, ka, 'sk-nocp'))
            .rejects.toThrow(/no keepalive checkpoint/);
    });
});
