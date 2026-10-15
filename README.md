<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# Multi-Proxy — 多 Agent 编排中枢（L2）

> **一句话定位：把 Codex / Claude Code / OpenCode / Generic OpenAI / Hermes / Cursor / DSH 等 AI 编程代理当作「员工」，统一管住它们的配置、记忆、技能与健康，把任务调度到最合适的代理上——不是再做一个模型切换器，切的是「活」，不是「模型」。**
>
> English: *Project-level orchestration for coding agents — not a model switcher.*

cc-switch、Codex++ 这一类工具解决的是「切模型」；本仓库解决的是上一层：**项目 → 任务 → 分派 → 验收 → 记忆复用**。它站在本地私有栈（Ollama / MiniMax H3 / 自托管 API）之上，把多个 coding agent 编排成一条可验收的工作流，全程非侵入——agent 感知不到中枢的存在。

---

## 能干什么（先看这个）

| 场景 | 对应能力 |
|------|---------|
| 本机同时有 cc-switch、Cursor 自带代理等多个工具，base_url 打架 | **所有权冲突检测**：开代理前读各 agent 配置文件的 `base_url` 实际指向，被占用就拒开（第八节） |
| 一个任务要拆给多个 agent 分头做，结果再汇合 | **编排引擎**：拆解 → 路由 → 执行 → 聚合，影子模式默认只记录不改真实路由（第五节） |
| 多个 agent 共享同一份项目记忆 / 技能，但隔离个性 | **记忆服务 + 技能服务**：公共层跨 agent 复用，个性层 per-agent（第五节） |
| 本地模型 / 本地视频产线（MiniMax H3）也要当「员工」调度 | **5 个适配器**：codex·hermes / h3web / aigc / claude / memory-align，只读接入、绝不写回（第五节） |
| 3 个代理进程谁来管、日志谁来看、端口漂移怎么办 | **进程管理 + Web 管理台 + Electron 桌面壳**，端口全动态探测（第二、四节） |

3 分钟跑一遍全部核心 demo：`bash scripts/demo-tour.sh`（零副作用，影子模式，不碰任何 agent 文件）。

---

## 一、架构总览：网关 + 中台

```
┌──────────────────────────────────────────────────────────┐
│  桌面壳层（Electron）                                      │
│   开壳前先跑所有权冲突检测 · Dock 图标 · 双击即用            │
├──────────────────────────────────────────────────────────┤
│  管理界面层（L2）                                          │
│   Web 管理台 (18792) · 代理看板 · 日志 · 健康 · 配置 · 登录  │
├──────────────────────────────────────────────────────────┤
│  中台层（L2·核心）                                         │
│   10+ 能力内核：Registry · 编排 · 路由(影子) · 拆解 · 插件    │
│   记忆 · 技能 · 告警 · 成本 · 熔断 · 限流 · 提示词缓存 · MCP │
│   5 适配器（非侵入）：codex·hermes · h3web · aigc · claude · memory-align │
├──────────────────────────────────────────────────────────┤
│  网关层（L1·增强）                                          │
│  API 网关 · 协议转换(Responses↔ChatCompletions)            │
│  负载均衡(Failover/RoundRobin/成本优化) · 路由热插拔          │
├──────────────────────────────────────────────────────────┤
│  代理层（L1·核心）                                          │
│  Codex (18790) · Claude (18791) · OpenCode (18798)       │
│  Hermes (18793) · Cursor (18794) · DSH · Generic (18799) │
└──────────────────────────────────────────────────────────┘
```

**核心思想**：网关拦截各 Agent 的模型请求做协议转换与路由；中台把 Agent 的「全生命周期」（Profile / 记忆 / 技能 / 健康 / 调度）统一起来。Agent 全程感知不到中枢存在——这是「非侵入」与「记忆复用」同时成立的前提。

---

## 二、代理层与网关层（L1）

| 模块 | 技术栈 | 端口 | 说明 |
|------|--------|------|------|
| `multi-proxy-manager/` | Node.js + Express + Electron 桌面壳 | 18792 | Web 管理界面（前端 + 后端 + L2 内核） |
| `codex-proxy/` | Node.js + Express | 18790 | Codex CLI 代理 |
| `claude-proxy/` | Node.js + Express | 18791 | Claude Code 代理（Anthropic Messages 协议 + 模型别名映射） |
| `opencode-proxy/` | Node.js + Express | 18798 | opencode 代理（OpenAI 兼容透传 + 成本台账 + 熔断） |
| `generic-openai-proxy/` | Node.js + Express | 18799 | Cline / Aider / OpenHands 共用代理（OpenAI 兼容透传 + 成本台账 + 熔断） |
| `hermes-proxy/` | Python + Flask | 18793 | Hermes Agent 代理 |
| `cursor-proxy/` | TypeScript + Express + SQLite | 18794 | Cursor IDE 代理 |
| `dsh-proxy/` | Node.js + Express | PORT 可配 | DeepSeek Harness 客户端代理 |

