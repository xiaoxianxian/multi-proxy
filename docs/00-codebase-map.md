<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# docs/00-codebase-map.md — 代码库地图

> 本文件从项目结构实际扫描生成（`ls` / `git ls-files`），数字来自 `docs/01-feature-matrix.md` 与 README 第十四节实测基线。
> 最后验证：2026-10-15，HEAD `b234dcc`，main。上次验证：2026-09-17（HEAD `d9219af`，4 代理 / 770 tests 时代，已过期重写）。
> ⚠️ **2026-10-19 局部复核（非全量）**：仅重跑数量声明——`l2/` 模块 41→**51**、子目录 11→**10**、`lib/` 25→**27**、`routes/` 19→**22**（模块口径：仅 `l2/` 根目录 `.js`、不含 `*.demo.js`），HEAD `355eb61`，较上次已落后 16 个提交。**端口状态、各代理运行态、测试总数等其余内容本轮未复核**，仍以 2026-10-15 为准。
> ⚠️ **口径撞车提醒**：`l2/` 的「51 个**模块**」（根非 demo）与 `01-feature-matrix.md` 的「L2 **51 demo**」（含子目录 demo 数）**数值相同、含义不同**，改动前务必看本文件 L45 上方那行的口径注。

---

## 端口总表

| 端口 | 进程 | 技术栈 | 状态（2026-10-15 本机实测） |
|------|------|--------|---------------------------|
| 18790 | codex-proxy | Node.js + Express | 运行中（plist `-r2`） |
| 18791 | claude-proxy | Node.js + Express | 运行中 |
| 18792 | multi-proxy-manager | Node.js + Express + Electron | 运行中 |
| 18793 | hermes-proxy | Python + Flask | 运行中 |
| 18794 | cursor-proxy | TypeScript + Express + SQLite | 运行中（默认绑 127.0.0.1） |
| 18797 | dsh-proxy（槽位） | Node.js + Express | manage.sh 预留，按需起 |
| 18798 | opencode-proxy | Node.js + Express | 运行中 |
| 18799 | generic-openai-proxy | Node.js + Express | 随套件启停 |

> 端口探测可移植顺序：lsof → ss → /proc/net/tcp（`install.sh` 内置）。

---

## 目录总览

| 路径 | 用途 | 关键文件 |
|------|------|----------|
| 根目录/ | 项目入口 + 文档 + 安装/管理脚本 | `README.md`, `AGENTS.md`, `install.sh`, `install.ps1`, `manage.sh`, `manage.ps1`, `deploy-local.sh`, `docker-compose.yml`, `llms.txt` |
| multi-proxy-manager/ | 管理后端 + Web 面板 + Electron 壳（L2 挂载点） | `server.js`, `lib/`（27 模块）, `routes/`（22 路由）, `public/`, `main.js` |
| codex-proxy/ | Codex CLI 代理（Responses↔ChatCompletions 转换） | `proxy.js`, `routing-policy.js`, `budget-check.js`, `model-sync.js`, `tests/` |
| claude-proxy/ | Claude Code 代理（Anthropic Messages 协议 + 模型别名映射） | `proxy.js`, `routing-policy.js`, `tests/` |
| opencode-proxy/ | opencode 代理（OpenAI 兼容透传 + 成本台账 + 熔断） | `proxy.js`, `routing-policy.js`, `tests/` |
| generic-openai-proxy/ | Cline / Aider / OpenHands 共用代理（按客户端归因成本） | `proxy.js`, `failover.js`, `routing-policy.js`, `tests/` |
| hermes-proxy/ | Hermes Agent 代理（Python） | `proxy.py`, `requirements.txt`, `tests/` |
| cursor-proxy/ | Cursor IDE 代理（TypeScript + SQLite） | `src/server/`, `dist/`, `data/proxy.db`, `tests/` |
| dsh-proxy/ | DeepSeek Harness 客户端代理 | `proxy.js`, `routing-policy.js`, `tests/` |
| l2/ | L2 编排内核：51 个模块文件 + 10 个子目录（模块口径：**仅 `l2/` 根目录的 `.js`、不含 `*.demo.js`**；若含子目录全量非 demo 则为 80。⚠️ 勿与 `docs/01-feature-matrix.md` 的「L2 **51 demo**」混淆——那是 demo 数，含子目录） | 见下方「l2 内核分组」 |
| l2/adapters/ | 5 个非侵入适配器 | `l1-agent-adapter.js`, `claude-adapter.js`, `h3web-adapter.js`, `aigc-adapter.js`, `memory-align-adapter.js` |
| packs/ | agent 能力包（curator / dev-workflow 等） | `packs/curator/`, `packs/dev-workflow/` |
| tools/verify/ | 跨平台真机验证包（Linux/macOS/Windows） | `verify.sh`, `verify.ps1`, `README.md` |
| tools/ | 运维工具（update-check、push-gate 等） | `tools/update-check.js`, `scripts/push-gate-check.sh` |
| systemd/ | Linux systemd 参考模板（真实 unit 由 install.sh 内联生成） | `systemd/*.service` |
| desktop/ | Electron 桌面壳 | `main.js`, `first-launch-cleanup.js` |
| docs/ | 项目文档（单一入口约定） | `INDEX.md`, `00-codebase-map.md`, `01-feature-matrix.md`, `quickstart.md` |

