<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# docs/01-feature-matrix.md — 功能完成度矩阵

> 本表所有数字必须来自真实运行，不可从文档摘录。
> 最后验证：**2026-10-08 全真跑**（manager 87 套件 / **1326 pass / 0 fail** + cursor 236/19 + codex 79/8 + hermes 77/4 + L2 46 demo 全绿），main = `11f290c`。
> 10-08 变更：`curator-pack` 3 fail 已随对应 commit 收口消失（10-07 实测为 3，今日 1326 全绿）；新增 run-history / skill-versioning / savings-gateway(server) / http-retry 等模块，测试从 1297 → **1326**、套件 83 → **87**。09-28 历史快照见 §测试总计。

---

## 总览

| 层级 | 数量 | 测试 | 状态 |
|------|------|------|------|
| 代理模块 | 4 (codex/hermes/cursor/manager) | ✅ 全绿 | ✅ 上线 |
| L2 核心模块 | 10 内核 + 3 adapter（另增量 savings-gateway / context-fold / floor-feed 等） | **46 demo 全 PASS**（10-07 `run-demos.js` 实跑，10-01 起 35→42→46 递增）| ✅ 完成 |
| L2 adapter | 3 (h3web/aigc/l1-agent) | demo 全 PASS | ✅ 完成 |
| 文档缺口（旧） | — | ✅ 本次补齐 | ✅ 完成 |
| DSH 接入 | — | 🟡 文档准备中 | ⏳ |

---

## 代理模块

| 功能 | 模块 / 路径 | 实现状态 | 测试 | 备注 |
|------|-------------|----------|------|------|
| 代理启停 | `manage.sh` / `multi-proxy-manager/lib/process-manager.js` | ✅ | 有 jest | 乐观更新 + 轮询端口 |
| 日志聚合 | `multi-proxy-manager/lib/logger.js` / `routes/` | ✅ | 有 jest | `TRIM_INTERVAL=500` O(n) 已修复 |
| 供应商 CRUD | `multi-proxy-manager/routes/proxy-api.js` | ✅ | 有 jest | 三代理均支持增删改查 |
| 模型切换 | `multi-proxy-manager/routes/proxy-control.js` | ✅ | 有 jest | 乐观更新 |
| 余额查询 | `BALANCE_ENDPOINTS` in 各代理 | ✅ | 有 jest | 各代理独立实现 |
| 安全认证 | `multi-proxy-manager/lib/auth.js` | ✅ | 有 jest | JWT + bcrypt |
| 健康告警内核 | `l2/alert.js` | ✅ (shadow) | 13/13 demo | `PROXY_HEALTH_ALERT` 默认关 = observe |
| 成本分析 A 路 | `multi-proxy-manager/lib/cost-track.js` | ✅ (shadow) | 14/14 demo | OpenAI 0.06 / Anthropic 28.7 真跑 |
| 成本分析 B 路 | `multi-proxy-manager/lib/cost-track.js` | ✅ (shadow) | 14/14 demo | 余额快照 → 消费/趋势 |
| 路由引擎 | `l2/route-engine.js` + `route-engine.demo.js` | ✅ | 1 demo PASS | 视频/文本/未知三类路由 log-only |
| 会话保持 | `multi-proxy-manager/lib/session-keepalive.js` / `tmux-keepalive.js` / `worktree-manager.js` | ✅ | 有 jest | M7 方向五 |
| 任务级 Session / 续跑 UI | `multi-proxy-manager/routes/sessions.js` + `public/sessions.html` | ✅ | 23/23 jest | M7 方向五（2026-10-09 实勘已收口：列表/abort/resume含对账409/done/fail/reconcile + 前端中止续跑 + 30s刷新） |
| agent-owner 单一保护 | `multi-proxy-manager/lib/agent-owner.js` | ✅ | 有 jest | 防双开 |
| 前端 4 页 | `public/dashboard/logs/proxy-config/login.html` | ✅ | 有 jest | 完整 UI + 乐观更新 |

---

## L2 编排内核

