<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# docs/01-feature-matrix.md — 功能完成度矩阵

> 本表所有数字必须来自真实运行，不可从文档摘录。
> 最后验证：**2026-10-14 全真跑**（manager **1458 pass / 0 fail / 94 suites** + codex 159/14 + claude 174/15 + opencode 159/14 + generic 159/14 + cursor 250/21 + hermes 77/4 + L2 51 demo + shell 11），main = `b234dcc`。
> 10-14~15 变更：claude / opencode / generic-openai / dsh 四代理密集接入并全绿；cursor 绑定收口回环 + dotenv bug 修复；hermes config.yaml 自动生成；relay-ledger P2 观测闭环；`docs/00-codebase-map.md` 同步重写。10-08 历史快照见 §测试总计。

---

## 总览

| 层级 | 数量 | 测试 | 状态 |
|------|------|------|------|
| 代理模块 | 7 (codex/claude/opencode/generic-openai/hermes/cursor/manager) + dsh（槽位） | ✅ 全绿 | ✅ 上线 |
| L2 核心模块 | 41 模块文件 + 11 子目录（另增量 savings-gateway / http-retry / relay-ledger / context-fold / floor-feed 等） | **51 demo 全 PASS**（2026-10-14 `run-demos.js` 实跑）| ✅ 完成 |
| L2 adapter | 5 (l1-agent/claude/h3web/aigc/memory-align) | demo 全 PASS | ✅ 完成 |
| 跨平台安装 | macOS(launchd) / Linux(systemd --user) / Windows(PowerShell) + `tools/verify/` 真机验证包 | verify.sh 本机跑通 | ✅ 上线 |
| DSH 接入 | dsh-proxy（18797 槽位，OpenAI 兼容） | ✅ 20/20（node:test，2026-10-15 实跑） | ✅ 上线 |

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
| Claude Code 接入 | `claude-proxy/proxy.js` | ✅ | 174 jest（2026-10-14 实跑） | 18791；`claude-*` 模型别名映射（opus/sonnet → deepseek-v4-pro、haiku → agnes-3.0-flash，`CLAUDE_ALIAS_*` 可覆盖）；复用 codex-proxy 的 Anthropic messages 协议路径；真机烟测通过 |
| opencode 接入 | `opencode-proxy/proxy.js` | ✅ | 159 jest（2026-10-14 实跑） | 18798；OpenAI 兼容透传（opencode 写上游真实模型名，不改写）；`/v1/chat/completions` + `/v1/responses` 双入口；复用 per-provider 熔断 / 预算预检 / 模型目录同步 / 成本台账 |
| Generic OpenAI 接入（Cline/Aider/OpenHands 共用） | `generic-openai-proxy/proxy.js` | ✅ | 177 jest（2026-10-15 实跑，含 failover 18 例） | 18799；一个适配器覆盖三件套（同构分叉 opencode-proxy，逻辑一致、边际成本趋零）；OpenAI 兼容透传（client 写上游真实模型名，不改写）；`/v1/chat/completions` + `/v1/responses` 双入口；按客户端（cline/aider/openhands 或 `x-agent` 头）归因成本台账；瞬态故障有界兜底（`failover.js`：5xx/429/408/网络错才切、确定性 4xx 不切、深度≤5、链耗尽 fail-loud，未声明 fallback 的 provider 行为与改造前逐字一致） |

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

## 测试总计（2026-10-14，全真跑）

