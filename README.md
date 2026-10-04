# Multi-Proxy — 多 Agent 编排中枢（L2）

> **一句话定位：把 Codex / Hermes / Cursor 等 AI 编程代理当作「员工」，统一管住它们的配置、记忆、技能与健康，把任务调度到最合适的代理上——不是再做一个模型切换器，切的是「活」，不是「模型」。**
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
| 本地模型 / 本地视频产线（MiniMax H3）也要当「员工」调度 | **4 个适配器**：codex·hermes / h3web / aigc / claude，只读接入、绝不写回（第五节） |
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
│   4 适配器（非侵入）：codex·hermes · h3web · aigc · claude  │
├──────────────────────────────────────────────────────────┤
│  网关层（L1·增强）                                          │
│  API 网关 · 协议转换(Responses↔ChatCompletions)            │
│  负载均衡(Failover/RoundRobin/成本优化) · 路由热插拔          │
├──────────────────────────────────────────────────────────┤
│  代理层（L1·核心）                                          │
│  Codex Proxy (18790) · Hermes Proxy (18793) · Cursor Proxy │
│   (18794) · manage.sh 进程管理（非侵入：只读各 Agent 配置）   │
└──────────────────────────────────────────────────────────┘
```

**核心思想**：网关拦截各 Agent 的模型请求做协议转换与路由；中台把 Agent 的「全生命周期」（Profile / 记忆 / 技能 / 健康 / 调度）统一起来。Agent 全程感知不到中枢存在——这是「非侵入」与「记忆复用」同时成立的前提。

---

## 二、代理层与网关层（L1）

| 模块 | 技术栈 | 端口 | 说明 |
|------|--------|------|------|
| `multi-proxy-manager/` | Node.js + Express + Electron 桌面壳 | 18792 | Web 管理界面（前端 + 后端 + L2 内核） |
| `codex-proxy/` | Node.js + Express | 18790 | Codex CLI 代理 |
| `hermes-proxy/` | Python + Flask | 18793 | Hermes Agent 代理 |
| `cursor-proxy/` | TypeScript + Express + SQLite | 18794 | Cursor IDE 代理 |

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

**4 个适配器（非侵入）**：`l1-agent`（codex-proxy / hermes-proxy）· `h3web`（本地 MiniMax H3 视频产线）· `aigc`（本地 AIGC 服务）· `claude`——按 `l2/adapter-protocol.md` 开放协议接入，下游 Agent 只读、绝不写回。

---

## 四、管理面板功能（Web 18792）

- **概览页** — 实时显示三个代理运行状态（运行中/未运行/未安装）+ 版本信息 + 一键启停 + 自动刷新（5/10/30/60 秒）+ 移动端适配
- **日志页** — 全代理日志聚合、多维过滤（类型/级别/关键词/时间）、复制/导出 TXT/CSV/清空
- **代理配置页** — 供应商 CRUD、模型切换、账户余额查询、切换历史、路由模式（Failover / Round Robin）
- **登录页** — 首次密码引导（强度指示）、失败 5 次锁 15 分钟、JWT + bcrypt

### 代理能力详述

- **Codex Proxy** — 上游模型转发（多供应商）、`/v1/models`、`/health`、供应商状态、路由模式、切换历史、余额查询、流式传输
- **Hermes Proxy** — YAML 配置解析、`/api/switch-model`、路由模式、健康检查、余额查询、切换历史
- **Cursor Proxy** — 5 类供应商适配器（OpenAI Compatible / Anthropic / Gemini / Ollama / Generic）、SQLite 持久化、三种路由策略、熔断器、令牌桶限流、流式翻译、AES-256-GCM 加密 API Key

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

（本地视频产线那一类走的是另一条路，走第四节的 4 个适配器，不在这张路由表里。）

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

```bash
# 安装依赖（自动从 .env.example 生成各代理 .env）
bash install.sh --all

# 编辑各代理 .env 配置 API Key
nano codex-proxy/.env
nano cursor-proxy/.env
# Hermes 用 YAML：cp hermes-proxy/config.yaml.example hermes-proxy/config.yaml 后编辑