**网关层能力**：协议转换（OpenAI Responses ↔ Chat Completions）、负载均衡（Failover / Round Robin）、成本优化路由、路由规则热插拔。

---

## 三、中台层（L2 核心）

10+ 能力内核模块（`l2/*.js`），配 29 个 E2E demo（`l2/*.demo.js`，09-28 真跑全部通过）：

| 内核模块 | 能力 |
|----------|------|
| `agent-registry` | Agent 注册中枢：Profile / 标签 / 能力 / 健康 / 版本 |
| `orchestrator` | 编排引擎：任务拆解 → 路由 → 执行 → 结果聚合 |
| `route-engine` | 路由引擎 + shadow 影子模式（默认只记日志、不改真实路由） |
| `decomposer` / `llm-decomposer` | 任务拆解：规则拆解 / LLM 拆解子能力 |
| `plugin-runtime` | 一切皆插件：路由规则、适配器、健康检查器、UI 面板运行时加载 |
| `memory-merge` | 记忆服务：公共层（跨 Agent）+ 个性层（per-Agent），经环境变量注入 |
| `skill-service` | 技能服务：跨 Agent 技能复用 |
| `alert` / `cost` | 健康告警 · 成本跟踪 |
| `circuit-breaker` / `rate-limiter` / `prompt-cache` / `health-monitor` | 熔断 · 限流 · 提示词缓存 · 资源探针 |
| `mcp-server` / `token-policy` | MCP 服务 · token 策略（Curator pack 驱动，见 `packs/curator/`） |

**5 个适配器（非侵入）**：`l1-agent`（codex-proxy / hermes-proxy）· `h3web`（本地 MiniMax H3 视频产线）· `aigc`（本地 AIGC 服务）· `claude`· `memory-align`（跨 agent 记忆对齐：hermes↔workbuddy 水位拉齐，门控默认关、shadow 默认开）——按 `l2/adapter-protocol.md` 开放协议接入，下游 Agent 只读、绝不写回。

---

## 四、管理面板功能（Web 18792）

- **概览页** — 实时显示各代理运行状态（运行中/未运行/未安装）+ 版本信息 + 一键启停 + 自动刷新（5/10/30/60 秒）+ 移动端适配
- **日志页** — 全代理日志聚合、多维过滤（类型/级别/关键词/时间）、复制/导出 TXT/CSV/清空
- **代理配置页** — 供应商 CRUD、模型切换、账户余额查询、切换历史、路由模式（Failover / Round Robin）
- **登录页** — 首次密码引导（强度指示）、失败 5 次锁 15 分钟、JWT + bcrypt

### 代理能力详述

- **Codex Proxy** — 上游模型转发（多供应商）、`/v1/models`、`/health`、供应商状态、路由模式、切换历史、余额查询、流式传输
- **Claude Proxy** — Anthropic `/v1/messages` 协议入口（Claude Code 主链路）、`claude-*` 模型别名映射（opus/sonnet → deepseek-v4-pro、haiku → agnes-3.0-flash，`CLAUDE_ALIAS_*` 可覆盖）、`/v1/messages/count_tokens`、供应商 CRUD、路由模式、余额查询
- **OpenCode Proxy** — OpenAI 兼容透传（opencode 直接写上游真实模型名，不改写）、`/v1/chat/completions` 与 `/v1/responses` 双入口、per-provider 熔断、预算预检、模型目录同步、成本台账
- **Generic OpenAI Proxy** — Cline / Aider / OpenHands 共用的 OpenAI 兼容网关（一个适配器覆盖三件套，逻辑与 opencode-proxy 同构）、`/v1/chat/completions` 与 `/v1/responses` 双入口、per-provider 熔断、预算预检、模型目录同步、成本台账、瞬态故障有界兜底（fallback 链：5xx/429/408/网络错才切下一个、确定性 4xx 不切、深度上限 5、链耗尽 fail-loud），按客户端（cline / aider / openhands 或 `x-agent` 头）归因成本
- **Hermes Proxy** — YAML 配置解析、`/api/switch-model`、路由模式、健康检查、余额查询、切换历史
- **Cursor Proxy** — 5 类供应商适配器（OpenAI Compatible / Anthropic / Gemini / Ollama / Generic）、SQLite 持久化、三种路由策略、熔断器、令牌桶限流、流式翻译、AES-256-GCM 加密 API Key
- **DSH Proxy** — per-provider 路由、预算预检、模型目录同步

---

## 五、所有权冲突检测（本项目与「模型切换器」的分界线）

