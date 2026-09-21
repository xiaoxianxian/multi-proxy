'use strict';

// jest test for TmuxKeepalive（M7 方向六 P3-b：长任务tmux 保活原语）
// hermetic 化：start/attach/stop/list/幂等 等需要 daemon 状态往返的用例走 fake-tmux（per-worker 隔离，
// 不碰系统 tmux daemon），根治「多 worker 并发踩同一 tmux daemon」的 flaky。
// 真 tmux 仍由两类用例覆盖：① 可用性探测 tmuxAvailable()（本机 3.7c 已装）；
// ② 注入不存在命令 → 全接口回 tmux not found（与 daemon 状态无关，不受并发影响）。
const { TmuxKeepalive, tmuxAvailable, _resetTmuxProbe } = require('../../lib/tmux-keepalive');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_TMUX = path.join(__dirname, 'helpers', 'fake-tmux.js');
// fake 的 per-worker 隔离 state：WID 让多 worker 各用各的 state（互不串味），同 worker 内靠 beforeEach 清。
const FAKE_STATE = path.join(os.tmpdir(), 'fakemux-wid-' + (process.env.JEST_WORKER_ID || '0') + '-state.json');

describe('TmuxKeepalive（P3-b 长任务保活原语 · hermetic fake tmux）', () => {
    const S = (i) => `test-${i}`;        // 原始 sessionId（白名单内）；前缀由 sessName() 统一加
    let tm;
    let tmpCwd;

    beforeEach(() => {
        // 清本 worker 的 fake state（同 worker 内各用例隔离）+ 建 tmp cwd
        try { fs.rmSync(FAKE_STATE, { force: true }); } catch { /* ignore */ }
        tm = new TmuxKeepalive({ tmux: FAKE_TMUX });   // 默认用例走 fake，不碰真 daemon
        tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-tk-'));
      });
    afterEach(() => {
        _resetTmuxProbe();
        try { fs.rmSync(FAKE_STATE, { force: true }); } catch { /* ignore */ }
        try {
            fs.rmSync(tmpCwd, { recursive: true, force: true });
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