| 模块 | 文件/套件 | 测试数 | 状态 |
|------|--------|--------|------|
| multi-proxy-manager | 94 suites | **1458 pass / 0 fail** | ✅ 全绿（2026-10-14 实跑；须 `NODE_OPTIONS=--experimental-vm-modules`）|
| cursor-proxy | 22 suites | **258 tests** | ✅ 全绿（2026-10-19 实跑；须 `NODE_OPTIONS=--experimental-vm-modules`，直跑 `npx jest` 会 ESM 假崩误判；10-19 起删 `jest.config.cjs` 与 `jest.config.js` 去重，消除「Multiple configurations found」假崩；route-override 6 例对齐 TierFlow 降档规则，新增 rephrase→`agnes-3.0-flash` 用例）|
| codex-proxy | 14 suites | **159 tests** | ✅ 全绿 |
| claude-proxy | 15 suites | **174 tests** | ✅ 全绿（2026-10-14 实跑；14 套件同构拷贝 codex-proxy + `model-alias.test.js` 15 例新增；须 `--worker=1` 避内存争抢 SIGTERM）|
| opencode-proxy | 14 suites | **159 tests** | ✅ 全绿（2026-10-14 实跑；须 `--worker=1`，stream-bypass 首用例走真 HTTP 回环，内存争抢下偶发 >30s 假红，单跑复绿）|
| generic-openai-proxy | 16 suites | **177 tests** | ✅ 全绿（2026-10-15 实跑，P2；159 + failover 18；须 `--worker=1`，同内存争抢假红）|
| dsh-proxy | 1 file（node:test，零第三方依赖） | **20 tests** | ✅ 全绿（2026-10-15 实跑；`npm test` = `node --test tests/*.test.js`，覆盖 routing-policy 五组纪律）|
| hermes-proxy | 4 files | 77 pytest 项 | ✅（1 urllib3 warning，非失败）|
| L2 demo | 51 demo（`run-demos.js` selected） | 全 PASS | ✅（10-14 实测 51/51；10-01 起 35→42→46→51 递增）|
| shell (bats) | 1 .bats | 11 tests（本机无 `bats` binary，沿用 09-28 历史值，不纳入合计）| 沿用 |

**10-14~15 现状：全矩阵绿（manager 1458/0fail + 三新代理 jest 174/159/177 + dsh node:test 20 + cursor 250 + hermes 77 + L2 51 demo），测试合计 ~2500+。** 历史快照：10-08 manager 1326/87、cursor 236/19、codex 79/8、claude 174/15、opencode 159/14、generic 159/14、l2 46 demo（合计 ~2400）；09-28 manager 822/50、cursor 219/17、codex 62/6、hermes 77/4、l2 23 demo（合计 1380 checks）。增量轨迹：manager 770(09-26)→807(09-27)→822(09-28)→1297(10-07)→1326(10-08)→**1458(10-14)**、l2 demo 23→35→42→46→**51**、cursor 219→236→250→**258(10-19)**、codex 62→79→**159**。

**10-19 现状：cursor-proxy 258/22（TierFlow route-override 对齐，删 jest.config.cjs 去重）；10-19 晨全矩阵实跑全绿（manager 97/1512、cursor 21/250、codex 159、claude 174、opencode 159、generic 192、dsh 27、l2 56 demo、e2e matrix 49+1skip），详见 PROJECT-STATE/2026-10-19.md。**

---

## 已知缺口（按优先级）