本机常见的状况：cc-switch 占着 15721，Cursor 自带代理，某个 agent 的 `base_url` 同时被两个工具「认领」——结果就是流量去向不可预期、日志里全是 502。

本项目用一条结构化解法：**同一时刻，一个 agent 的 `base_url` 只能有一个所有者**。

- `multi-proxy-manager/lib/agent-owner.js` — 读各 agent **自己的配置文件**（`~/.codex/config.toml`、`~/.hermes/config.yaml`）里的 `base_url` 实际指向，而非只看端口（端口在听 ≠ 正在代理这个 agent）。占用者端口表 `OCCUPANT_PORTS` 默认 `15721`（cc-switch），可用环境变量扩展
- 桌面壳（`desktop/main.js`）开壳前调用 `detectAll()`：检测到目标 agent 的 base_url 被其他工具占用 → **该 agent 的开关置关并提示**，不抢、不覆写
- `tools/agent-proxy-switch` — 跨所有者的安全切换器：切前确认目标端口真的在听（不死链），只改该 agent 自己的配置（不误伤其他 agent）

```bash
bash tools/agent-proxy-switch                    # 各 agent 当前所有者 + 端口状态总览
bash tools/agent-proxy-switch codex              # 单 agent 状态
bash tools/agent-proxy-switch codex cc-switch    # 切换（结构上杜绝双工具同时认领）
```

> 这条能力来自一次真实事故：某次往全局 launchd 注入了带裸 `*` 的 `NO_PROXY`，导致本机所有走代理的 GUI 应用把「所有域名」判定为不走代理，全部直连超时。此后立下铁律（见第七节），冲突检测是把同一教训固化成代码。

---

## 六、本地模型接入（数据不出本机）

云端 provider 和本地端点在这套东西里是**同一张路由表里的平等候选**。本地不是「另一套降级方案」，是路由条件里实打实的一档——差别只在什么时候派给谁，不在开关上。

### 支持到哪一步

| 环节 | 本地路径 | 代码位置 |
|------|---------|---------|
| 拉本地模型列表 | 供应商类型选 `ollama`，走 Ollama 原生 `/api/tags`，取 `m.name` 当模型 ID | `multi-proxy-manager/routes/proxy-api.js:102-121` |
| 原生 provider 适配器 | `cursor-proxy/src/providers/ollama.ts`（`wireApi: 'ollama'`） | 同目录 `base.ts:2` |
| Anthropic wire 转发（codex 侧） | 本地上游走根路径 `${base}/messages`，不走 `/anthropic/v1` | `codex-proxy/proxy.js:820-836` |
| 本地上游无 key | 一律**不带** `x-api-key`：传 `undefined` 会让 undici 抛 Invalid value，也不该把入站 token 顶上去 | `codex-proxy/proxy.js:845-850` |
| 推理链读取 | Ollama 系思维链在 `message.reasoning`、`content` 为空 → 兜底取 reasoning | `multi-proxy-manager/tests/unit/executor-bind.test.js:177` |
| 真跑验证 | `node l2/step2-canary-run.js --real-local`，三档真连本地端点 | `l2/step2-canary-run.js:135` |

### 什么时候该派给本地

路由表里有一条 `privacy == true → 本地模型`，定位是「数据不出本机」。这是**架构性保证**——下游地址就是 `127.0.0.1`，不是调参数调出来的效果。路由规则一旦打上隐私条件，请求只落本机端点，不上云。

（本地视频产线那一类走的是另一条路，走第四节的 5 个适配器，不在这张路由表里。）

### 两个已经踩过的坑

- **僵尸请求**：本地大模型推理慢，客户端 timeout 小于真实生成耗时会断连，但 Ollama 侧照样跑完，白烧 CPU。真连前给 `/v1/chat/completions` 带 `max_tokens`、把客户端 timeout 放大，别并发打本地大模型。出处 `l2/memory-alignment-protocol.md:151`
- **Anthropic 兼容面的挂载位置**：各家把兼容层挂在路径上的位置不统一，2026-10-02 逐个实测（空包看状态码 + 与「不存在的路径」做差分基线）定了三级判定：`provider.anthropicBaseUrl` 显式指定优先 → `/anthropic` 前缀型（DeepSeek / moonshot）→ 根路径（Agnes / Ollama）。要换上游挂载位置，走 `anthropicBaseUrl` 这个逃生口。出处 `codex-proxy/proxy.js:815-836`

---

## 七、四条非侵入铁律（贯穿全项目）

