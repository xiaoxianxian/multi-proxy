# docs/01-feature-matrix.md — 功能完成度矩阵

> 本表所有数字必须来自真实运行，不可从文档摘录。
> 最后验证：2026-09-16, HEAD `b69fc77`, main 分支。

---

## 总览

| 层级 | 数量 | 测试 | 状态 |
|------|------|------|------|
| 代理模块 | 4 (codex/hermes/cursor/manager) | ✅ 全绿 | ✅ 上线 |
| L2 核心模块 | 10 | 13 demo 全 PASS | ✅ 完成 |
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

---

## L2 Adapter

| Adapter | 路径 | 测试 | 描述 |
|---------|------|------|------|
| h3web | `l2/adapters/h3web-adapter.js` | 6/6 demo PASS | 本地 H3 文生视频 HTTP 适配器 |
| aigc | `l2/adapters/aigc-adapter.js` | 10/10 demo PASS | AIGC 生图/生视频适配器 |
| l1-agent | `l2/adapters/l1-agent-adapter.js` | 25/25 demo PASS | L1 chat 型 adapter（Codex / Hermes）|
| 协议规范 | `l2/adapter-protocol.md` | 有样例 | 开放 HTTP/MCP 协议（可热插拔）|

---

## 测试总计（2026-09-16，全真跑）

| 模块 | 文件数 | 测试数 | 套件 |
|------|--------|--------|------|
| multi-proxy-manager | 40 files | 635 tests | 40 suites |
| cursor-proxy | 11 files | 131 tests | 11 suites |
| codex-proxy | 3 files | 53 tests | 3 suites |
| hermes-proxy | 3 pytest files | 63 checks | 3 suites（基本够用，无 E2E）|
| L2 demo | 13 .demo.js（10 内核 + 3 adapter） | ~182 checks 全 PASS | 各自独立运行 |
| shell (bats) | 1 .bats | 11 tests | — |

**总计：~1076 checks 全绿**（jest 819 + pytest 63 + bats 11 + l2 demo ~182）。

---

## 已知缺口（按优先级）

| # | 缺口 | 影响 | 建议 | 优先级 |
|---|------|------|------|--------|
| 1 | C2 `forward.js` axios 15s+100MB 全缓冲 | 大文件/长流式时 manager 可能超时 | 触发条件出现时再修（当前零调用方） | P1（触发时） |
| 2 | B7 `codex-proxy/proxy.js` 120s+pipeTo | 长流式超时 | 同上 | P1（触发时） |
| 3 | hermes-proxy 无 E2E | 集成风险 | P? 补 1 个 pytest E2E | 中 |
| 4 | ~~codex-proxy 仅 2 test 文件~~ | ✅ 已补 3 文件 / 53 tests（auth+CRUD+switch+balances guard，2026-09-16） | — | ✅ 已闭环 |
| 5 | P5 GUI 看板 | 易用性，非阻塞 | 暂缓 | 低 |
| 6 | ~~DSH 生态（DS1 SKILL.md 待产）~~ | ✅ DS1 已落（2 SKILL + `docs/02-product/dsh-integration.md`）；DS2/DS3 暂缓（#1496） | ✅ 已闭环 |

---

## 复现命令

```bash
# L2 demo
cd l2 && for d in *.demo.js adapters/*.demo.js; do [ -f "$d" ] && node "$d" 2>/dev/null | tail -1; done

# manager jest
cd multi-proxy-manager && npx --no-install jest --silent

# cursor jest
cd cursor-proxy && npx --no-install jest --silent

# hermes pytest
cd hermes-proxy && python3 -m pytest tests/ -q

# shell
bats tests/shell/manage.sh.test.bats
```