| 模块 | 路径 | 测试 | 描述 |
|------|------|------|------|
| `plugin-runtime.js` | `l2/plugin-runtime.js` | 14/14 demo PASS | 插件生命周期：register→enabled→started→stopped，热插拔 |
| `agent-registry.js` | `l2/agent-registry.js` | 18/18 demo PASS | Agent 能力注册中心 + 路由匹配 |
| `decomposer.js` | `l2/decomposer.js` | 19/19 demo PASS | 任务拆解引擎 |
| `llm-decomposer.js` | `l2/llm-decomposer.js` | 19/19 demo PASS | LLM 驱动的任务拆解 |
| `orchestrator.js` | `l2/orchestrator.js` | 16/16 demo PASS | 多 agent 编排调度 |
| `alert.js` | `l2/alert.js` | 13/13 demo PASS | 健康告警 4 规则引擎 |
| `cost.js` | `l2/cost.js` | 14/14 demo PASS | 成本分析（A/B 路） |
| `route-engine.js` | `l2/route-engine.js` | 1 demo PASS | 按任务类型路由 |
| `memory-merge.js` | `l2/memory-merge.js` | 11/11 demo PASS | 跨 agent 记忆合并 |
| `skill-service.js` | `l2/skill-service.js` | 13/13 demo PASS | 技能服务注册与调用 |
| `savings-gateway/` | `l2/savings-gateway/gateway.js` + `server.js` | 24/24 demo PASS + jest 18 例 | 省钱网关（task1 一期·shadow 模拟 delta）：难度档位路由 + 模拟省账（planned large 基线 − actual 档位）+ `produceCostSignal` 喂 alert.js；门控 `PROXY_SAVINGS_GATEWAY` 默认关 observe + shadow 默认开，127.0.0.1:18795，dummy key `gw_` 映射（内核不持真 key）；不碰热路径 |
| `http-retry.js` | `l2/http-retry.js` | 11/11 jest PASS | 上游限流/5xx/网络错退避重试底座（零依赖，尊重 Retry-After + 指数退避+±25%抖动+封顶防惊群 + 4xx 不重试）；`l1-agent-adapter.js` chat 出网已接入 |

---

## L2 Adapter

| Adapter | 路径 | 测试 | 描述 |
|---------|------|------|------|
| h3web | `l2/adapters/h3web-adapter.js` | 6/6 demo PASS | 本地 H3 文生视频 HTTP 适配器 |
| aigc | `l2/adapters/aigc-adapter.js` | 10/10 demo PASS | AIGC 生图/生视频适配器 |
| l1-agent | `l2/adapters/l1-agent-adapter.js` | 25/25 demo PASS | L1 chat 型 adapter（Codex / Hermes）；chat 出网已接 `http-retry` 退避重试 |
| 协议规范 | `l2/adapter-protocol.md` | 有样例 | 开放 HTTP/MCP 协议（可热插拔）|

---

## 测试总计（2026-10-08，全真跑）

| 模块 | 文件/套件 | 测试数 | 状态 |
|------|--------|--------|------|
| multi-proxy-manager | 87 suites | **1326 pass / 0 fail** | ✅ 全绿（10-08 `11f290c` 实跑；`curator-pack` 3 fail 已随对应 commit 收口消失；须 `NODE_OPTIONS=--experimental-vm-modules`）|
| cursor-proxy | 19 files / 19 suites | **236 tests** | ✅ 全绿（须 `NODE_OPTIONS=--experimental-vm-modules`，直跑 `npx jest` 会 ESM 假崩误判）|
| codex-proxy | 8 files / 8 suites | **79 tests** | ✅ 全绿 |
| hermes-proxy | 4 files | 77 pytest 项 | ✅（1 urllib3 warning，非失败）|
| L2 demo | 46 .demo.js（`run-demos.js` selected） | 全 PASS | ✅（10-01 起 35→42→46 递增）|
| shell (bats) | 1 .bats | 11 tests（本机无 `bats` binary，沿用 09-28 历史值，不纳入合计）| 沿用 |

**10-08 现状：全矩阵绿（manager 1326/0fail，curator-pack 3 fail 已消失）。** 历史快照：09-28 manager 822/50、cursor 17/219、codex 6/62、hermes 77/4、l2 23/318（合计 1380 checks）；增量轨迹 manager 770(09-26)→807(09-27)→822(09-28)→1297(10-07)→**1326(10-08)**、l2 demo 23→35→42→**46**、cursor 219→**236**、codex 62→**79**；中间 task1 `savings-gateway`、cost-watchdog、run-history/skill-versioning、http-retry 等增量已并入。