| 铁律 | 含义 |
|------|------|
| **不写 Agent 文件** | 对下游 Agent 只读，绝不写 `~/.codex` / `~/.hermes` 等 |
| **不注入全局 env** | 不执行 `launchctl setenv` / `export` 到全局；env 走 plist 局部配置 |
| **不写死端口** | 各 Agent 端口动态探测（如 h3web 8731↔8732 实测漂移，谁在 LISTEN 用谁） |
| **门控默认关 / shadow 默认开** | 新增能力默认 `gate: closed` 或 `shadow: true`，不改变现有行为 |

> **NO_PROXY 铁律**：全局 launchd 绝不注入裸 `*` 通配——HTTP 客户端按逗号拆项做 `hostname.endsWith(项)`，`*` 去通配符后为空串，`endsWith('')` 恒真、所有请求绕过系统代理（曾把本机全部走代理的工具带崩）。仅在代理自身 plist 的 `<EnvironmentVariables>` 内放 `127.0.0.1,localhost,::1`。

---

## 八、安全机制

- **认证鉴权** — JWT + bcrypt 密码哈希，首次访问引导设置
- **进程沙箱** — spawn 路径/命令白名单校验，防命令注入
- **API 转发白名单** — 精确控制每个代理允许的端点与方法
- **速率限制** — 登录双重限流，防暴力破解
- **CSP / CORS** — 内容安全策略防 XSS、限制跨域来源
- **错误脱敏** — 生产环境不暴露堆栈和内部细节
- **密钥加密** — Cursor 代理 AES-256-GCM 加密 API Key

详见 `docs/04-tech/security-whitepaper.md`。

---

## 九、DSH 生态接入

`.dsh/skills/` 注册两个 Skill，使 DSH（**DeepSeek Harness**，官方 `dsh-plugin` 生态，"Everything is a Plugin"）的 Agent 能加载本项目：

| DSH Skill | 用途 |
|-----------|------|
| `l2-orchestrator` | 面向 L2 内核（10+ 模块 + demo 流程）的开发指南 |
| `multi-proxy` | 项目操作入口：3 代理端口、诊断、管理台、冲突检测、全套测试 |

> 术语：DSH 全称 **DeepSeek Harness**（官方仓库 `deepseek-ai/deepseek-harness`，`dsh-plugin` 生态）。本项目 `.dsh/skills/` 下两个 SKILL.md 即按官方 `dsh-plugin` 规范（`name` + `Use when…`）编写。

---

## 十、快速开始

**跨平台安装**（macOS / Linux / Windows 三端均支持）：

```bash
# ── macOS / Linux（bash） ──
bash install.sh --all        # 安装依赖 + 从 .env.example 生成各代理 .env
# 编辑各代理 .env 配置 API Key
nano codex-proxy/.env
nano claude-proxy/.env
nano opencode-proxy/.env
nano generic-openai-proxy/.env
nano cursor-proxy/.env
# Hermes 用 YAML：cp hermes-proxy/config.yaml.example hermes-proxy/config.yaml 后编辑
bash manage.sh start
bash manage.sh status
# 管理面板 → http://127.0.0.1:18792
```

```powershell
# ── Windows（PowerShell，原生，无需 WSL） ──
.\install.ps1        # 安装依赖 + 启动 + 配置登录自启
.\manage.ps1 status  # 查看状态
```

**开机自启（按平台）**：
- macOS：`bash install.sh --autostart`（launchd，写 `~/Library/LaunchAgents/com.multi-proxy-manager.plist`）
- Linux：`bash install.sh --autostart`（systemd 用户服务，写 `~/.config/systemd/user/multi-proxy-manager.service`；`systemctl --user status multi-proxy-manager` 查看）
- Windows：`.\install.ps1` 默认配置登录自启（计划任务 `MultiProxyManager`）；移除 `.\install.ps1 -Uninstall`

**常用命令**：`manage.sh {start|stop|restart|status}` · `manage.sh logs {all|codex|claude|opencode|hermes|cursor|dsh|generic|manager}` · 单服务 `manage.sh <agent> {start|stop|restart}` · 自启 `install.sh --autostart` · 桌面壳 `desktop/`（Electron，壳 = 启动器 + 窗口，业务代码不进 .app）。Windows 对应 `manage.ps1` / `install.ps1`。

**前置**：Node.js 20+（cursor-proxy 的 TypeScript 测试需 Node 24 + ESM runner）；Python3（Hermes）。端口检测已跨平台（优先 `lsof`，回退 `ss` / `/proc/net/tcp`）。支持 macOS（launchd）/ Linux（systemd --user）/ Windows（PowerShell + 计划任务）。Linux 装依赖：`sudo apt install nodejs npm python3`；Windows 需先装 Node.js 与 Python3。

完整上手流程见 `docs/quickstart.md`；验收口径见 `docs/06-test/acceptance.md`。

