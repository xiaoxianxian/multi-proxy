# Proxy Rebuild — 多 Agent 编排中枢（L2）

> **一句话定位**：把 Codex / Hermes / Cursor 等 AI 编程代理当作「员工」，统一管理它们的配置（记忆、技能、路由规则、健康状态），把任务自动调度到最合适的代理，并在 Web 界面看清整个团队的运行状态。

本项目在 L1「多模型代理管理」基础上升级为 **L2：Agent 编排中枢（网关 + 中台）**。

---

## 一、架构总览：网关 + 中台

```
┌──────────────────────────────────────────────────────────┐
│  管理界面层（L2·新增）                                      │
│   Web 管理台 (18792) · 代理看板 · 日志 · 健康 · 配置 · 登录   │
├──────────────────────────────────────────────────────────┤
│  中台层（L2·核心）                                          │
│   10 能力内核：Agent Registry · 编排引擎 · 路由引擎(含影子)    │
│   插件运行时 · 拆解器(LLM/规则) · 记忆服务 · 技能服务 · 告警 · 成本│
│   3 适配器（非侵入）：codex · h3web · hermes-proxy          │
├──────────────────────────────────────────────────────────┤
│  网关层（L1·增强）                                          │
│  API 网关 · 协议转换(Responses↔ChatCompletions)             │
│  负载均衡(Failover/RoundRobin/成本优化) · 路由热插拔          │
├──────────────────────────────────────────────────────────┤
│  代理层（L1·核心）                                          │
│  Codex Proxy (18790) · Hermes Proxy (18793) · Cursor Proxy │
│   (18794) · manage.sh 进程管理（非侵入：只读各 Agent 配置）    │
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

10 个能力内核模块（`l2/*.js`），每个配一个 E2E demo（`l2/*.demo.js`，共 182 checks 全绿、真跑）：

| 内核模块 | 能力 |
|----------|------|
| `agent-registry` | Agent 注册中枢：Profile / 标签 / 能力 / 健康 / 版本 |
| `orchestrator` | 编排引擎：任务拆解 → 路由 → 执行 → 结果聚合 |
| `route-engine` | 路由引擎 + shadow 影子模式（默认只记日志、不改真实路由） |
| `decomposer` / `llm-decomposer` | 任务拆解：规则拆解 / LLM 拆解子能力 |
| `plugin-runtime` | 一切皆插件：路由规则、适配器、健康检查器、UI 面板运行时加载 |
| `memory-merge` | 记忆服务：公共层（跨 Agent）+ 个性层（per-Agent），经环境变量注入 |
| `skill-service` | 技能服务：跨 Agent 技能复用 |
| `alert` | 健康告警 |
| `cost` | 成本跟踪 |

**3 个适配器（非侵入）**：`codex` / `h3web` / `hermes-proxy`——按 `l2/adapter-protocol.md` 开放协议接入，下游 Agent 只读、绝不写回。

---

## 四、管理面板功能（Web 18792）

- **概览页** — 实时显示三个代理运行状态（运行中/未运行/未安装）+ 版本信息 + 一键启停 + 自动刷新（5/10/30/60 秒）+ 移动端适配
- **日志页** — 全代理日志聚合、多维过滤（类型/级别/关键词/时间）、复制/导出 TXT/CSV/清空
- **代理配置页** — 供应商 CRUD、模型切换、账户余额查询、切换历史、路由模式（Failover / Round Robin）
- **登录页** — 首次密码引导（强度指示）、失败 5 次锁 15 分钟、JWT + bcrypt

### 代理能力详述

- **Codex Proxy** — 上游模型转发（DeepSeek / Moonshot / Agnes AI）、`/v1/models`、`/health`、供应商状态、路由模式、切换历史、余额查询、流式传输
- **Hermes Proxy** — YAML 配置解析、`/api/switch-model`、路由模式、健康检查、余额查询、切换历史
- **Cursor Proxy** — 5 类供应商适配器（OpenAI Compatible / Anthropic / Gemini / Ollama / Generic）、SQLite 持久化、三种路由策略、熔断器、令牌桶限流、流式翻译、AES-256-GCM 加密 API Key

---

## 五、四条非侵入铁律（贯穿全项目）

| 铁律 | 含义 |
|------|------|
| **不写 Agent 文件** | 对下游 Agent 只读，绝不写 `~/.codex` / `~/.hermes` 等 |
| **不注入全局 env** | 不执行 `launchctl setenv` / `export` 到全局；env 走 plist 局部配置 |
| **不写死端口** | 各 Agent 端口动态探测（如 h3web 8731↔8732 实测漂移） |
| **门控默认关 / shadow 默认开** | 新增能力默认 `gate: closed` 或 `shadow: true`，不改变现有行为 |

> **NO_PROXY 铁律**：全局 launchd 绝不注入裸 `*` 通配——HTTP 客户端按逗号拆项做 `hostname.endsWith(项)`，`*` 去通配符后为空串会使 `endsWith('')` 恒真、所有请求绕过系统代理（曾把 WorkBuddy、CC Switch 全部带崩）。仅在代理自身 plist 的 `<EnvironmentVariables>` 内放 `127.0.0.1,localhost,::1`。

---

## 六、安全机制

- **认证鉴权** — JWT + bcrypt 密码哈希，首次访问引导设置
- **进程沙箱** — spawn 路径/命令白名单校验，防命令注入
- **API 转发白名单** — 精确控制每个代理允许的端点与方法
- **速率限制** — 登录双重限流，防暴力破解
- **CSP / CORS** — 内容安全策略防 XSS、限制跨域来源
- **错误脱敏** — 生产环境不暴露堆栈和内部细节
- **密钥加密** — Cursor 代理 AES-256-GCM 加密 API Key

---

## 七、模型代理切换工具（agent-proxy-switch）

当 proxy-rebuild 正在修 bug、暂时用不了时，把某个 agent 退回其它方式；修好后切回来。为避免「两套代理同时拥有同一个 agent 的 base_url 而打架」，提供统一切换器 `tools/agent-proxy-switch`。

**设计铁律**：单一所有者（每 agent 的 base_url 同一时刻只指向一个代理）· 绝不污染全局环境（只改各 agent 自己的配置，绝不 `launchctl setenv NO_PROXY`）· 不误伤其它 agent（切 codex 只动 codex）· 不死链（切前确认端口在监听）。

| agent | proxy-rebuild 端口 | 另一候选 | 切换 |
|-------|-------------------|----------|------|
| codex | 18790 | cc-switch (15721) | 全自动 |
| hermes | 18793 | direct（直连 agnes 真实地址） | 全自动 |
| cursor | 18794 | direct（清空 Cursor 自带 base） | 半自动 |

```bash
bash tools/agent-proxy-switch                    # 状态总览
bash tools/agent-proxy-switch <agent>            # 单 agent 状态
bash tools/agent-proxy-switch <agent> <owner>    # 切换（proxy-rebuild / direct / cc-switch）
```
> 卸载/停止「当前正在代理某 agent 的代理工具」前，务必先用本工具把该 agent 切到另一所有者，否则 agent 会指向死端口断连。

---

## 八、DSH 生态接入

`.dsh/skills/` 注册两个 Skill，使 DSH（Declarative Skill Hub）生态的 Agent 能加载本项目：

| DSH Skill | 用途 |
|-----------|------|
| `l2-orchestrator` | 面向 L2 内核（10 模块 + 4 守卫 + demo 流程）的开发指南 |
| `multi-proxy` | 项目操作入口：3 代理端口、诊断、管理台、4 守卫、全套测试 |

详见 `ITERATION-ROADMAP.md` 的 DSH 接入规划。

---

## 九、快速开始

```bash
# 安装依赖
bash install.sh --all

# 编辑各代理 .env 配置 API Key
nano codex-proxy/.env
nano hermes-proxy/.env
nano cursor-proxy/.env

# 启动 / 状态
bash manage.sh start
bash manage.sh status
# 管理面板 → http://127.0.0.1:18792
```

**常用命令**：`manage.sh {start|stop|restart|status}` · `manage.sh logs {all|codex|hermes|cursor|manager}` · 单服务 `manage.sh <agent> {start|stop|restart}` · 自启 `install.sh --autostart`。

**前置**：Node.js 20+（cursor-proxy 的 TypeScript 测试需 Node 24 + ESM runner）。

---

## 十、测试与验收（当前 882/882 全绿）

| 模块 | 命令 | 结果 |
|------|------|------|
| multi-proxy-manager | `cd multi-proxy-manager && npx jest --silent --forceExit` | 635/635（40 suites） |
| codex-proxy | `cd codex-proxy && npx jest --silent --forceExit` | 53/53（3 suites） |
| cursor-proxy | `cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --forceExit` | 131/131（11 suites） |
| hermes-proxy | `/usr/bin/python3 -m pytest tests/ -q` | 63/63 |
| **L2 demo** | `for f in l2/*.demo.js; do node "$f"; done` | 10/10 跑通（~182 checks） |

完整验收（4/4 服务健康、DSH Skill、桌面壳）：见 `docs/09-review/consistency-report.md`。

---

## 十一、目录结构

```
multi-proxy/
├── multi-proxy-manager/       # Web 后台 + L2 内核 + Electron 桌面壳
│    ├── src/                  # 后端 server.js / routes / lib
│    ├── public/               # 前端页面
│    └── test/                 # Jest 测试
├── codex-proxy/            # Node.js 代理（18790）
├── hermes-proxy/           # Python/Flask 代理（18793）
├── cursor-proxy/           # TypeScript/SQLite 代理（18794）
├── l2/                        # L2 编排中枢：内核 + 3 adapter + 10 demo + 文档
│    ├── *.demo.js              # 10 个 E2E demo
│    ├── adapter-protocol.md    # 开放接入协议
│    └── CASES.md / PERF-REPORT.md
├── multi-proxy-adapter/     # Agent 适配器：codex / h3web
├── .dsh/skills/             # DSH 生态 Skill
├── docs/                    # 结构化文档（INDEX / 架构 / 部署 / 评审）
├── ITERATION-ROADMAP.md     # 长期规划 + DSH 接入
├── L2-BLUEPRINT.md          # 网关+中台设计蓝图
└── manage.sh                # 进程管理（非侵入）
```

---

## 十二、已知问题与待修复

### #1 〔历史·已规避〕裸 `*` 污染全局 NO_PROXY
旧版 `codex-multi-model-proxy-deploy` 的 `install.sh` 含 `launchctl setenv no_proxy "127.0.0.1,localhost,*"`，使所有走系统代理的 GUI 应用直连被墙 IP → `ETIMEDOUT`。当前 `proxy-rebuild` 源码已无此写法（autostart plist 仅设 `PATH`），修复写法 `*` → `::1`。

### #2 〔当前〕`install.sh --uninstall` 卸载不完整
卸载只删 `com.multi-proxy-manager.plist`，不清理早期遗留的 `com.codex.*` / `com.xiaoxian.*` LaunchAgents。修复：卸载时扫描移除已知 plist 集合，或统一单一命名。

### #3 〔设计〕缺少「单一所有者」保护
无机制防止 proxy-rebuild 与 cc-switch 同时把同一 agent 的 base_url 指向自己。已用 `tools/agent-proxy-switch` 提供安全切换（见第七节）。

---

## 十三、常见问题

- **代理显示"未运行"但实际在运行** — 管理器用 `lsof` 端口检测，确保 `/usr/sbin/lsof` 可用（Node 子进程 PATH 不含 `/usr/sbin` 会误判，必须完整路径）。
- **代理启动失败** — `manage.sh logs <agent>` 看日志，或 `cd <agent>-proxy && node proxy.js` 手动启动看错误。
- **Cursor TypeScript 编译失败** — `cd cursor-proxy && npm run build 2>&1 | tee logs/cursor-build.log`。
- **忘记密码** — `rm ~/.multi-proxy-manager/password && bash manage.sh restart manager`。
- **开机自启失效** — `install.sh --autostart`；检查 `~/Library/LaunchAgents/com.multi-proxy-manager.plist`。
- **nvm 用户** — plist 自动检测 nvm 路径，仍找不到则 `nano` plist 加路径。

---

## 项目状态

| 里程碑 | 状态 |
|--------|------|
| L1 代理层（3 代理 + 管理台 + 进程管理） | 完成 |
| L2 中台内核（10 模块 + 4 守卫 + 3 adapter） | 完成 |
| DSH 接入通道（`.dsh/skills/`） | 完成 |
| P0 安全修复（`P0-FIXES.md`：11 项） | 完成 |
| 全量测试 882/882 + L2 demo 182 checks 全绿 | 完成 |

> 设计蓝图 `L2-BLUEPRINT.md` · 文档总入口 `docs/INDEX.md` · 长期规划 `ITERATION-ROADMAP.md` · 验收报告 `docs/09-review/consistency-report.md`。

## License

Internal use only.
