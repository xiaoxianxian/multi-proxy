# 架构文档（architecture）

> 提炼自 `L2-BLUEPRINT.md`（主源）、`docs/01-feature-matrix.md`、`l2/README.md`、`l2/adapter-protocol.md`、`docs/04-tech/api.md`。
> 生成日期：2026-09-17（HEAD `d5e554a`，main）。数字以本项目实测为准，引用见文末数据源。

---

## 一、定位

proxy-rebuild 已从「多模型代理管理工具」（L1）升级为 **Agent 编排中枢（网关 + 中台）**（L2）。

- 旧定位：拦截 agent 的模型请求，转发到合适供应商。
- 新定位：把各 Agent（Codex / Hermes / Cursor）当「员工」，统一管理配置（记忆 / 技能 / 路由 / 健康 / 版本 / 调度），按任务类型自动调度到最合适的 Agent，并可视化整个团队。
- 项目是「大脑和调度器」，不是「路由器」。

---

## 二、总体架构（四层）

```
┌────────────────────────────────────────────────────────────┐
│  管理界面层（P5，已落地）                                      │
│  Electron 桌面壳 : 代理配置 / 日志 / 概览 / 登录                │
├────────────────────────────────────────────────────────────┤
│  L2 中台层（核心）                                            │
│  Registry · 编排引擎 · 插件运行时 · 记忆服务 · 技能服务 · 告警 · 成本 │
├────────────────────────────────────────────────────────────┤
│  网关层（L1，增强）                                          │
│  API Gateway · 协议适配(Responses↔ChatComp) · 负载均衡 · 路由规则 │
├────────────────────────────────────────────────────────────┤
│  代理层（L1，已有）                                          │
│  codex:18790 · hermes:18793 · cursor:18794 · manager:18792   │
│  （拦截转发，绝不写 Agent 自身配置文件）                        │
├────────────────────────────────────────────────────────────┤
│  外部 API · OpenAI / Anthropic / DeepSeek / Agnes / ...       │
└────────────────────────────────────────────────────────────┘
```

四代理端口（以 docker-compose.yml / CLAUDE.md 为准）：

| 代理 | 端口 | 技术栈 |
|------|------|--------|
| codex-proxy | 18790 | Node.js + Express |
| hermes-proxy | 18793 | Python + Flask |
| cursor-proxy | 18794 | TypeScript + SQLite（better-sqlite3） |
| multi-proxy-manager | 18792 | Node.js + Express + Electron(P5) |

---

## 三、L2 核心模块（落地状态，参考 L2-BLUEPRINT 七、实施路径）

| 模块 | 落地状态 | 证据 |
|------|----------|------|
| 插件运行时 `plugin-runtime.js` | ✅ P0 | 状态机 + 热插拔 + 能力聚合，demo 14 checks |
| Agent Adapter 协议 | ✅ P0 | 4 契约 + 4 样例（h3web 6 / AIGC 10 / L1chat 25） |
| Agent Registry `agent-registry.js` | ✅ P0 | demo 18 checks + 接 manager HTTP API（12/12 + :18792 真跑 200/401） |
| 记忆服务 `memory-merge.js` | ✅ P1.1a 内核 | 公共+个性合并 + 注入缝，demo 11 / jest 14；生产接线 P1.1b 列后续（YAGNI） |
| 技能服务 `skill-service.js` | ✅ P1.1b 内核 | Skill CRUD + 版本 + 市场，demo 13 / jest 13；生产接线列后续 |
| 编排引擎 `orchestrator.js` + `decomposer.js` | ✅ P2 | 拆解 + 拓扑调度 + 容错 + 聚合，19+16=35 checks；生产接线 `routes/orchestration.js`（门控 `PROXY_ORCHESTRATION` 默认关 / shadow 默认开） |
| LLM 拆解 `llm-decomposer.js` | ✅ P2.2 | 可注入 OpenAI 兼容 http + 全路径降级回 template，19 checks；门控 `PROXY_LLM_DECOMPOSE` 默认关 |
| 告警 `alert.js` + `routes/alert.js` | ✅ P2 | 4 规则 + cooldown 去重 + 可插拔 sink + 非侵入 observe，demo 13/13；门控 `PROXY_HEALTH_ALERT` 默认 403 |
| 成本分析 `cost.js` + `lib/cost-track.js` | ✅ P2 | B 路余额趋势 14 checks；A 路 token×单价 埋点 `forward.js` 热路径 line 168，门控 `PROXY_COST_TRACK` 默认关（live 实证 0.06 / cacheHit 28.7） |
| 文档 + 3 案例 + 性能 | ✅ P3 | `l2/CASES.md` + `l2/PERF-REPORT.md`，收口 `e3bcded` |

**全量测试基线**：jest **635/635（40 suites）** + l2 demo 全绿 + 3 adapter + specs validate（2026-09-17 E2E 复验，见 `MEMORY-2026-09-17.md` C 档）。