**启动顺序与端口依赖**：代理相互独立可单独起停；`18790`(codex) 是核心网关，savings-gateway(`18796`) 反向依赖它（`upstream: 127.0.0.1:18790`）。一键 `bash manage.sh start` 按依赖顺序拉起；单服务 `bash manage.sh <agent> start`。所有端口默认绑 `127.0.0.1`，仅 Docker/跨机显式 `BIND_HOST=0.0.0.0`。运行状态一键核对：`bash tools/health-all.sh`。

---

## 十一、一次请求怎么走完（代码事实 · 2026-10-06 逐行核过）

这一节写的是代码里真实跑的那条链，不是设计图。每一跳都给了文件路径与行号。

| # | 跳 | 代码位置与行为 |
|---|----|---------------|
| 1 | 入站 | `codex-proxy/proxy.js:20` 端口 18790；`proxy.js:1015` 默认只 bind `127.0.0.1` |
| 2 | 认证 | `proxy.js:31-36` `requireAuth` 只校 `x-proxy-auth`；未设 `PROXY_AUTH_TOKEN` 时 fail-open 并 WARN |
| 3 | 选 provider | `proxy.js:192-218` `findProvider(model)` 三级：`providers.json` 精确命中 → `provider_id` 子串 → 内置 env-key 上游。**只选一个，没有重试** |
| 4a | 转发（OpenAI wire） | `/v1/chat/completions` 与 `/v1/responses` 是同协议直通：`:698-768` 原样 `JSON.stringify` 转发，`:779-819` 仅 `normalizeTools` 解包工具参数 |
| 4b | 转发（Anthropic wire） | `/v1/messages` 走 `anthropicMessagesUrl()`（`proxy.js:940-947`）三级挂载判定：`provider.anthropicBaseUrl` 显式指定优先 → `deepseek/moonshot` 走 `/anthropic/v1/messages` → 其余 `${base}/messages` |
| 5 | 攒字节防丢账 | `pipeUpstreamBytes()`（`proxy.js:820-880`）`PassThrough` tee 一份副本，为的是流末 usage 不被丢掉 |
| 6 | 报用量 | `reportUsage()`（`proxy.js:892-912`）旁路 POST 到 manager 的 `/api/cost/report`；manager 侧 `lib/usage-probe.js:113-125` 按 `wire` 自动归一 |
| 7 | 归一 wire | `usage-probe.js:21-30` `detectWire()`：从 usage 字段形态认——有 `output_tokens_details` / `input_tokens` 是 Anthropic，有 `prompt_tokens` 是 OpenAI，有 `usage_metadata` 是 Gemini，都不是则兜底 `custom` |
| 8 | 落账 | `lib/cost-track.js:217-219` 算钱（cacheHit 单独计价、thinking 只计数不计费）；`:302-310` 追加写 `~/.multi-proxy-manager/cost-ledger.jsonl` |

**三条不能写死的边界**（2026-10-06 grep 核过）：

- **18790 上没有 failover / 重试 / 熔断。** 三条转发路径都是单次 `fetch`，失败直透上游状态码。路由模式里的 `failover` 在 `cursor-proxy/src/server/handlers/chatHandler.ts:21-24`（18794，round-robin / failover 两档）；`l2/circuit-breaker.js` 目前唯一的消费者是 `codex-proxy/tests/circuit-integration.test.js`。
- **「接入方不用写 parser」的准确含义是**：报告用量时只贴上游原样 `raw`，不必声明 `wire`，wire 由 manager 侧认。证据在 `usage-probe.js:8-13`、`proxy.js:988`、`routes/cost-report.js:41`。*`token-control-plane`* 是设计文档 `docs/03-token-control-plane.md` 的名字，不是模块；链路上的真实载体是 `l2/token-policy.js` 与 `tools/token-policy-bridge.js`。
- **`0.06` 与 `28.7%` 不是实测值。** 前者出自 `l2/README.md:153` 的手喂冒烟算式，后者是 `tests/unit/cost-track.test.js:83-91` 的单测断言。真实流量下是多少，代码里没有产出点。别拿这两个数当效果数字。

## 十二、为什么别人做不出来

先说清楚什么不值钱：多模型路由聚合这件事本身不稀缺，LiteLLM / one-api / New-API 都在做；TierFlow 也在做（它 README 自述 "Self-hosted AI router"，配置里 `"ollama": { "baseUrl": "http://localhost:11434/v1", "auth": { "type": "none" } }` 直接当 primary）。**「支持本地模型」不是本项目的差异项，别拿它当卖点。**

真正难抄的是三笔工程账，都是踩坑换来的：

