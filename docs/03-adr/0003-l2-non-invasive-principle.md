---
title: "ADR-0003: L2 编排内核非侵入 4 条铁律"
status: accepted
doc_type: ADR
confidence: high
last_updated: 2026-09-16
related_code:
   - l2/plugin-runtime.js
   - l2/agent-registry.js
   - l2/alert.js
   - l2/cost.js
   - l2/route-engine.js
   - multi-proxy-manager/lib/forward.js
related_docs:
   - l2/adapter-protocol.md
   - docs/INDEX.md
---

# [ADR-0003] L2 编排内核非侵入 4 条铁律

## 状态

**已接受（accepted）**，贯穿 L2 全部 10 个核心模块 + 3 个 adapter + manager 的门控接入层。

## 背景

L2 编排中枢的设计核心卖点是"**类 DeepSeek Harness 一切皆插件**"——
adapter 可热插拔、内核零侵入。如果内核侵入 agent 文件或全局环境，
不仅失去热插拔价值，还会在 agent 侧留下"污染痕迹"，难以排查。

## 四铁律

| 序号 | 铁律 | 含义 | 验证方式 |
|------|------|------|----------|
| 1 | 不写 agent 文件 | adapter 对下游 agent 只读，绝不写 `~/.codex`、cursor 配置文件等 | `grep -rn 'writeFile\|~/.codex\|~/.claude' l2/` |
| 2 | 不注入全局 env | 不执行 `launchctl setenv` / `export *` 到全局；如需 env 走 plist | `grep -n 'launchctl\|setenv' *.sh` |
| 3 | 不写死端口 | h3web adapter 端口动态探测 8731/8732，不硬编码 | `grep -rn '8731\|8732' l2/` 只含 portCandidates 声明处 |
| 4 | 门控默认关 / shadow 默认开 | 新增能力必须 `gate: closed` 或 `shadow: true`，不改变现有行为 | `grep -rn 'gate\|shadow' l2/` 查看门控声明 |

## 备选方案

### 方案 A：内核侵入 agent 配置文件（如 CC-Switch 的做法）

**利弊**：
- ✅ 内核可以修改 agent 配置，功能强大
- ❌ agent 感知到中枢存在（破坏热插拔价值）
- ❌ 在 `~/.codex` 留下"代理痕迹"，难以排查
- ❌ 与 adapter 热插拔理念矛盾——adapter 卸载后残留配置无法清理

### 方案 B：非侵入（本方案）

**利弊**：
- ✅ 完全热插拔，adapter 卸载后零残留
- ✅ agent 侧完全无感知
- ✅ 门控可控：shadow 模式观察 → 确认安全 → 再上线
- ❌ adapter 无法直接修改 agent 配置（需通过 env 注入，有有限影响面）

## 决策

采用方案 B，4 条铁律贯穿所有 L2 模块。

## 原因

L2 的核心卖点是"类 DSH 一切皆插件"，侵入式设计与该理念矛盾。
非侵入是设计决策，不是限制。
门控默认关 / shadow 默认开是上线前验证策略，
让每个新能力都经过"观察 → 确认安全 → 上线"的三阶段，
避免任何新 kernel 直接改变生产路由。

## 后果

### 正面
- L2 内核可部署在任何 agent 旁，不破坏任何现有配置
- shadow 模式下可验证"如果这个能力上线了，路由结果会怎样"而不影响生产

### 负面
- 若需要修改 agent 配置，需通过 env 注入（有限影响面，可接受）

### 后续工作
- [ ] 全仓 CI lint：检测 `launchctl/launchd setenv` 全局注入
- [ ] 全仓 CI lint：检测 l2/ 中是否出现 agent 文件写操作
- [ ] 新 adapter 加入时，review 是否遵守 4 条铁律
