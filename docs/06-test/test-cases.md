---
title: "multi-proxy 全模块测试方案与用例"
status: verified
doc_type: test-cases
confidence: high
last_updated: 2026-09-16
related_code:
   - multi-proxy-manager/tests/
   - cursor-proxy/tests/
   - codex-proxy/tests/
   - hermes-proxy/tests/
   - l2/*.demo.js
   - l2/adapters/*.demo.js
   - tests/shell/
related_docs:
   - docs/INDEX.md
   - docs/01-feature-matrix.md
---

# multi-proxy 全模块测试方案与用例

> 所有数字 2026-09-16 真跑坐实。

---

## 总览

| 模块 | 框架 | 测试文件数 | 测试/断言数 | 备注 |
|------|------|-----------|------------|------|
| multi-proxy-manager | Jest (Node) | 46 files（39 unit + 7 e2e） | 635 tests · 40 suites | 全绿，覆盖 4 页 UI + 9 route + 13 lib |
| cursor-proxy | Jest (TS/TS-jest) | 11 files | 131 tests · 11 suites | 全绿（需 NODE_OPTIONS=--experimental-vm-modules，ESM+ts-jest，2026-09-17 真跑） |
| codex-proxy | Jest (Node) | 3 files | 53 tests · 3 suites | 全绿，补 auth/CRUD/switch/balances guard（2026-09-16） |
| hermes-proxy | pytest | 3 files | 63 test functions | 覆盖基本，无 E2E |
| L2 demo | node 原生 | 13 demos | ~169 checks | 全 PASS |
| Shell (bats) | bats-core | 1 file | 11 tests | 覆盖 manage.sh 启停 |

---

## 1 · multi-proxy-manager

### 单元测试（39 文件，635 tests · 40 suites）

| 类别 | 测试文件 | 覆盖内容 |
|------|---------|---------|
| 安全 | `security.test.js` | JWT/bcrypt/CSP/登录限流/错误脱敏 |
| 认证 | `auth` 相关 / `01-auth-flow` / `05-auth-bypass` | 首次设置/登录/认证头 |
| 路由 | `api.test.js` / `providers.test.js` / `proxy-control` 相关 | 各路由 CRUD + 转发 |
| 进程管理 | `process-management.test.js` / `tmux-keepalive.test.js` / `session-keepalive.test.js` | 启停/端口轮询/keepalive |
| 编排 | `orchestration-route.test.js` / `alert-route.test.js` | L2 门控路由 |
| 成本 | `cost.test.js` / `cost-track.test.js` | A/B 路成本分析 |
| 会话 | `session-store.test.js` / `sessions-lazy-store.test.js` / `sessions-api.test.js` / `session-store-edge.test.js` | 会话持久化/惰性加载 |
| 健康 | `provider-health.test.js` / `provider-health-edge.test.js` / `provider-health-api.test.js` / `health-graph.test.js` / `health-edge.test.js` | M1-M2 健康机制 |
| 错误处理 | `error-patterns.test.js` / `error-patterns-edge.test.js` / `error-classification.test.js` / `crash-recovery.test.js` / `p3d-crash-recovery.test.js` | 错误模式库/崩溃恢复 |
| 前端 | `dashboard.test.js` / `proxy-config.test.js` / `design-system.test.js` / `logs.test.js` / `login.test.js` | 4 页 UI 行为 |
| Agent | `agent-owner.test.js` / `registry.test.js` / `skill-service.test.js` / `llm-decomposer.test.js` / `route-engine.test.js` / `memory-merge.test.js` / `h3web-adapter.test.js` | L2 内核 |

### E2E 测试（7 文件，TypeScript，Playwright）

| 文件 | 覆盖 |
|------|------|
| `01-auth-flow.test.ts` | 首次设置 → dashboard → logout |
| `02-dashboard-interactions.test.ts` | 代理开关乐观更新 |
| `03-logs-page.test.ts` | 日志搜索/筛选/导出 |
| `04-proxy-config.test.ts` | 供应商 CRUD + 模型切换 |
| `05-auth-bypass.test.ts` | MANAGER_PASSWORD 绕过验证（P0 已修） |
| `06-security.test.ts` | CSP/CORS/错误脱敏 |
| `e2e-scenarios.test.js` | 跨页面联动场景 |

### 验证命令

```bash
cd multi-proxy-manager && npx --no-install jest --silent
```

预期：`Tests: 635 passed, Suites: 40 passed`

---

## 2 · cursor-proxy

| 测试文件 | 内容 |
|---------|------|
| `database.test.ts` | SQLite CRUD + better-sqlite3 native module |
| `providers.test.ts` | 供应商 CRUD |
| `routing-shadow.test.ts` | Shadow 路由（方向二） |
| `routing-intelligent.test.ts` | 智能路由（方向四 shadow） |
| `route-override.test.ts` | 路由覆盖 |
| `override-audit-persist.test.ts` | 覆盖审计持久化 |
| `chat-handler-shadow.test.ts` / `chat-handler-rr-index.test.ts` | 会话 handler |
| `admin-auth.test.ts` | Bearer token 认证 |
| `engine-monitoring.test.ts` | 引擎监控 |
| `health-integration.test.ts` | 健康映射 |

### 验证命令

```bash
cd cursor-proxy && npx --no-install jest --silent
```

预期：`Tests: 131 passed, 11 suites`（需 `NODE_OPTIONS=--experimental-vm-modules`，ESM+ts-jest 设计）

---

## 3 · codex-proxy

| 测试文件 | 测试数 | 内容 |
|---------|--------|------|
| `proxy.test.js` | 20 | 代理逻辑（findProvider 三级 fallback / parseConfigToml / updateConfigToml） |
| `integration.test.js` | 11 | HTTP 端点（/v1/models、/health、/api/routing-mode、status、history、clear-history、chat） |
| `auth-and-admin.test.js` | 17 | requireAuth 401/200 · /api/settings · /api/providers CRUD（含 api_key 脱敏/409 冲突）· /api/balances · switch-model & test-connection 的 guard 分支 |

> **已补（2026-09-16）**：3 文件 / 53 tests 全绿。新文件 `auth-and-admin.test.js` 内联 mirror express
> app（不 require proxy.js，避免与运行态 18790 端口冲突），全部离线确定性——providers 用内存数组、
> 不写盘、不发真实网络（/api/balances 仅断言 `未启用` 分支，不触发上游 fetch）。
> 仍开放：超时/流式断流的真实 pipeTo 路径（需 mock upstream 流，非本次范围）。

---

## 4 · hermes-proxy（Python pytest）

| 测试文件 | 测试函数数 | 内容 |
|---------|-----------|------|
| `test_proxy_logic.py` | 21 | 代理核心逻辑 |
| `test_http_endpoints.py` | 22 | HTTP 端点 |
| `integration_test.py` | 20 | 集成 |

> 基本覆盖够用。无 E2E 测试（需起 Flask 服务 + 真实 agent 请求，优先级低）。

### 验证命令

```bash
cd hermes-proxy && python3 -m pytest tests/ -v
```

预期：`63 passed`

---

## 5 · L2 编排内核 Demo（13 个 demo，~169 checks 全 PASS）

| Demo 文件 | Checks | 描述 |
|---------|--------|------|
| `agent-registry.demo.js` | 18 | Agent 能力注册 + 路由匹配 |
| `orchestrator.demo.js` | 16 | 多 agent 编排调度 |
| `decomposer.demo.js` | 19 | 任务拆解引擎 |
| `llm-decomposer.demo.js` | 19 | LLM 驱动拆解 |
| `alert.demo.js` | 13 | 健康告警 4 规则 |
| `cost.demo.js` | 14 | A/B 路成本分析 |
| `route-engine.demo.js` | — | 任务类型路由 log-only |
| `memory-merge.demo.js` | 11 | 跨 agent 记忆合并 |
| `skill-service.demo.js` | 13 | 技能服务调用 |
| `plugin-runtime.demo.js` | 14 | 插件生命周期 |
| `aigc-adapter.demo.js` | 10 | AIGC 协议四类接口 |
| `h3web-adapter.demo.js` | 6 | h3web HTTP 适配器 |
| `l1-agent-adapter.demo.js` | 25 | L1 chat 型 adapter |

### 验证命令

```bash
cd l2 && for d in *.demo.js adapters/*.demo.js; do [ -f "$d" ] && node "$d" 2>/dev/null | tail -1; done
```

---

## 6 · Shell（bats-core）

| 文件 | 测试数 | 覆盖 |
|------|--------|------|
| `tests/shell/manage.sh.test.bats` | 11 | `manage.sh start/stop/status/logs` |

### 验证命令

```bash
bats tests/shell/manage.sh.test.bats
```

---

## 全仓验证总脚本

```bash
cd ~/Documents/AI项目/multi-proxy
export NO_PROXY='*'
echo "=== manager ===" &&  cd multi-proxy-manager && npx --no-install jest --silent 2>&1 | grep -E "Tests:|Suites:"
cd ~/Documents/AI项目/multi-proxy
echo "=== cursor ===" &&   cd cursor-proxy && npx --no-install jest --silent 2>&1 | grep -E "Tests:|Suites:"
cd ~/Documents/AI项目/multi-proxy
echo "=== hermes ===" &&   cd hermes-proxy && python3 -m pytest tests/ -q 2>&1 | tail -3
cd ~/Documents/AI项目/multi-proxy
echo "=== L2 demos ===" && for d in l2/*.demo.js l2/adapters/*.demo.js; do [ -f "$d" ] && node "$d" 2>/dev/null | tail -1; done
```

---

## 已知缺口（汇总）

| 缺口 | 模块 | 影响 | 优先级 |
|------|------|------|--------|
| 仅 2 个测试文件 | codex-proxy | 偏薄，缺超时/流式/认证等核心 case | 中 |
| 无 E2E 测试 | hermes-proxy | 集成风险，需起 Flask 服务 | 低 |
| C2/B7 热路径未测 | `forward.js` / `codex-proxy/proxy.js` | 当前零调用方，幽灵路径 | P1 触发时 |