1. **用量归一的自动识别。** `lib/usage-probe.js:21-30` 只靠 usage 字段名形态就能认出三家供应商的记账口径，接入方贴一段上游原样 JSON 就够了。三家字段各不相同、Anthropic 的流式还在末事件里包一层，硬写三份解析器的写法在跨版本升级上会反复返工。
2. **一个 agent 的 `base_url` 同一时刻只有一个所有者。** `lib/agent-owner.js` 读的是各 agent 自己配置里 `base_url` 的实际指向，而不是谁在听端口；cc-switch 占着 15721 时桌面壳开壳前先 `detectAll()`，撞了就把该 agent 的开关置关并提示，不抢、不覆写。这块来自一次真实事故（裸 `*` 污染 NO_PROXY 把本机所有走代理的 GUI 应用带崩，见第七节），上下文不在代码里。
3. **本地是一档路由条件，不是一个开关。** 路由规则打上 `privacy == true → 本地模型`，下游地址就是 `127.0.0.1`，是架构性保证而不是调参调出来的效果。

也讲一句该讲的：**如果只想省 API 的钱、要一个两分钟跑起来的网关，这个 repo 过重。** 它是为「本机多个 agent 同时在跑、数据不能出这台机器」这一层做重的；单端口轻量网关在满足前面那个需求上更合适。

## 十三、3 分钟演示

```bash
bash scripts/demo-tour.sh          # 全量（含测试基线，约 3 分钟）
bash scripts/demo-tour.sh --quick  # 只看 demo 不跑测试（约 30 秒）
```

脚本零副作用：L2 demo 默认影子模式、历史写 `os.tmpdir()`、绝不写任何 agent 文件。

---

## 十四、测试与验收（manager 1458 / codex 159 / claude 174 / opencode 159 / generic 177 / cursor 250 / hermes 77 / dsh 20 / l2 51 demo / shell 11 · 2026-10-14~15 实测全绿）

| 模块 | 命令 | 结果 |
|------|------|------|
| multi-proxy-manager | `cd multi-proxy-manager && npx jest --silent --forceExit` | 1458/1458（94 suites） |
| codex-proxy | `cd codex-proxy && npx jest --silent --forceExit` | 159/159（14 suites） |
| claude-proxy | `cd claude-proxy && npx jest --silent --forceExit --worker=1` | 174/174（15 suites） |
| opencode-proxy | `cd opencode-proxy && npx jest --silent --forceExit --worker=1` | 159/159（14 suites） |
| generic-openai-proxy | `cd generic-openai-proxy && npx jest --silent --forceExit --worker=1` | 159/159（14 suites） |
| cursor-proxy | `cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --silent --forceExit` | 250/250（21 suites） |
| hermes-proxy | `cd hermes-proxy && python3 -m pytest tests/ -q` | 77/77（4 files） |
| dsh-proxy | `cd dsh-proxy && npm test`（node:test，零第三方依赖） | 20/20（1 file，2026-10-15 实跑） |
| **L2 demo** | `find l2 -name '*.demo.js' -print0 \| xargs -0 -n1 node` | 51/51 demo 跑通 |
| shell (bats) | `cd tests/shell && bats *.bats` | 11/11（CI 无 bats 时走 `check.sh` 零依赖回退） |

历史修复记录见 `P0-FIXES.md`（11 项 P0）；完整验收判据见 `docs/06-test/acceptance.md`。

---

## 十五、目录结构

```
multi-proxy/
├── multi-proxy-manager/       # Web 后台 + L2 内核调用 + agent-owner 冲突检测
│    ├── lib/agent-owner.js    # 所有权冲突检测（base_url 实指向，非端口）
│    ├── src/                  # 后端 server.js / routes / lib
│    ├── public/               # 前端页面
│    └── tests/                # Jest 测试
├── codex-proxy/               # Node.js 代理（18790）
├── claude-proxy/              # Node.js 代理（18791，Claude Code）
├── opencode-proxy/            # Node.js 代理（18798，opencode）
├── generic-openai-proxy/      # Node.js 代理（18799，Cline/Aider/OpenHands 共用）
├── hermes-proxy/              # Python/Flask 代理（18793）
├── cursor-proxy/              # TypeScript/SQLite 代理（18794）
├── dsh-proxy/                 # Node.js 代理（DeepSeek Harness，PORT 可配）
├── desktop/                   # Electron 桌面壳（启动器 + 窗口）
├── l2/                        # L2 编排中枢：10+ 内核 + 5 adapter + 51 demo
│    ├── adapters/             # codex·hermes / h3web / aigc / claude / memory-align 适配器
│    ├── adapter-protocol.md   # 开放接入协议
│    ├── savings-gateway/      # 省钱网关 + 成本看门狗
│    └── specs/                # agent-memory / agent-profile 契约 + schema
├── packs/curator/            # Curator pack（token 策略包，M1-M6）
├── tools/agent-proxy-switch  # 跨所有者安全切换器
├── scripts/demo-tour.sh      # 3 分钟演示脚本
├── .dsh/skills/              # DSH 生态 Skill
├── docs/                     # 结构化文档（架构 / 部署 / 验收 / 用户）
├── tests/shell/              # manage.sh 行为测试（bats）
├── Dockerfile.* / docker-compose.yml
└── manage.sh                 # 进程管理（非侵入）
```

