'use strict';

// Session Keepalive — M7 方向六 P3-c：session ↔ tmux 保活胶水层
//
// 职责：把 P3-b 的 TmuxKeepalive 原语接进 M7 的 session 生命周期，
//       让 session-store 的 checkpoint 字段记录 tmux session 信息，
//       崩溃恢复时读回并尝试重连。
//
// 非侵入：纯新文件，不碰 session-store.js 热路径，不改动现有 addStep/update/create。
//
// 协议：checkpoint 扩展为 {
//     tmuxSession: string,    // TmuxKeepalive 的 session 名（m7-<sessionId>）
//     cwd: string,            // 建 session 时的工作目录
//     boundAt: ISOString,     // 绑定时间戳
//     [其他]: ...             // 保留用户自定义 checkpoint 字段
//  }
//  这是 opt-in 的扩展——不 bind 的 session 照常工作，checkpoint=null 不受影响。

const { TmuxKeepalive } = require('./tmux-keepalive');

// 绑定：session ↔ tmux 保活 session
// store: SessionStore 实例
// keepalive: TmuxKeepalive 实例
// sessionId: session 的 ID
// cwd: 工作目录（TmuxKeepalive.startTmuxSession 的 cwd）
// 
// 行为：
//   1. 调 keepalive.startTmuxSession 起/复用 tmux session
//   2. 把 tmux 信息写进 session 的 checkpoint 字段（通过 store.update）
//   3. 返回 { ok, tmuxSession, checkpoint, session }
async function bindSessionKeepalive(store, keepalive, sessionId, { cwd = process.cwd() } = {}) {
    // 起/复用 tmux session（幂等）
    const start = await keepalive.startTmuxSession(sessionId, { cwd });
    if (!start.ok) {
        return { ok: false, error: start.error, tmuxSession: start.tmuxSession };
    }
    
    // 读当前 session，保留已有 checkpoint 的自定义字段
    const session = store.get(sessionId);
    const prevCheckpoint = session.checkpoint || {};
    
    // 写 checkpoint（扩展字段，保留 prevCheckpoint 里已有的非保留键）
    const newCheckpoint = {
        ...prevCheckpoint,
        tmuxSession: start.tmuxSession,
        cwd: cwd,
        boundAt: new Date().toISOString(),
    };
    
    const updated = store.update(sessionId, { checkpoint: newCheckpoint });
    return { ok: true, tmuxSession: start.tmuxSession, checkpoint: newCheckpoint, session: updated };
}

// 恢复：从 session 的 checkpoint 读 tmux 信息，尝试重连
// store: SessionStore 实例
// keepalive: TmuxKeepalive 实例
// sessionId: session 的 ID
//
// 行为：
//   1. 从 session.checkpoint 读出 tmuxSession 名（若没有 → 抛）
//   2. 调 keepalive.isLive 探测 session 是否还活着
//   3. 活 → 返回 { ok, tmuxSession, alive: true }
//   4. 不活 → 尝试 keepalive.startTmuxSession 重建（用 checkpoint.cwd），返回 { ok, tmuxSession, alive: false, rebuilt: true }
//   5. 重建失败 → 返回 { ok: false, error }
async function resumeSessionKeepalive(store, keepalive, sessionId) {
    // 读 session 的 checkpoint
    const session = store.get(sessionId);
    const checkpoint = session.checkpoint;
    if (!checkpoint || !checkpoint.tmuxSession) {
        throw new Error(`session ${sessionId} has no keepalive checkpoint (checkpoint.tmuxSession missing)`);
    }
    
    const tmuxSession = checkpoint.tmuxSession;
    const cwd = checkpoint.cwd || process.cwd();
    
    // 探测 session 是否活
    const alive = await keepalive.isLive(sessionId);
    if (alive) {
        return { ok: true, tmuxSession, alive: true };
    }
    
    // 不活 → 尝试重建
    const rebuilt = await keepalive.startTmuxSession(sessionId, { cwd });
    if (!rebuilt.ok) {
        return { ok: false, error: rebuilt.error, tmuxSession };
    }
    return { ok: true, tmuxSession: rebuilt.tmuxSession, alive: false, rebuilt: true };
}

module.exports = { bindSessionKeepalive, resumeSessionKeepalive };
