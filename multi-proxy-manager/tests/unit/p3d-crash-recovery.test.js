'use strict';

// jest test for P3-d 崩溃恢复 e2e（进程级杀-重启-续跑）
// 场景：store A bind keepalive → 模拟进程崩溃(kill tmux + 新 store) → store B 从 sessions.json 加载 → resumeSessionKeepalive
const { SessionStore } = require('../../lib/session-store');
const { TmuxKeepalive } = require('../../lib/tmux-keepalive');
const { bindSessionKeepalive, resumeSessionKeepalive } = require('../../lib/session-keepalive');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('P3-d 崩溃恢复 e2e（进程级杀-重启-续跑）', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-'));
    });
    afterEach(() => {
        // 清真 tmux + tmp
        spawnSync('tmux', ['kill-session', '-t', 'm7-p3d-crash'], { stdio: 'ignore' });
        spawnSync('tmux', ['kill-session', '-t', 'm7-p3d-restart'], { stdio: 'ignore' });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('进程崩溃 → 新 store 从 sessions.json 加载 → resumeSessionKeepalive 从 checkpoint 重建 tmux', async () => {
        const ka1 = new TmuxKeepalive();
        const ka2 = new TmuxKeepalive();    // "重启后的新实例"

        // 1) 旧进程：建 session + bind keepalive
        let store1 = new SessionStore({ dir });
        store1.create({ sessionId: 'p3d-crash', proxy: 'codex', task: { type: 'coding', prompt: 'fix bug' } });
        const bind = await bindSessionKeepalive(store1, ka1, 'p3d-crash', { cwd: dir });
        expect(bind.ok).toBe(true);
        expect(bind.tmuxSession).toBe('m7-p3d-crash');
        // checkpoint 已落盘到 sessions.json
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
        const s = raw.sessions.find((x) => x.sessionId === 'p3d-crash');
        expect(s.checkpoint.tmuxSession).toBe('m7-p3d-crash');
        expect(s.checkpoint.cwd).toBe(dir);

        // 2) 模拟进程崩溃：kill tmux session + 旧 store 释放
        spawnSync('tmux', ['kill-session', '-t', 'm7-p3d-crash'], { stdio: 'ignore' });
        expect(await ka1.isLive('p3d-crash')).toBe(false);
        store1 = null;    // 模拟旧进程退出

        // 3) 新进程：从 sessions.json 加载 + 重建 session（模拟重启）
        const store2 = new SessionStore({ dir });
        expect(store2.get('p3d-crash').checkpoint.tmuxSession).toBe('m7-p3d-crash');
        expect(store2.get('p3d-crash').checkpoint.cwd).toBe(dir);

        // 4) resumeSessionKeepalive：从 checkpoint 自动重建 tmux
        const resume = await resumeSessionKeepalive(store2, ka2, 'p3d-crash');
        expect(resume.ok).toBe(true);
        expect(resume.alive).toBe(false);        // 旧 session 死了
        expect(resume.rebuilt).toBe(true);        // 从 checkpoint.cwd 重建了
        expect(resume.tmuxSession).toBe('m7-p3d-crash');

        // 5) 重建后 tmux 活着 → 可以继续跑任务
        expect(await ka2.isLive('p3d-crash')).toBe(true);
    });

    it('完整流程：bind → 崩溃 → 重启 → 续跑 → 再次崩溃 → 再次重启', async () => {
        const ka = new TmuxKeepalive();

        // 第 1 轮
        let s1 = new SessionStore({ dir });
        s1.create({ sessionId: 'p3d-restart', proxy: 'hermes', task: { type: 'coding', prompt: 'x' } });
        await bindSessionKeepalive(s1, ka, 'p3d-restart', { cwd: dir });
        expect(await ka.isLive('p3d-restart')).toBe(true);

        // 崩溃 + 重启
        spawnSync('tmux', ['kill-session', '-t', 'm7-p3d-restart'], { stdio: 'ignore' });
        s1 = null;
        let s2 = new SessionStore({ dir });
        const r1 = await resumeSessionKeepalive(s2, ka, 'p3d-restart');
        expect(r1.rebuilt).toBe(true);
        expect(await ka.isLive('p3d-restart')).toBe(true);

        // 第 2 轮：续跑后再次崩溃
        spawnSync('tmux', ['kill-session', '-t', 'm7-p3d-restart'], { stdio: 'ignore' });
        s2 = null;
        const s3 = new SessionStore({ dir });
        const r2 = await resumeSessionKeepalive(s3, ka, 'p3d-restart');
        expect(r2.rebuilt).toBe(true);
        expect(await ka.isLive('p3d-restart')).toBe(true);
    });
});