---

## 十六、已知问题与待修复

### #1 〔历史·已规避〕裸 `*` 污染全局 NO_PROXY
旧版部署脚本含 `launchctl setenv no_proxy "127.0.0.1,localhost,*"`，使所有走系统代理的 GUI 应用直连超时。当前源码已无此写法（autostart plist 仅设 `PATH` + 代理自身局部 env），修复写法 `*` → `::1`。

### #2 〔已修复·2026-10-13〕`install.sh --uninstall` 卸载不完整
历史：只删 `com.multi-proxy-manager.plist`，不清理其余 `com.multi-proxy.*` plist 与用户级残留。
修复（2026-10-13）：
- `uninstall_launchd` 改用 `plist_label`（plutil 优先 + python 兜底 + grep 终极兜底），修掉含特殊字符注释的 plist（如 savings-gateway）被 expat 解析失败而跳过的问题；
- 新增 `uninstall_residues`：卸载时一并清理 `~/.multi-proxy-manager`、`codex-proxy/{logs,trace}`、`hermes-proxy/.env`、`multi-proxy-manager/.env`、`~/.local/bin/dsh-curator`（第三方 `~/.dsh` 主目录只警告不自动删）；
- 全程支持 `install.sh --uninstall --dry-run` 预览，确认无误再实跑。

### #3 〔设计〕「单一所有者」机制
无机制天然防止 proxy 与 cc-switch 同时认领同一 agent 的 base_url。已用 `tools/agent-proxy-switch` + `lib/agent-owner.js` 提供结构化防护（见第五节），桌面壳开壳前强制检测。

### #4 〔已修复·2026-10-15〕`manage.sh stop` 停不掉 launchd 托管实例 + 返回码误报
现象：`stop all` 对 launchd KeepAlive 托管的实例（实测 codex 18790 / manager 18792）kill 后立刻被拉活，报「未能正常停止」；且 `kill -9` 打在已自行退出的进程上返回 1，被 `set -e` 放大为整个 `stop all` FAIL。
修复：
- `stop_service` kill 后复验端口、显式 `return 0`、kill 加 `|| true`，返回码不再冒充停止结果；
- 端口仍占用时明确提示「launchd KeepAlive 托管，需 `launchctl bootout`」，不再误报；
- `tools/verify/verify.sh` 清理段先 bootout `~/Library/LaunchAgents/com.multi-proxy.*.plist` 再 stop，修掉其自身 `WORK: unbound variable` 崩溃（2026-10-15 真跑复验 EXIT=0）。

---

## 十七、常见问题

### 排障（装完出事才查）

- **代理显示"未运行"但实际在运行** — 管理器用 `lsof` 端口检测，确保 `/usr/sbin/lsof` 可用（Node 子进程 PATH 不含 `/usr/sbin` 会误判，必须完整路径）。
- **代理启动失败** — `manage.sh logs <agent>` 看日志，或 `cd <agent>-proxy && node proxy.js` 手动启动看错误。
- **Cursor TypeScript 编译失败** — `cd cursor-proxy && npm run build 2>&1 | tee logs/cursor-build.log`。
- **忘记密码** — `rm ~/.multi-proxy-manager/password && bash manage.sh restart manager`。
- **开机自启失效** — `install.sh --autostart`；检查 `~/Library/LaunchAgents/com.multi-proxy-manager.plist`。
- **nvm 用户** — plist 自动检测 nvm 路径，仍找不到则 `nano` plist 加路径。

更多见 `docs/08-user/faq.md`。

### 反质疑（没装之前先看这三问）

