'use strict';

// M7 方向六 P3-c：session ↔ tmux 保活胶水。hermetic 化：注入假 tmux（fake-tmux.js）跑全行为断言，
// 不碰系统 tmux daemon，根治跨 suite 并发踩踏的真实 flaky（真 tmux 仍由 3.7c 人工/e2e 验证）。
const { SessionStore } = require('../../lib/session-store');
const { TmuxKeepalive } = require('../../lib/tmux-keepalive');
const { bindSessionKeepalive, resumeSessionKeepalive } = require('../../lib/session-keepalive');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FAKE_TMUX = path.join(__dirname, 'helpers', 'fake-tmux.js');
// fake 的固定 state 文件（jest worker 运行时改的 process.env 不传给 spawn 子进程，故用固定路径 + 测试侧清理隔离）
// fake 的 per-worker 隔离 state 文件：WID 让多 worker 各用各的 state（互不串味），
// 同 worker 内各用例共享，靠下方 before/afterEach 清。(fake 自己读 JEST_WORKER_ID 拼同款路径。)
const FAKE_STATE = path.join(os.tmpdir(), 'fakemux-wid-' + (process.env.JEST_WORKER_ID || '0') + '-state.json');

describe('session-keepalive（P3-c 胶水层 · hermetic fake tmux）', () => {
    let store;
    let ka;
    let tmpDir;

    beforeEach(() => {
         // 清残留 fake state（固定文件）→ 每用例干净起步，仿真 daemon 的跨用例隔离
        try { fs.rmSync(FAKE_STATE, { force: true }); } catch { /* ignore */ }
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-'));
        store = new SessionStore({ dir: tmpDir });
        ka = new TmuxKeepalive({ tmux: FAKE_TMUX });
       });
    afterEach(() => {
         // 清 fake state（不碰系统 tmux daemon）+ tmpDir
        try { fs.rmSync(FAKE_STATE, { force: true }); } catch { /* ignore */ }
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
        const r1 = await bindSessionKeepalive(store, ka, 'sk-restore', { cwd: tmpDir });
        expect(r1.ok).toBe(true);                 // bind 必成功 → checkpoint 必落（防 flaky 根因）
        expect(store.get('sk-restore').checkpoint.tmuxSession).toBe('m7-sk-restore');
        // 模拟崩溃：杀掉（fake）tmux session（daemon 还在，只是 session 没了）
        await ka.stopTmuxSession('sk-restore');
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
