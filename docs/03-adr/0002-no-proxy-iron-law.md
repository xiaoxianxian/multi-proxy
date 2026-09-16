---
title: "ADR-0002: 禁止往全局环境注入裸 `*` 的 NO_PROXY"
status: accepted
doc_type: ADR
confidence: high
last_updated: 2026-09-16
related_code:
   - install.sh（当前无 NO_PROXY 写法，已 grep 证实零残留）
   - CLAUDE.md "NO_PROXY 铁律" 节
related_docs:
   - docs/INDEX.md
   - AGENTS.md 第 2 节
---

# [ADR-0002] 禁止往全局 launchd 环境注入裸 `*` 的 NO_PROXY

## 状态

**已接受（accepted）**，全仓 `git log -S 'setenv NO_PROXY'` 和
`grep -rn 'NO_PROXY' install.sh manage.sh *.sh *.js` 均已证实零残留。

## 背景

### 事故来源（前驱项目，非本仓）

旧版 `codex-multi-model-proxy-deploy` 的 `install.sh:195-196`（已删，
CLAUDE.md 明确标注）执行了：

```bash
launchctl setenv NO_PROXY "...,*,..."
```

### 机制说明

HTTP 客户端（Node.js `fetch` / Python `requests` / macOS 系统代理）对
`NO_PROXY` 的处理方式：**按逗号拆项，对每项做 `hostname.endsWith(项)`**。
`*` 去前导通配符后为空串 `''`，而 `string.endsWith('')` 对任意字符串恒为 `true`，
导致**所有请求都绕过系统代理 → 直连被墙 IP → `ETIMEDOUT`**。

**实际后果**：`launchctl setenv` 是 launchd 全局环境变量，
影响所有 launchd 拉起的子会话（包括 WorkBuddy、CC Switch 等），
**一次操作搞崩全系统代理**。

## 备选方案

### 方案 A：使用 `*` 通配符绕过所有

**利弊**：
- ✅ 看起来简洁
- ❌ 致命 bug，搞崩全系统

### 方案 B：只对 localhost 类项使用 NO_PROXY，写死在 plist 的 `<EnvironmentVariables>` 中

**利弊**：
- ✅ 仅影响目标代理进程，不污染全局环境
- ✅ 使用 localhost / 127.0.0.1 / ::1 三项，精确，不会误伤
- ❌ 需要为每个代理单独配 plist

### 方案 C：本仓当前做法——不写任何 NO_PROXY，依赖系统代理配置

**利弊**：
- ✅ 最安全，当前 `install.sh` 和 `manage.sh` 已 grep 证实无任何 `NO_PROXY` 写法
- ✅ 全系统零影响

## 决策

本仓 `install.sh` / `manage.sh` 禁止 `launchctl setenv NO_PROXY`。
如确需绕过 localhost，只在代理自身 plist 的 `<EnvironmentVariables>` 内设：
`NO_PROXY=127.0.0.1,localhost,::1`（仅限 localhost 类项，绝不写 `*`）。

## 原因

`launchctl setenv` 是 launchd 全局环境变量，影响所有子会话。
`*` 通配符因 `endsWith('')` 恒真，会搞崩全系统代理。
前驱项目已有真实事故记录，不可重蹈覆辙。

## 后果

### 正面
- 全系统代理不受影响，`launchctl setenv` 不执行任何 NO_PROXY

### 负面
- 绕过 localhost 需为每个代理单独配 plist

### 后续工作
- [ ] 全仓 CI 加 lint，检测 `launchctl setenv` 调用中是否含 `NO_PROXY` 裸 `*`
- [ ] 在 `AGENTS.md` 中明确禁止（已落地）
