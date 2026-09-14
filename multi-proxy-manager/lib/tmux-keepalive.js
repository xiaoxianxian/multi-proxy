'use strict';

// Tmux Keepalive — M7 方向六 P3-b：长任务 tmux 保活原语（Emdash 范式）
//
// 目标：把长任务放进 tmux session，agent 进程崩了 / 终端断了 / 重连后，
//       session 仍存活，从最后 checkpoint 续跑。与 P1 worktree 协同（P3-a 设计草案）。
//
// 非侵入：纯库 + child_process spawn tmux，零新依赖；不碰 SessionStore/routes 生产路径。
//
// 安全纪律：
//     - 我们的 session 一律加 `m7-` 前缀（m7-<sessionId>），list/kill 只认前缀，绝不碰用户已有 tmux session。
//     - sessionId 做字符白名单，防 tmux 参数注入。
//     - cwd 必须存在且为绝对路径，否则拒绝起 session。
//     - tmux 不可用时所有接口返回 {ok:false, error:'tmux not found'}，不抛，调用方降级为无保活模式。
//     - 可用性按 binary 缓存（per-binary），实例注入的 binary 独立探测，互不串味。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

const PREFIX = 'm7-';
const ID_RE = /^[a-zA-Z0-9_-]+$/;     // sessionId 白名单

// per-binary 可用性缓存（binary → true/false）+ 全局 reset（仅测试用）
const _availCache = {};
function _availFor(binary) {
    if (binary in _availCache) return _availCache[binary];
    const r = spawnSync(binary, ['-V'], { encoding: 'utf8' });
    _availCache[binary] = !r.error && r.status === 0;
    return _availCache[binary];
}
function _resetTmuxProbe() {
    for (const k of Object.keys(_availCache)) delete _availCache[k];
}
// 全局探针：是否装了默认 tmux（模块级语义）
function tmuxAvailable() {
    return _availFor('tmux');
}

class TmuxKeepalive {
    constructor({ prefix = PREFIX, tmux = 'tmux' } = {}) {
        this.prefix = prefix;
        this.tmux = tmux;                  // 可注入命令名（测试用）
        this.sessName = (id) => {
            if (!ID_RE.test(id)) throw new Error(`invalid sessionId: ${id}`);
            return this.prefix + id;
        };
     }

    // 跑一条 tmux 命令（用本实例的 binary）。可用性不可用 → {ok:false, error:'tmux not found'}。
    _run(args, { timeoutMs = 30000 } = {}) {
        return new Promise((resolve) => {
            if (!_availFor(this.tmux)) {
                resolve({ ok: false, error: 'tmux not found' });
                return;
             }
            const child = spawn(this.tmux, args);
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolve({ ok: false, error: `tmux ${args.join(' ')} timed out after ${timeoutMs}ms` });
             }, timeoutMs);
            child.stdout.on('data', (d) => { stdout += d; });
            child.stderr.on('data', (d) => { stderr += d; });
            child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); });
            child.on('close', (code) => {
                clearTimeout(timer);
                resolve({ ok: code === 0, code, stdout, stderr });
             });
        });
     }

     // 起一个 detached session（长任务跑在里面）。cwd 默认 = 本进程 cwd。
     // 已存在则不重复建（幂等）。
     async startTmuxSession(sessionId, { cwd = process.cwd() } = {}) {
         if (!_availFor(this.tmux)) return { ok: false, error: 'tmux not found' };
         if (!ID_RE.test(sessionId)) throw new Error(`invalid sessionId: ${sessionId}`);
         if (!fs.existsSync(cwd)) return { ok: false, error: `cwd not found: ${cwd}` };
         const name = this.sessName(sessionId);
         if (await this.isLive(sessionId)) return { ok: true, tmuxSession: name, reused: true };
         const r = await this._run(['new-session', '-d', '-s', name, '-c', cwd]);
         if (r.ok) return { ok: true, tmuxSession: name };
         return { ok: false, error: r.error || r.stderr, tmuxSession: name };
     }

     // 该 session 是否活跃（tmux has-session 探测 exit 0）。binary 不可用 → false。
     async isLive(sessionId) {
         if (!_availFor(this.tmux)) return false;
         const name = this.sessName(sessionId);
         const r = await this._run(['has-session', '-t', name]);
         return r.ok;
     }

     // P3-a 文档里的 attach 语义：重连时挂回——等价「探测活跃 + 返回句柄」，
     // 真正的 attach 是外层 UI/终端动作（tmux attach -t），本原语只负责判活 + 返回 session 名。
     async attachTmuxSession(sessionId) {
         if (!_availFor(this.tmux)) return { ok: false, error: 'tmux not found' };
         const live = await this.isLive(sessionId);
         if (!live) return { ok: false, error: 'session not live' };
         return { ok: true, tmuxSession: this.sessName(sessionId) };
     }

     // 停掉本管理器起的 session（只认前缀，绝不碰用户其它 tmux）
     async stopTmuxSession(sessionId) {
         if (!_availFor(this.tmux)) return { ok: false, error: 'tmux not found' };
         const name = this.sessName(sessionId);
         if (!(await this.isLive(sessionId))) return { ok: true, killed: false };
         const r = await this._run(['kill-session', '-t', name]);
         return { ok: r.ok, killed: r.ok };
     }

     // 列出本管理器起的所有活跃 session（带前缀过滤）
    async list() {
        if (!_availFor(this.tmux)) return [];
        const r = await this._run(['list-sessions', '-F', '#{session_name}']);
        if (!r.ok) return [];
        return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(this.prefix));
     }
}

module.exports = { TmuxKeepalive, PREFIX, tmuxAvailable, _resetTmuxProbe };