---

## 各代理模块速查

### multi-proxy-manager（18792）

```
multi-proxy-manager/
├── server.js              # Express 入口 + CSP + 路由挂载
├── main.js                # Electron 桌面壳
├── lib/                   # 25 个模块
│   ├── agent-owner.js     # 单一保护（防双开 + 占用检测）
│   ├── auth.js            # JWT + bcrypt 认证
│   ├── process-manager.js # 代理启停
│   ├── logger.js          # 日志聚合
│   ├── cost-track.js      # 成本分析 A/B 路
│   ├── budget-guard.js    # 预算守卫
│   ├── pricing-schedule.js# 价目表
│   ├── provider-health.js # 供应商健康探针
│   ├── provider-isolation-executor.js # 供应商隔离执行
│   ├── session-store.js / session-keepalive.js / tmux-keepalive.js  # 会话保持三件套
│   ├── worktree-manager.js# git worktree 隔离
│   ├── side-effect-guard.js # 副作用守卫
│   ├── im-channels.js     # IM 出站通道（feishu/telegram）
│   ├── redact.js          # 日志脱敏
│   └── ...
├── routes/                # 19 个路由
│   ├── proxy-control.js   # 启停/状态/logs（热路径）
│   ├── proxy-api.js       # 供应商 CRUD
│   ├── orchestration.js   # L2 编排调用
│   ├── sessions.js        # 任务级 Session / 续跑
│   ├── im-inbound.js      # IM 入站（门控默认关）
│   ├── knowledge-base.js / memory-merge.js / skill-service.js / skill-hosts.js
│   ├── floor.js / budget.js / cost-report.js / mcp.js / h3web-guard.js / side-effect-guard.js
│   └── ...
├── public/                # Web 面板（dashboard/logs/proxy-config/sessions/login）
└── tests/                 # jest，1458/1458（94 suites，2026-10-14 实测）
```

### 四个同构代理（claude 18791 / opencode 18798 / generic 18799 / dsh）

四者同构分叉自 codex-proxy，目录结构一致：

```
<proxy>/
├── proxy.js               # Express 入口（协议路径各不相同）
├── routing-policy.js      # 路由策略
├── budget-check.js        # 预算预检
├── model-sync.js          # 模型目录同步
├── failover.js            # generic-openai-proxy 独有：上游故障转移
├── jest.config.js
└── tests/                 # claude 174 / opencode 159 / generic 159 jest
```

| 代理 | 协议 | 特点 |
|------|------|------|
| claude-proxy | Anthropic Messages | `claude-*` 别名映射（opus/sonnet → deepseek-v4-pro，haiku → agnes-3.0-flash，`CLAUDE_ALIAS_*` 可覆盖） |
| opencode-proxy | OpenAI 兼容透传 | 上游真实模型名不改写；`/v1/chat/completions` + `/v1/responses` 双入口 |
| generic-openai-proxy | OpenAI 兼容透传 | 按客户端（cline/aider/openhands 或 `x-agent` 头）归因成本；带 failover |
| dsh-proxy | OpenAI 兼容 | DeepSeek Harness 客户端；槽位 18797 |

