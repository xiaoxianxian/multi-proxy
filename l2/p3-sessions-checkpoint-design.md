# P3 设计草案：M7 sessions.json checkpoint + Tmux 保活（2026-09-14）

> 背景：方向六 P3「参照 Emdash/Orca 设计 M7 sessions.json 的 checkpoint + Tmux 保活」。P1（worktree 隔离）已落地 commit f99111f。本草案把 P3 落成可落地的接口契约 + 最小实现面，等 Paseo 验证完再决定是否自研。

## 一、契约层（接进 session-store.js 的现有 checkpoint 字段）

session-store.js 的 `steps[]` 已支持 `checkpoint: {...}`，`abortedBy` 已支持 `'crash'`。本设计不新增字段，只规范 checkpoint 内容的 schema。

```js
// 每个 step 的 checkpoint 结构（对齐 Orca 范式：每步完成后写入，崩溃恢复读回）
const STEP_CHECKPOINT = {
    step: 3,
    tool: 'edit',                        // 该步的工具名
    idempotency_key: 'edit:abc123:v1',   // 幂等键（重放时比对，已做过则跳过）
    input: { file: 'src/app.js', content: '...' },
    output: { diff: '+12/-3', ok: true },
    next_action: 'run:node tests/unit/x.test.js',
    tmux_session: 'sess_xxx',            // 关联的 tmux session 名（跨重连锁活）
    tmux_window: 'main',
    tmux_pane: '0',
    completed_at: '2026-09-14T10:30:00Z',
};
```

## 二、保活层（Tmux 接入）

### 2.1 前置条件

- `tmux` 必须已装（`brew install tmux`）；未装时 `startTmuxSession` 返回 `{ok: false, error: 'tmux not found'}`，不崩，降级为无保活模式。

### 2.2 原语（lib/tmux-keepalive.js，新增）

```js
// 每个 session 一个 tmux session，session 名 = sess_<sessionId>
async startTmuxSession(sessionId) → { tmuxSession: 'sess_<sessionId>', tmuxWindow, tmuxPane }
async attachTmuxSession(sessionId) → { ok: true, tmuxSession }   // 重连时挂回
async stopTmuxSession(sessionId) → { ok: true }
async isAlive(sessionId) → boolean   // tmux has-session 探测
```

### 2.3 崩溃恢复流程

```
进程崩溃 → 新实例 start → getRunning() 返回 status='running'/abortedBy='crash' 的会话
             → 对每个 step 按 checkpoint.idempotency_key 比对，跳过已完成
             → attachTmuxSession 挂回 tmux（若 alive 直接续，若 dead 重建 tmux 从最后 checkpoint 续）
```

## 三、与 P1（worktree）的协同

- P1 的 worktree 给每个 session 一个独立 checkout（隔离写入）；P3 的 tmux 给每个 session 一个长活 shell（保活进程）。
- 协同：`createForSession({sessionId})` 建 worktree 后，`startTmuxSession(sessionId)` 在该 worktree 目录起 tmux，两者同 sessionId 关联。
- 恢复时：worktree 状态 + tmux 状态一起读回，agent 从最后 checkpoint 继续。

## 四、实施节奏（不阻塞 P2 验证）

| 阶段 | 动作 | 依赖 |
|------|------|------|
| P3-a | 本设计草案 + checkpoint schema 落盘 | 无 |
| P3-b | `lib/tmux-keepalive.js` 最小实现 + 测试（tmux 已装） | tmux + P1 |
| P3-c | session-store.js 接入 checkpoint 写入/读取 + tmux 关联 | P3-b |
| P3-d | 崩溃恢复 e2e 测试（杀进程 → 重启 → 续跑） | P3-c |

## 五、Paseo 对比参考（跑通后决定自研 or 借用）

Paseo（v0.8.0）自带 daemon + 多端监工，如果跑通后满足「手机续看长时程 agent」需求，P3 的 tmux 保活可能不必自研——直接用 Paseo 的保活层，sessions.json 只负责记录。P3-a 先落设计，P3-b 等 Paseo 验证结果决定再动手。
