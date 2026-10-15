# agent-conflict-check

独立、零依赖的**代理所有权冲突检测**工具 —— multi-proxy 的「签名能力」可分发副本。

## 它解决什么

你本地可能同时装了多个"代理工具"：multi-proxy、cc-switch、trae、workbuddy……它们都可能去接管同一个 coding agent（Codex / Hermes / Cursor）的流量。当某个 agent 的 `base_url` 指向了**另一个工具的端口**，就发生了"两个工具抢同一个 agent"的冲突——请求会被错误的一方吃掉，且很难排查。

本工具直接读各 agent 配置文件里的 `base_url`（而不是只看端口监听），判断它是否被 cc-switch 等其它工具占用，给你一份明确的"谁占了谁"报告。

> 判定哲学：端口监听 ≠ 正在代理这个 agent。配置文件里的 `base_url` 才是流量真正送出去的地方——这也是 multi-proxy 内核 `agent-owner.js` 的同款判定。

## 用法

```bash
# 人类可读报告
node cli.js

# JSON 输出（供脚本/其它工具消费）
node cli.js --json

# 只在有冲突时输出
node cli.js --quiet

# 自定义"占用端口清单"（逗号分隔，便于扩展 trae/workbuddy 等）
PROXY_OCCUPANT_PORTS=15721,12345 node cli.js
```

退出码：`0` = 无冲突；`1` = 检测到冲突；`2` = 运行错误。

## 持续轮询（守护）

```bash
# 每 30s 轮询，日志写到 ~/.multi-proxy-manager/conflict-poll.log
node poll.js

# 每 10s，检测到冲突时弹系统通知（macOS）
node poll.js --interval=10 --notify

# CI / 手动只跑一次（退出码可用于门禁）
node poll.js --once
```

## 设计

- **零依赖**：仅用 Node 内置 `fs` / `os` / `path`，不要求整套 multi-proxy 安装——`npx` 即用。
- **不误报**：cursor 的 `base_url` 在 GUI 里（半自动）、无稳定配置文件可解析，工具返回"跳过"而非"冲突"。
- **与内核同源**：检测逻辑是 `multi-proxy-manager/lib/agent-owner.js` 的独立镜像副本（`conflict-check.js` 头部有同步纪律说明）。`agent-owner.js` 是 SSOT，本工具是它的可分发副本。

## 文件

| 文件 | 作用 |
|------|------|
| `conflict-check.js` | 零依赖检测内核（镜像 agent-owner.js） |
| `cli.js` | 命令行入口 |
| `poll.js` | 持续轮询守护（复用内核） |
| `package.json` | `bin: agent-conflict-check` |