---

## 已知缺口（按优先级）

| # | 缺口 | 影响 | 建议 | 优先级 |
|---|------|------|------|--------|
| 1 | C2 `forward.js` axios 15s+100MB 全缓冲 | 大文件/长流式时 manager 可能超时 | 触发条件出现时再修（当前零调用方） | P1（触发时） |
| 2 | B7 `codex-proxy/proxy.js` 120s+pipeTo | 长流式超时 | 同上 | P1（触发时） |
| 3 | hermes-proxy 无 E2E | 集成风险 | P? 补 1 个 pytest E2E | 中 |
| 4 | ~~codex-proxy 仅 2 test 文件~~ | ✅ 已补 3 文件 / 53 tests（auth+CRUD+switch+balances guard，2026-09-16） | — | ✅ 已闭环 |
| 5 | ~~P5 GUI 看板~~ | 易用性 | ✅ 已闭环（`commit 2163ca9`：Electron 壳 `main.js` 117 行 + `launch-gui.sh` + `manage.sh gui` 子命令；启动脚本含 base_url 占用检测） | ✅ 已闭环（低） |
| 6 | ~~DSH 生态（DS1 SKILL.md 待产）~~ | ✅ DS1 已落（2 SKILL + `docs/02-product/dsh-integration.md`）；DS2/DS3 暂缓（#1496） | ✅ 已闭环 |
| 7 | **manager 3 测试 fail**（`curator-pack.test.js` `policies.length` 5 vs 6） | manager jest 非全绿（10-07 实测 1297/3fail/83）| 另一 agent 在途 WIP（`side-effect-guard.js`/`cost-watchdog.js`，git status 8M+7??）给 curator 加第 6 条 policy，测试期望未跟；**不擅修**（§5.6 属对方地盘），等其 commit 后自然修复 | P1（阻塞绿灯）|
| 8 | **M6 D0 = 100 行真实 Cursor 样本** | M6 机制已条件性 验收（`f10e0d2`），样本未达 | 18794 待维护者在 Cursor 实配 base_url + 实际 coding 攒 `routing_feedback`；脚本喂 = 污染拒用；18794 保持不动（重拉反伤 O1 env）| P1（待维护者 in-the-loop）|
| 9 | **curator 对 codex responses 内容级压缩失效** | codex 路径 token 不省 | 补响应级折叠 | 中 |
| 10 | **token 控制面 A 路**（`cost.js` token×单价进料管）+ 30 号基线 estimate→actual | 答不了"钱花在哪类 token" | 是否插队到 12 号既定序列前待维护者 | 中 |
| 11 | **多租户 / Portico 控制面**（企业版 7 缺口） | 控制面未建 | 维持 multi-proxy 无状态数据面 / Portico P1 待维护者 | P2（待维护者）|
| 12 | **`~/.multi-proxy-manager/providers.json` 10-07 18:09 被清成 `[]`** | manager 读不到 provider（下次重启才暴露，现 daemon 靠 launchd 独立起未崩）| 已从 10-02 备份恢复 4 provider 骨架（JSON 合法）；但 deepseek/moonshot key + agnes 名仍为 **10-02 旧值**（10-06 A1 轮换未同步到 manager 侧 json，db 侧为 `9f6250…`/`60fee3…`/`agnes-2.5-flash`）→ 需实测校准 | P1（凭据校准，待维护者）|

---

## 复现命令

```bash
# L2 demo
cd l2 && for d in *.demo.js adapters/*.demo.js; do [ -f "$d" ] && node "$d" 2>/dev/null | tail -1; done

# manager jest
cd multi-proxy-manager && npx --no-install jest --silent

# cursor jest（须 ESM flag，直跑 npx jest 会假崩误判）
cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx --no-install jest --silent

# hermes pytest
cd hermes-proxy && python3 -m pytest tests/ -q

# shell
bats tests/shell/manage.sh.test.bats
```