- **不就是个转发 API 的中转？** — 转发那一段确实只有一路：`findProvider` 选 provider，单次 fetch，不重试。多出来的是成本记账这条旁路——报用量只贴上游原样 JSON，wire 由 manager 侧自动认（`lib/usage-probe.js`），账落 `cost-ledger.jsonl`，热路径与跨进程共用同一套公式（`cost-track.js:190-191`）。顺带把话说明白：`tests/unit/cost-track.test.js:83-91` 里的 28.7 与 `l2/README.md:153` 里的 0.06，都是喂固定 token 数算出来的，不是真实流量的实测值。
- **跟 TierFlow 那种单端口网关比，多出来的值不值？** — 先说它做了什么：本地端点是一等公民（config 里 ollama 可以直接当 primary）、PII 清洗、8 类分类路由、约 2MB 零依赖。本项目多出来的是三块：agent 的 `base_url` 所有权检测（它不碰 agent 文件，所以根本不存在这一块面）、`privacy` 档位（下游地址写死 `127.0.0.1`）、四条非侵入铁律（见第七节）。只想要省钱的那一层，用前者；要的是「本机多个 agent 一起跑、数据不出这台机器」，这才是这个项目的位置。⚠️ 顺带核一个容易记错的：TierFlow 是 **MIT** 许可，不是 AGPL（2026-10-06 核 `frdaniel76/tierflow`）。
- **本地模型路由跟云上网关差在哪？** — 在它那边，本地模型是分类表里「最便宜且干得动」那一档的首选（`categories.simple_chat.primary = ollama/llama3.2`），判据是钱；在这边，本地模型是 `privacy` 条件命中的唯一去处（见第六节），判据是数据去向，跟便宜不便宜无关。两个设计都站得住，答的是两个不同的问题，说「谁做不到谁」是错的。

---

## 十八、企业版定位（多租户 / 网关层）

个人是流量入口，企业版才是收入主体（含基于 savings-gateway 定价表的真实省钱测算与多租户缺口清单，归 Portico 企业版，内部价值主张文档不进公开仓）。一句话分工：

- **multi-proxy = 数据面**：南北向网关、难度路由省钱、failover 续跑、计量、本地一档。企业化只需要在**边界变成租户感知**（入站带 tenant/account、出账按租户归因），内核保持无状态。
- **Portico = 控制面**：租户管理、策略、审计、编排、配额、出网管控、SSO——正是企业化缺的那一大块，落在 Portico 的「三平面 + harness of harnesses」框架里。

> 当前 multi-proxy 是单用户 / 单机 / 单成本池设计；企业化的多租户、网关层部署、审计留痕等能力**不在本仓库内核**，由 Portico 企业版承载，走商业授权（见 `LICENSE-COMMERCIAL.md`），不污染 AGPL 开源版。

## 项目状态

| 里程碑 | 状态 |
|--------|------|
| L1 代理层（7 代理：codex / claude / opencode / generic-openai / hermes / cursor / dsh + 管理台 + 进程管理） | 完成 |
| L2 中台内核（10+ 模块 + 4 adapter） | 完成 |
| 所有权冲突检测（agent-owner + 切换器 + 桌面壳前置检测） | 完成 |
| DSH 接入通道（`.dsh/skills/`） | 完成 |
| Claude Code 接入（claude-proxy 18791 + 模型别名映射，174 测试 + 真机烟测通过） | 完成 |
| opencode 接入（opencode-proxy 18798，OpenAI 兼容透传 + 成本台账 + 熔断） | 完成 |
| Generic OpenAI 接入（generic-openai-proxy 18799，Cline/Aider/OpenHands 共用 OpenAI 兼容透传 + 成本台账 + 熔断 + 有界兜底） | 完成 |
| P0 安全修复（`P0-FIXES.md`：11 项） | 完成 |
| 全量测试 manager 1458 / codex 159 / claude 174 / opencode 159 / generic 177 / cursor 250 / hermes 77 / dsh 20 / l2 51 demo / shell 11 全绿（2026-10-14~15 实测） | 完成 |
| ~~交付前最后一批功能集中开发~~ | ✅ 已交付（2026-10-14 转公开 v1.1.0；此后进入持续迭代：generic failover / 文档基线重写 / 适配器计数对账） |
| 企业版（多租户 / 网关层 / 审计） | 规划中，归 Portico 控制面，未动工 |

> 对外定位：`docs/02-product/v1-positioning-declared.md` · 商业简介：`docs/02-product/business-intro.md` · 文档目录：`docs/00-codebase-map.md` · 架构：`docs/03-architecture/architecture.md` · 验收：`docs/06-test/acceptance.md`。

## License（开源版 AGPL-3.0 · 双许可）

本项目开源版采用 **GNU AGPL-3.0**（见本仓库 `LICENSE` 文件）。

**双许可说明**：AGPL-3.0 下可免费使用、修改、再分发，但任何通过网络（SaaS）对外提供服务或分发衍生作品，须同样以 AGPL-3.0 开源其全部修改。
**商业用途需单独授权**：若要将本项目用于闭源商业产品，或提供未开源的商业 SaaS 服务，请向作者获取单独的商业授权（见 `LICENSE-COMMERCIAL.md`，联系：`281330913@163.com`）。

**商业授权交付文件**：可交付的商业版授权文件见 `LICENSE-ENTERPRISE.md`（条款详情以 `LICENSE-COMMERCIAL.md` 为准，以双方签署协议生效）。

> 依赖合规：现行依赖（Express / Flask / SQLite / better-sqlite3 等）均为宽松许可，AGPL 项目引用无需修改，保留其版权声明即可。