# 启动 / 状态
bash manage.sh start
bash manage.sh status
# 管理面板 → http://127.0.0.1:18792
```

**常用命令**：`manage.sh {start|stop|restart|status}` · `manage.sh logs {all|codex|hermes|cursor|manager}` · 单服务 `manage.sh <agent> {start|stop|restart}` · 自启 `install.sh --autostart` · 桌面壳 `desktop/`（Electron，壳 = 启动器 + 窗口，业务代码不进 .app）。

**前置**：macOS + Node.js 20+（cursor-proxy 的 TypeScript 测试需 Node 24 + ESM runner）；`lsof` 走 `/usr/sbin/lsof` 绝对路径（Node 子进程 PATH 不含 `/usr/sbin` 会误判，ADR-0001）。

完整上手流程见 `docs/quickstart.md`；验收口径见 `docs/06-test/acceptance.md`。

---

## 十一、3 分钟演示

```bash
bash scripts/demo-tour.sh          # 全量（含测试基线，约 3 分钟）
bash scripts/demo-tour.sh --quick  # 只看 demo 不跑测试（约 30 秒）
```

脚本零副作用：L2 demo 默认影子模式、历史写 `os.tmpdir()`、绝不写任何 agent 文件。

---

## 十二、测试与验收（1180+11 全绿 · 2026-09-28 真跑）

| 模块 | 命令 | 结果 |
|------|------|------|
| multi-proxy-manager | `cd multi-proxy-manager && npx jest --silent --forceExit` | 822/822（50 suites） |
| codex-proxy | `cd codex-proxy && npx jest --silent --forceExit` | 62/62（6 suites） |
| cursor-proxy | `cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --silent --forceExit` | 219/219（17 suites） |
| hermes-proxy | `cd hermes-proxy && python3 -m pytest tests/ -q` | 77/77（4 files） |
| **L2 demo** | `find l2 -name '*.demo.js' -print0 \| xargs -0 -n1 node` | 29/29 脚本跑通 |
| shell (bats) | `cd tests/shell && bats *.bats` | 11/11（CI 无 bats 时走 `check.sh` 零依赖回退） |

历史修复记录见 `P0-FIXES.md`（11 项 P0）；完整验收判据见 `docs/06-test/acceptance.md`。

---

## 十三、目录结构

```
multi-proxy/
├── multi-proxy-manager/       # Web 后台 + L2 内核调用 + agent-owner 冲突检测
│    ├── lib/agent-owner.js    # 所有权冲突检测（base_url 实指向，非端口）
│    ├── src/                  # 后端 server.js / routes / lib
│    ├── public/               # 前端页面
│    └── tests/                # Jest 测试
├── codex-proxy/               # Node.js 代理（18790）
├── hermes-proxy/              # Python/Flask 代理（18793）
├── cursor-proxy/              # TypeScript/SQLite 代理（18794）
├── desktop/                   # Electron 桌面壳（启动器 + 窗口）
├── l2/                        # L2 编排中枢：10+ 内核 + 4 adapter + 29 demo
│    ├── adapters/             # codex·hermes / h3web / aigc / claude 适配器
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

## 十四、已知问题与待修复

### #1 〔历史·已规避〕裸 `*` 污染全局 NO_PROXY
旧版部署脚本含 `launchctl setenv no_proxy "127.0.0.1,localhost,*"`，使所有走系统代理的 GUI 应用直连超时。当前源码已无此写法（autostart plist 仅设 `PATH` + 代理自身局部 env），修复写法 `*` → `::1`。

### #2 〔当前〕`install.sh --uninstall` 卸载不完整
卸载只删 `com.multi-proxy-manager.plist`，不清理早期遗留的 `com.codex.*` 等 LaunchAgents。修复：卸载时扫描移除已知 plist 集合，或统一单一命名。

### #3 〔设计〕「单一所有者」机制
无机制天然防止 proxy 与 cc-switch 同时认领同一 agent 的 base_url。已用 `tools/agent-proxy-switch` + `lib/agent-owner.js` 提供结构化防护（见第五节），桌面壳开壳前强制检测。

---

## 十五、常见问题

- **代理显示"未运行"但实际在运行** — 管理器用 `lsof` 端口检测，确保 `/usr/sbin/lsof` 可用（Node 子进程 PATH 不含 `/usr/sbin` 会误判，必须完整路径）。
- **代理启动失败** — `manage.sh logs <agent>` 看日志，或 `cd <agent>-proxy && node proxy.js` 手动启动看错误。
- **Cursor TypeScript 编译失败** — `cd cursor-proxy && npm run build 2>&1 | tee logs/cursor-build.log`。
- **忘记密码** — `rm ~/.multi-proxy-manager/password && bash manage.sh restart manager`。
- **开机自启失效** — `install.sh --autostart`；检查 `~/Library/LaunchAgents/com.multi-proxy-manager.plist`。
- **nvm 用户** — plist 自动检测 nvm 路径，仍找不到则 `nano` plist 加路径。

更多见 `docs/08-user/faq.md`。

---

## 项目状态

| 里程碑 | 状态 |
|--------|------|
| L1 代理层（3 代理 + 管理台 + 进程管理） | 完成 |
| L2 中台内核（10+ 模块 + 4 adapter） | 完成 |
| 所有权冲突检测（agent-owner + 切换器 + 桌面壳前置检测） | 完成 |
| DSH 接入通道（`.dsh/skills/`） | 完成 |
| P0 安全修复（`P0-FIXES.md`：11 项） | 完成 |
| 全量测试 1180 + bats 11 + L2 demo 29 全绿（2026-09-28 真跑） | 完成 |

> 对外定位：`docs/02-product/v1-positioning-declared.md` · 商业简介：`docs/02-product/business-intro.md` · 文档目录：`docs/00-codebase-map.md` · 架构：`docs/03-architecture/architecture.md` · 验收：`docs/06-test/acceptance.md`。

## License（开源版 AGPL-3.0 · 双许可）

本项目开源版采用 **GNU AGPL-3.0**（见本仓库 `LICENSE` 文件）。

**双许可说明**：AGPL-3.0 下可免费使用、修改、再分发，但任何通过网络（SaaS）对外提供服务或分发衍生作品，须同样以 AGPL-3.0 开源其全部修改。
**商业用途需单独授权**：若要将本项目用于闭源商业产品，或提供未开源的商业 SaaS 服务，请向作者获取单独的商业授权（见 `LICENSE-COMMERCIAL.md`，联系：`281330913@163.com`）。

> 依赖合规：现行依赖（Express / Flask / SQLite / better-sqlite3 等）均为宽松许可，AGPL 项目引用无需修改，保留其版权声明即可。
