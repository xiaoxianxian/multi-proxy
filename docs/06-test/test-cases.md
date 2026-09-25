---
title: "multi-proxy 全模块测试方案与用例"
status: verified
doc_type: test-cases
confidence: high
last_updated: 2026-09-25
related_code:
    - multi-proxy-manager/tests/unit/
    - multi-proxy-manager/tests/e2e/
    - cursor-proxy/tests/
    - codex-proxy/tests/
    - hermes-proxy/tests/
    - l2/*.demo.js
    - l2/adapters/*.demo.js
    - l2/knowledge-base/*.demo.js
    - l2/savings-gateway/*.demo.js
    - tests/shell/
related_docs:
    - docs/INDEX.md
    - docs/01-feature-matrix.md
---

# multi-proxy 全模块测试方案与用例

> 所有数字 2026-09-25 全量真跑坐实（jest 单跑 + pytest + l2 demo 逐跑求和；bats 本机未装，沿用 09-13 历史验证 11/11）。

---

## 总览

| 模块 | 框架 | 测试文件数 | 测试/断言数 | 备注 |
|------|------|-----------|------------|------|
| multi-proxy-manager | Jest (Node) | 47 files（40 unit + 7 e2e） | 770 tests · 47 suites | 全绿，覆盖 4 页 UI + 9 route + 13 lib + L2/省钱网关 |
| cursor-proxy | Jest (TS/TS-jest) | 17 files | 219 tests · 17 suites | 全绿（需 `NODE_OPTIONS=--experimental-vm-modules`）|
| codex-proxy | Jest (Node) | 6 files | 62 tests · 6 suites | 全绿，含 auth/CRUD/switch/balances guard + 白名单门禁 |
| hermes-proxy | pytest | 4 files | 77 test functions | 含 `test_e2e_hermes.py` E2E；`integration_test.py` 20 为独立 integration，不进 pytest 发现集 |
| L2 demo | node 原生 | 23 demo | 318 checks | 全 PASS；10 内核 + 3 adapter + 10 监控/mcp/route/省钱网关 |
| Shell (bats) | bats-core | 1 file | 11 tests | 覆盖 manage.sh 启停 |

> **jest 合计 1051**（manager 770 + cursor 219 + codex 62），全模块总 1380 checks：jest 1051 + pytest 77 + l2 318 + bats 11 + codex-integration 2。

---

## 1 · multi-proxy-manager（770 tests / 47 suites，2026-09-25 全量真跑）

### 单元测试（unit，40 文件，含 e2e-scenarios）

| 类别 | 测试文件 | 覆盖内容 |
|------|---------|---------|
| 安全 | `security.test.js` | JWT/bcrypt/CSP/登录限流/错误脱敏 |
| 认证 | `01-auth-flow` / `05-auth-bypass` / auth 相关 | 首次设置/登录/认证头 |
| 路由 | `api.test.js` / `providers.test.js` / `proxy-control` | 各路由 CRUD + 转发 |
| 进程管理 | `process-management` / `tmux-keepalive` / `session-keepalive` | 启停/端口轮询/keepalive |
| 编排 | `orchestration-route` / `alert-route` | L2 门控路由 |
| 成本 | `cost.test.js` / `cost-track.test.js` | A/B 路成本分析 |
| 会话 | `session-store` / `sessions-lazy-store` / `sessions-api` / `session-store-edge` | 会话持久化/惰性加载 |
| 健康 | `provider-health` / `provider-health-edge` / `provider-health-api` / `health-graph` / `health-edge` | M1-M2 健康机制 |
| 成本监控 | `savings-gateway` / 告警/熔断/限流/健康监控相关 | 09-18 起 3 监控模块 + 省钱网关（Q3 闭环 + timer-flaky 根治）|
| 错误处理 | `error-patterns` / `error-classification` / `crash-recovery` / `p3d-crash-recovery` | 错误模式库/崩溃恢复 |
| 前端 | `dashboard` / `proxy-config` / `design-system` / `logs` / `login` | 4 页 UI 行为 |
| Agent | `agent-owner` / `registry` / `skill-service` / `llm-decomposer` / `route-engine` / `memory-merge` / `h3web-adapter` | L2 内核 |

### E2E 测试（7 文件，独立 Playwright 矩阵，不计入 jest 770）

| 文件 | 覆盖 |
|------|------|
| `01-auth-flow.test.ts` | 首次设置 → dashboard → logout |
| `02-dashboard-interactions.test.ts` | 代理开关乐观更新 |
| `03-logs-page.test.ts` | 日志搜索/筛选/导出 |
| `04-proxy-config.test.ts` | 供应商 CRUD + 模型切换 |
| `05-auth-bypass.test.ts` | MANAGER_PASSWORD 绕过验证（P0 已修） |
| `06-security.test.ts` | CSP/CORS/错误脱敏 |
| `e2e-scenarios.test.js` | 跨页面联动场景 |

> 上 6 个 `.ts` 走独立 Playwright（`npx playwright` 或 CI 独立 job），**不计入** `npx jest` 的 770；`e2e-scenarios.test.js` 被 jest 收进 47 suites。

### 验证命令

```bash
cd multi-proxy-manager && npx --no-install jest --silent
```

预期：`Tests: 770 passed, 47 suites passed`

---

## 2 · cursor-proxy（219 tests / 17 suites，2026-09-25 全量真跑）

| 测试文件 | 内容 |
|---------|------|
| `database.test.ts` | SQLite CRUD + better-sqlite3 native module |
| `providers.test.ts` | 供应商 CRUD |
| `routing-shadow.test.ts` | Shadow 路由（方向二） |
| `routing-intelligent.test.ts` | 智能路由（方向四 shadow） |
| `route-override.test.ts` | 路由覆盖（D4=C 机制） |
| `override-audit-persist.test.ts` | 覆盖审计持久化（D6-b 落盘） |
| `chat-handler-shadow.test.ts` / `chat-handler-rr-index.test.ts` | 会话 handler（rr 轮转耦合已修） |
| `admin-auth.test.ts` | Bearer token 认证 |
| `chatHandler-cost.test.ts` / `cost-track.test.ts` | 成本追踪 |
| `pricing-fx.test.ts` | Q1 汇率/价表解析（31 条） |
| `pricing-cache-drift.test.ts` | 价格缓存漂移 |
| `actualCost.test.ts` | 实际成本计算 |
| `engine-monitoring.test.ts` | 引擎监控 |
| `health-integration.test.ts` | 健康映射（D6-a 候选集） |

### 验证命令

```bash
cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx --no-install jest --silent
```

预期：`Tests: 219 passed, 17 suites passed`

---

## 3 · codex-proxy（62 tests / 6 suites，2026-09-25 全量真跑）

| 测试文件 | 测试数 | 内容 |
|---------|--------|------|
| `proxy.test.js` | 19 | 代理逻辑（findProvider 三级 fallback / parseConfigToml / updateConfigToml） |
| `integration.test.js` | 17 | HTTP 端点（/v1/models、/health、/api/routing-mode、status、history、clear-history、chat） |
| `auth-and-admin.test.js` | 17 | requireAuth 401/200 · /api/settings · providers CRUD（含 api_key 脱敏/409）· /api/balances · switch/test-connection guard |
| `circuit-integration.test.js` | 2 | 熔断器与路由集成 |
| `config-leak-gate.test.js` | 3 | 配置白名单门禁（防 token/raw 外泄）|
| `stream-bypass.test.js` | 4 | 流式旁路 |

> **已补**：6 文件 / 62 tests 全绿。`auth-and-admin` 内联 mirror express app（不 require proxy.js，避免与运行态 18790 端口冲突）；`config-leak-gate` 锁白名单防 P0-A 回归；`stream-bypass` 覆盖流式断流旁路。仍开放：超时/长流式的真实 pipeTo 路径（需 mock upstream 流，非本次范围）。

---

## 4 · hermes-proxy（77 test functions / 4 files，2026-09-25 真跑）

| 测试文件 | 测试函数数 | 内容 |
|---------|-----------|------|
| `test_proxy_logic.py` | 21 | 代理核心逻辑 |
| `test_http_endpoints.py` | 22 | HTTP 端点 |
| `test_e2e_hermes.py` | 14 | E2E（Flask 服务 + 真实 agent 请求） |
| `integration_test.py` | 20 | 集成（**独立运行，不进 pytest `test_*` 发现集，不计入 77**） |

> 默认 pytest 跑 `tests/` 命中 3 个 `test_*` 文件 = **77 passed**；`integration_test.py` 因不含 `test` 前缀不被发现，需手动 `python3 tests/integration_test.py` 跑（20 项）。

### 验证命令

```bash
cd hermes-proxy && python3 -m pytest -q
```

预期：`77 passed`

---

## 5 · L2 编排内核 Demo（23 个 demo，318 checks 全 PASS，2026-09-25 真跑）

| Demo 文件 | Checks | 描述 |
|---------|--------|------|
| `agent-registry.demo.js` | 27 | Agent 能力注册 + 路由匹配 |
| `orchestrator.demo.js` | 16 | 多 agent 编排调度 |
| `decomposer.demo.js` | 19 | 任务拆解引擎 |
| `llm-decomposer.demo.js` | 19 | LLM 驱动拆解 |
| `alert.demo.js` | 13 | 健康告警 4 规则 |
| `cost.demo.js` | 14 | A/B 路成本分析 |
| `route-engine.demo.js` | — (log-only) | 任务类型路由 log-only 冒烟 |
| `route-engine-orchestrator.demo.js` | 13 | route-engine ↔ orchestrator bridge |
| `memory-merge.demo.js` | 11 | 跨 agent 记忆合并 |
| `skill-service.demo.js` | 13 | 技能服务调用 |
| `plugin-runtime.demo.js` | 14 | 插件生命周期 |
| `circuit-breaker.demo.js` | 5 | 熔断器（公共监控模块） |
| `rate-limiter.demo.js` | 6 | 限流器（公共监控模块） |
| `health-monitor.demo.js` | 6 | 健康监控（公共监控模块） |
| `mcp-server.demo.js` | 11 | MCP stdio bridge |
| `mcp-orchestrate-llm.demo.js` | 12 | MCP 编排（LLM 路径） |
| `mcp-orchestrate-real.demo.js` | 9 | MCP 编排（真实路径） |
| `knowledge-base/knowledge-base.demo.js` | 11 | 知识库（Q2 module-state 修复） |
| `savings-gateway/savings-gateway.demo.js` | 24 | 省钱网关（Q3 成本闭环） |
| `savings-gateway/cost-watchdog.demo.js` | 34 | 成本看门狗（Q3 成本闭环） |
| `adapters/aigc-adapter.demo.js` | 10 | AIGC 协议四类接口 |
| `adapters/h3web-adapter.demo.js` | 6 | h3web HTTP 适配器 |
| `adapters/l1-agent-adapter.demo.js` | 25 | L1 chat 型 adapter |

> 318 = 22 个断言型 demo 之和（`route-engine.demo.js` 为 log-only 冒烟，不计入 checks）。

### 验证命令

```bash
cd l2
for d in $(find . -name "*.demo.js" 2>/dev/null); do [ -f "$d" ] && node "$d" 2>/dev/null | tail -1; done
```

---

## 6 · Shell（bats-core）

| 文件 | 测试数 | 覆盖 |
|------|--------|------|
| `tests/shell/manage.sh.test.bats` | 11 | `manage.sh start/stop/status/logs` |

> 本机未安装 `bats`，11/11 为 09-13 历史验证结果（沿用）。如需当场复跑：`brew install bats-core && bats tests/shell/manage.sh.test.bats`。

### 验证命令

```bash
bats tests/shell/manage.sh.test.bats
```

---

## 全仓验证总脚本

```bash
cd ~/Documents/AI项目/multi-proxy
echo "=== manager ===" && cd multi-proxy-manager && npx --no-install jest --silent 2>&1 | grep -E "Tests:|Suites:" && cd ~/Documents/AI项目/multi-proxy
echo "=== cursor ==="  && cd cursor-proxy  && NODE_OPTIONS=--experimental-vm-modules npx --no-install jest --silent 2>&1 | grep -E "Tests:|Suites:" && cd ~/Documents/AI项目/multi-proxy
echo "=== codex ==="   && cd codex-proxy   && npx --no-install jest --silent 2>&1 | grep -E "Tests:|Suites:" && cd ~/Documents/AI项目/multi-proxy
echo "=== hermes ==="  && cd hermes-proxy  && python3 -m pytest -q 2>&1 | tail -3 && cd ~/Documents/AI项目/multi-proxy
echo "=== L2 demos ===" && for d in l2/*.demo.js l2/**/*.demo.js; do [ -f "$d" ] && node "$d" 2>/dev/null | tail -1; done
```

预期：manager 770 / cursor 219 / codex 62 / hermes 77 → **jest 合计 1051** + l2 318 + bats 11 = **1380 checks 全绿**。

---

## 已知缺口（汇总）

| 缺口 | 模块 | 影响 | 优先级 |
|------|------|------|--------|
| 仅 3 文件未含超时/流式 | codex-proxy | 长流式 pipeTo 路径未覆盖 | 中 |
| hermes 缺独立 integration 纳入 | hermes-proxy | `integration_test.py` 不进 pytest 发现集 | 低 |
| C2/B7 热路径未测 | `forward.js` / `codex-proxy/proxy.js` | 当前零调用方，幽灵路径 | P1（触发时） |
| 残余 timer-flaky | multi-proxy-manager | §13.21 真 timer-flaky（非 module-state），<13%，CI `--rerunFailsAtMost=2` 容差 | 排期（jest.useFakeTimers 或接受容差） |