### codex-proxy（18790）/ hermes-proxy（18793）/ cursor-proxy（18794）

```
codex-proxy/    proxy.js + routing-policy.js + budget-check.js + model-sync.js + tests/（159 jest）
hermes-proxy/   proxy.py（Flask）+ requirements.txt + tests/（77 pytest；find_config_yaml 支持 config.yaml.example 自动生成）
cursor-proxy/   src/server/（TS）+ dist/ + data/proxy.db（SQLite）+ tests/（250 jest）
                默认绑 127.0.0.1，BIND_HOST 可显式放开（非回环打 [SECURITY] 告警）
```

---

## l2 内核分组（41 模块文件 + 11 子目录）

```
l2/
├── 编排与路由
│   ├── orchestrator.js / decomposer.js / llm-decomposer.js / route-engine.js
│   └── executor-bind.js / observe-shadow-run.js / step2-canary-run.js
├── 注册与记忆
│   ├── agent-registry.js / profiles-store.js
│   └── memory-merge.js / memory-align.js / knowledge-base/
├── 技能与插件
│   ├── plugin-runtime.js / skill-service.js / skill-policy.js / skill-hosts.js / skill-versioning/
│   └── mcp-server.js / mcp-default-seed.js / contract.js
├── 成本与预算
│   ├── cost.js / usage-rollup.js / relay-ledger.js
│   └── savings-gateway/（gateway.js + charge-confirm.js + cost-watchdog.js）
├── 稳定性
│   ├── circuit-breaker.js / rate-limiter.js / http-retry.js / health-monitor.js / health-store.js
│   └── budget-buckets/ / access-control/
├── 质量与决策
│   ├── decision-judge.js / semantic-review.js / quality-fidelity.js / impact.js / handoff-reason.js
│   └── prompt-cache.js / token-policy.js / context-fold.js / floor-feed.js
├── 运行态
│   ├── run-history/ / l2-bootstrap.js / model-catalog-emitter.js
│   └── mock-l1.js / mock-h3web.js / mock-aigc.js（测试替身，非产品代码）
├── adapters/               # 5 个非侵入适配器（见目录总览）
├── python-middleware/      # Python 中间件
└── tests/ / specs/         # 单测 + 规格
```

> L2 demo：`l2/*.demo.js` 35 个 + 子目录 demo，`run-demos.js` 统一入口，2026-10-14 实测 51/51 PASS。
> 编排路由默认 **shadow 影子模式**（只记日志、不改真实路由）；`executor: "forward"` 门控见 `l2/observe-shadow-run.js`。

---

## 测试基线（2026-10-14 实测，全绿）

| 模块 | 测试数 | 套件 |
|------|--------|------|
| multi-proxy-manager | 1458/1458 | 94 suites |
| codex-proxy | 159/159 | 14 suites |
| claude-proxy | 174/174 | 15 suites |
| opencode-proxy | 159/159 | 14 suites |
| generic-openai-proxy | 159/159 | 14 suites |
| cursor-proxy | 250/250 | 21 suites |
| hermes-proxy | 77/77 | 4 files |
| dsh-proxy | 20/20 | 1 file（node:test，零依赖） |
| L2 demo | 51/51 | — |
| shell (bats) | 11/11 | — |
| **合计** | **~2500+** | — |

> hermes pytest 需 `--basetemp` 避开沙箱 `sitecustomize.py` 的 tmp EEXIST；
> jest 全套串行跑时个别走真 HTTP 回环的用例可能超时（重跑即过，非产品 bug）。

---

## 关键接口契约

- `docs/04-tech/api.md` — API 接口文档
- `docs/04-tech/data-model.md` — 数据模型
- `l2/adapter-protocol.md` — L2 开放接入协议
- `l2/CASES.md` — 核心使用案例
- `l2/PERF-REPORT.md` — L2 性能报告

---

## 文档索引

- `docs/INDEX.md` — 项目文档总入口（读项目先读这里）
- `docs/01-feature-matrix.md` — 功能完成度矩阵（所有测试数字的权威来源）
- `docs/quickstart.md` — 快速上手
- `docs/07-ops/consistency-baseline.md` — 文档声明 vs 代码事实对照（对外）
- `README.md` 第十四节 — 测试与验收基线