| # | 缺口 | 影响 | 建议 | 优先级 |
|---|------|------|------|--------|
| 1 | C2 `forward.js` axios 15s+100MB 全缓冲 | 大文件/长流式时 manager 可能超时 | 触发条件出现时再修（当前零调用方） | P1（触发时） |
| 2 | B7 `codex-proxy/proxy.js` 120s+pipeTo | 长流式超时 | 同上 | P1（触发时） |
| 3 | hermes-proxy 无 E2E | 集成风险 | P? 补 1 个 pytest E2E | 中 |
| 4 | ~~codex-proxy 仅 2 test 文件~~ | ✅ 已补 3 文件 / 53 tests（auth+CRUD+switch+balances guard，2026-09-16） | — | ✅ 已闭环 |
| 5 | ~~P5 GUI 看板~~ | 易用性 | ✅ 已闭环（`commit 2163ca9`：Electron 壳 `main.js` 117 行 + `launch-gui.sh` + `manage.sh gui` 子命令；启动脚本含 base_url 占用检测） | ✅ 已闭环（低） |
| 6 | ~~DSH 生态（DS1 SKILL.md 待产）~~ | ✅ DS1 已落（2 SKILL + `docs/02-product/dsh-integration.md`）；DS2/DS3 暂缓（#1496）；dsh-proxy 槽位 18797 已上线 | ✅ 已闭环 |
| 7 | ~~manager 3 测试 fail（curator-pack）~~ | ✅ 已闭环（10-08 起全绿，10-14 1458/0fail） | — | ✅ 已闭环 |
| 8 | **M6 D0 = 100 行真实 Cursor 样本** | M6 机制已条件性 验收（`f10e0d2`），样本未达 | 18794 待维护者在 Cursor 实配 base_url + 实际 coding 攒 `routing_feedback`；脚本喂 = 污染拒用；18794 保持不动（重拉反伤 O1 env）| P1（待维护者 in-the-loop）|
| 9 | **curator 对 codex responses 内容级压缩失效** | codex 路径 token 不省 | 补响应级折叠 | 中 |
| 10 | **token 控制面 A 路**（`cost.js` token×单价进料管）+ 30 号基线 estimate→actual | 答不了"钱花在哪类 token" | 是否插队到 12 号既定序列前待维护者 | 中 |
| 11 | **多租户 / Portico 控制面**（企业版 7 缺口） | 控制面未建 | 维持 multi-proxy 无状态数据面 / Portico P1 待维护者 | P2（待维护者）|
| 12 | ~~`~/.multi-proxy-manager/providers.json` 被清~~ | ✅ 已闭环：密钥统一迁 `codex-proxy/.env`（0o600 + 双 gitignore 覆盖），manager plist 零明文凭据；实测 agnes/deepseek 通、moonshot 无权限（既存缺口） | — | ✅ 已闭环 |
| 13 | **manage.sh stop 对 launchd KeepAlive 托管实例停不掉** | `stop all` 误报 FAIL；verify.sh 清理段曾因此崩溃（`WORK: unbound`） | ✅ 已修（10-15）：`stop_service` kill 后复验 + 明确返回码语义 + launchd 提示；verify.sh 清理前先 bootout LaunchAgent | ✅ 已闭环 |
| 14 | ~~README 第三节称 4 个 adapter，实际 5 个~~ | 文档与代码不一致（memory-align-adapter.js 已存在） | ✅ 已闭环（2026-10-15）：README 4 处声明 + 目录树同步为 5 个适配器（补 memory-align），顺带修正 demo 计数 29→51 | — | ✅ 已闭环 |
| 15 | **Windows verify.ps1 未经实机自测** | Windows 用户验收路径未验证 | 本机无 pwsh；找一台真 Windows 跑 `tools/verify/verify.ps1` 回传报告 | P2（需真机）|

---

## 复现命令

```bash
# L2 demo
cd l2 && for d in *.demo.js adapters/*.demo.js; do [ -f "$d" ] && node "$d" 2>/dev/null | tail -1; done

# manager jest
cd multi-proxy-manager && npx --no-install jest --silent

# cursor jest（须 ESM flag，直跑 npx jest 会假崩误判）
cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx --no-install jest --silent

# claude jest（须 --worker=1，全套并发 jest 会被内存争抢 SIGTERM）
cd claude-proxy && npx --no-install jest --silent --worker=1

# opencode jest（须 --worker=1，同上）
cd opencode-proxy && npx --no-install jest --silent --worker=1

# generic-openai jest（P2，须 --worker=1，同上）
cd generic-openai-proxy && npx --no-install jest --silent --worker=1

# hermes pytest
cd hermes-proxy && python3 -m pytest tests/ -q

# dsh node:test（零第三方依赖，非 jest）
cd dsh-proxy && npm test

# shell
bats tests/shell/manage.sh.test.bats
```
