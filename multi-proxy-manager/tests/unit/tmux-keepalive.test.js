'use strict';

// jest test for TmuxKeepalive（M7 方向六 P3-b：长任务tmux 保活原语）
// 真 tmux（3.7c 已装）往返验证 + 注入假 tmux 覆盖"未装降级"路径。
const { TmuxKeepalive, tmuxAvailable, _resetTmuxProbe } = require('../../lib/tmux-keepalive');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('TmuxKeepalive（P3-b 长任务保活原语）', () => {
    const S = (i) => `test-${i}`;       // 原始 sessionId（白名单内）；前缀由 sessName() 统一加
    let tm;
    let tmpCwd;
    let fakeExec;

    beforeEach(() => {
        tm = new TmuxKeepalive();
        tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-tk-'));
    });
    afterEach(() => {
        _resetTmuxProbe();
        // 清理本测试可能留下的真 session（名字带 m7- 前缀）
        for (const id of ['test-a', 'test-b', 'test-c']) {
            spawnSync('tmux', ['kill-session', '-t', 'm7-' + id], { stdio: 'ignore' });
        }
        try {
            fs.rmSync(tmpCwd, { recursive: true, force: true });
        } catch { /* ignore */ }
        try {
            if (fakeExec && fs.existsSync(fakeExec)) {
                fs.rmSync(path.dirname(fakeExec), { recursive: true, force: true });
            }
        } catch { /* ignore */ }
    });

    it('tmux 可用(3.7c 已装)', () => {
        expect(tmuxAvailable()).toBe(true);
    });

    it('start 起 detached session + 可判活', async () => {
        const r = await tm.startTmuxSession(S('a'), { cwd: tmpCwd });
        expect(r.ok).toBe(true);
        expect(r.tmuxSession).toBe(tm.sessName(S('a')));   // 'm7-test-a'
        expect(r.reused).toBeUndefined();
        expect(await tm.isLive(S('a'))).toBe(true);
    });

    it('start 幂等: 已存在则 reuse', async () => {
        await tm.startTmuxSession(S('a'), { cwd: tmpCwd });
        const r2 = await tm.startTmuxSession(S('a'), { cwd: tmpCwd });
        expect(r2.ok).toBe(true);
        expect(r2.reused).toBe(true);
    });

    it('attach: 活跃返回句柄 / 不活跃回 error(不抛)', async () => {
        expect((await tm.attachTmuxSession(S('a'))).ok).toBe(false);
        await tm.startTmuxSession(S('b'), { cwd: tmpCwd });
        expect((await tm.attachTmuxSession(S('b'))).ok).toBe(true);
    });

    it('非法 sessionId → 抛(白名单拦截, 防 tmux 参数注入)', async () => {
        await expect(tm.startTmuxSession('x;rm-rf-tmp-y')).rejects.toThrow(/invalid sessionId/);
        await expect(tm.startTmuxSession('a/b')).rejects.toThrow(/invalid sessionId/);
    });

    it('cwd 不存在 → 拒绝起 session(不抛, 回 error)', async () => {
        const r = await tm.startTmuxSession(S('a'), { cwd: '/no/such/dir/xyz/' });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/cwd not found/);
    });

    it('stop 停掉本 session / stop 已停幂等', async () => {
        await tm.startTmuxSession(S('a'), { cwd: tmpCwd });
        const r = await tm.stopTmuxSession(S('a'));
        expect(r.ok).toBe(true);
        expect(r.killed).toBe(true);
        expect(await tm.isLive(S('a'))).toBe(false);
        const again = await tm.stopTmuxSession(S('a'));
        expect(again.killed).toBe(false);
    });

    it('list 只列带前缀的 session(不碰用户其它 tmux)', async () => {
        await tm.startTmuxSession(S('a'), { cwd: tmpCwd });
        const l = await tm.list();
        expect(l.some((s) => s === tm.sessName(S('a')))).toBe(true);   // 'm7-test-a'
        expect(l.every((s) => s.startsWith('m7-'))).toBe(true);
    });

    it('注入假 tmux(不存在命令) → 全接口回 ok:false error tmux not found(不崩)', async () => {
        const fake = new TmuxKeepalive({ tmux: 'definitely-no-such-binary-xyz' });
        _resetTmuxProbe();
        expect((await fake.startTmuxSession(S('a'), { cwd: tmpCwd })).ok).toBe(false);
        expect((await fake.isLive(S('a')))).toBe(false);
        expect(await fake.list()).toEqual([]);
        expect((await fake.stopTmuxSession(S('a'))).error).toMatch(/tmux not found/);
    });

    it('session 名带 m7- 前缀(隔离自有 session, 可安全只管理自己)', () => {
        expect(tm.sessName('abc')).toBe('m7-abc');
    });
});
