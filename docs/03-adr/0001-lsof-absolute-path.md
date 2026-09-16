---
title: "ADR-0001: lsof 必须使用绝对路径 /usr/sbin/lsof"
status: accepted
doc_type: ADR
confidence: high
last_updated: 2026-09-16
related_code:
   - multi-proxy-manager/lib/process-manager.js
   - CLAUDE.md
related_docs:
   - docs/INDEX.md
---

# [ADR-0001] lsof 必须使用绝对路径 `/usr/sbin/lsof`

## 状态

**已接受（accepted）**，贯穿 `process-manager.js` 的所有 `execSync` 调用。

## 背景

`process-manager.js` 的 `isProcessRunning(port)` 通过 `/usr/sbin/lsof -i :PORT`
判断代理是否在运行。Node.js 子进程调用 `execSync('lsof ...')` 时，
**Node.js 子进程的 `PATH` 不包含 `/usr/sbin`**。

macOS 上 `lsof` 位于 `/usr/sbin/lsof`，不在 `/usr/bin` 或 `/usr/local/bin`。
Node.js spawn 子进程时 `PATH` 通常继承自 shell，但 `launchd`（LaunchAgent）
启动的进程中 `PATH` 可能不含 `/usr/sbin`，导致 `execSync('lsof ...')`
报 `ENOENT`，`isProcessRunning` 静默返回 `false`。

## 备选方案

### 方案 A：使用裸 `lsof`

**利弊**：
- ✅ 看起来正常
- ❌ launchd 环境下 PATH 不含 `/usr/sbin` → `ENOENT` → 误判代理未运行
- ❌ 静默失败，无报错，面板显示全"未运行"，极难排查

### 方案 B：使用 `/usr/sbin/lsof` 绝对路径

**利弊**：
- ✅ 无论 PATH 是否完整，绝对路径始终可执行
- ✅ 唯一可靠方案
- ❌ 需要在代码中硬编码 macOS 路径（Linux 下应为 `/usr/bin/lsof`）

## 决策

使用 `/usr/sbin/lsof` 绝对路径。

## 原因

这是 macOS 特有的 PATH 问题，不是跨平台问题。macOS 上 `lsof` 固定在
`/usr/sbin`，而 `launchd` 启动的进程 PATH 环境不稳定。绝对路径是唯一可靠解。

## 后果

### 正面
- 无论进程如何启动（`manage.sh`、LaunchAgent、Docker），代理状态检测稳定

### 负面
- 非 macOS 平台需调整路径（Dockerfile 中需确认镜像内 lsof 路径）

### 后续工作
- [ ] Docker 模式下用 `docker container inspect` 替代 lsof（已有，见 CLAUDE.md 铁律④ Docker）