---

## 四、四条设计原则（老板定，贯穿全 L2）

| # | 原则 | 要点 |
|---|------|------|
| ① | 网关 + 中台 | 网关层 L1 增强；中台层 L2 新增（Registry / 编排 / 插件 / 记忆 / 技能 / 健康） |
| ② | 一切皆插件（仅项目内部热插拔） | 路由规则 / 供应商适配器 / 健康检查器 / UI 面板 / 记忆适配器可热插拔；**绝不热插拔到 Agent 外部** |
| ③ | 公共 + 个性记忆复用 | 公共 `~/.multi-proxy-manager/shared/`；个性各 Agent 目录**只读**；注入层启动时合并后**环境变量注入**，Agent 感知不到中枢 |
| ④ | 非侵入 | 拦截转发通过环境变量注入 base_url + 代理端口，**绝不写** `~/.codex`/`~/.hermes`/`~/.cursor`；新增能力一律 `gate: closed` / `shadow: true` 默认不改变现有行为 |

---

## 五、Agent Adapter 开放接入协议（核心卖点）

L2 区别于 CC-Switch / codex++ 的本质：**不锁定主流 agent，任何能实现本协议的 agent 都能接入/卸载**。

四类接口（最小契约，见 `l2/adapter-protocol.md`）：

| 接口 | 方法 | 形态 | 说明 |
|------|------|------|------|
| 能力声明 | `GET /adapter/capabilities` | HTTP | 启动时向 Registry 注册能力标签（code/writing/vision/image/video/audio…） |
| 健康检查 | `GET /adapter/health` | HTTP | 项目探活，返回 `{status, version, capabilities[]}` |
| 任务接收 | `POST /adapter/tasks` | HTTP / MCP / 文件队列 | 至少支持一种；本地 Web 服务用 HTTP |
| 结果回传 | `GET /adapter/tasks/:id` | HTTP / MCP / 文件 | 含 `state / result / error?` |

**协议分层**：主流 agent（Codex/Cursor）→ MCP（零改造）；本地 Web 服务（h3web/AIGC）→ HTTP；通用兜底 → 文件队列（`~/.agent-queue/<agent>/<task_id>.json`）。

---

## 六、核心数据流

### 6.1 任务编排链路

```
用户输入 → [任务拆解 LLM] → 依赖图(DAG) → [L2 路由引擎: 按能力标签+负载+成本预算匹配 Agent]
  → [调度器: 串行/并行执行, 失败 retry/fallback] → [结果聚合 → 最终报告 + 协作历史]
```

### 6.2 记忆注入链路（非侵入实现）

```
[Registry] 读 Agent Profile + 公共记忆 + 个性记忆(只读)
  → [记忆服务] 合并公共+个性 → 环境变量 AGENT_SYSTEM_PROMPT / AGENT_TOOLS_ALLOWED / ...
  → [Agent 启动器] 注入环境变量（Agent 配置 ~/.codex 等一点不动）
  → [Agent 运行] 用注入变量执行 → 结果回传
```

分工：记忆/skill（声明式数据）→ 环境变量；任务/中间结果（过程式数据）→ 运行时 hook / API。

---

## 七、遗留开放项（诚实标注）

| 项 | 说明 | 处置 |
|----|------|------|
| **C2** | `forward.js` 转发不支 SSE（axios 超时 + 缓冲 + `res.json`） | P1 功能 bug，但 manager 当前不代理 chat 流 → latent 幽灵路径，暂不改（改了 = 反向坑） |
| **B7** | 120s 掐断长流（`codex-proxy/proxy.js`） | 同上，线上无人用，待 live 复现定夺 |
| **P1.1b / P2 生产接线** | 记忆/技能内核已落，API 路由 + 持久化 store 列后续 | YAGNI，无非侵入接入缝 |
| **P5 桌面壳** | Electron 壳 | **2026-09-17 已闭环**（`main.js` + `manage.sh gui` + 自签名，commit `2163ca9`，截图确认 Dashboard 渲染） |

> 注：`L2-BLUEPRINT.md` 排期表中 P5 状态停在 09-11「未开始」，实际已于 2026-09-17 完成，以上表为准。

---

## 数据源

| 项 | 来源 |
|----|------|
| 四层架构 / 4 原则 / 数据流 | `L2-BLUEPRINT.md` 二、三、五 |
| 模块落地状态 + demo 数字 | `L2-BLUEPRINT.md` 七、实施路径；`docs/01-feature-matrix.md` |
| 开放接入协议 | `l2/adapter-protocol.md` |
| 幽灵路径 C2/B7 | `l2/PERF-REPORT.md §3` |
| 测试基线 635/635 | 2026-09-17 E2E `l2/*.demo.js` + jest 复验，见 `MEMORY-2026-09-17.md` 与 `docs/00-codebase-map.md` |
