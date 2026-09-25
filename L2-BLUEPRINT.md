# L2 Agent 编排中枢 · 产品+技术蓝图

> 项目重定位：proxy-rebuild 从"多模型代理"升级为"Agent 编排中枢"  
> 日期：2026-09-11  
> 状态（2026-09-16）：**P0–P3 核心全 ✅**。P0 三模块收口（插件运行时 14 / Agent Adapter 4 样例 h3web 6+AIGC 10+L1chat 25 / Registry 18，7 demo 全绿）；P1 记忆服务+技能服务**内核**落地（`memory-merge.js` 11 / `skill-service.js` 13，P1.1b 生产接线是 YAGNI 且无非侵入缝）；P2 编排引擎+告警+成本分析**生产接线**落地（orchestration/shadow 门控 / `routes/alert.js` / `lib/cost-track.js` A 路埋点，jest 635/635·40 suites）；P3 文档+3 案例+性能报告（`l2/CASES.md`+`l2/PERF-REPORT.md`，数字全真跑）收口于 `e3bcded`。**遗留 P1 功能 bug（非本文档范围）**：C2 manager 转发不支 SSE（`forward.js:139` axios 15s 超时+100MB 缓冲+`res.json`）+ B7 120s 掐断长流（`codex-proxy/proxy.js:604`）——见 `l2/PERF-REPORT.md` §3，待 live 复现定夺是否修。

---

## 一、定位

### 旧定位（L1）
> 多模型代理管理工具：拦截 Agent 的模型请求，转发到合适的供应商。

### 新定位（L2）
> **Agent 编排中枢（网关+中台）**  
> 把各 Agent（Codex / Hermes / Cursor / ...）当作"员工"，统一管理它们的配置（记忆、技能、路由规则、健康状态），按任务类型自动调度到最合适的 Agent，并可视化整个团队的工作状态。

### 核心理解
- **网关**：拦截 Agent 的模型请求（已有），做协议转换和路由（已有）
- **中台**：管理 Agent 的全生命周期（Profile / 记忆 / 技能 / 健康 / 版本 / 调度）——这一层是新的
- **Agent 是员工**，项目是"大脑和调度器"，不是"路由器"

---

## 一之补、支持范围与接入原则（2026-09-25 老板明确）

> **定位澄清**：multi-proxy 的产品定位是「支持**各种 agent**，以及任何**使用大模型的项目**」，不只是当前用户个人在用的那几个。已适配（Codex / Hermes / Cursor）与未适配（如 Claude 全家桶、其它主流/小众 agent）只是**进度差异**，不是范围排除。

- **必支持范围**：Claude（含 Claude Code / Claude Desktop 等全家桶）属于未来必然支持的 agent，**现状未适配 ≠ 不在范围**——目前没接入仅因用户个人使用习惯（未把 Claude 接进来做代理），不是产品红线。
- **一等公民**：**用户自研 agent**、**用户自己开发的、使用大模型的项目**，与主流 agent 同等地位，都能通过 §4.8 的 Adapter 协议接入。
- **接入层设计硬约束（对"接入对象"的最低要求）**：
  1. **通用化**：不绑定某一家 agent 的私有效果；用统一协议（§4.8）抽象接入/卸载，任意 agent 可插拔。
  2. **低成本**：接入一个 agent 的改造量要小（MCP 零改造 / HTTP 包一层 / 用户自研实现协议），不让接入成本劝退用户。
  3. **高扩展性**：adapter 可独立启用/禁用/替换，不重启项目；新 agent 接入不改核心代码。
  4. **兼容性**：兼容不同 agent 的形态（CLI / GUI / 本地 Web 服务 / 自研进程），以及不同记忆/skill 方案（规范数据格式 + 适配器 + 无损转换，见 §4.8 互通性）。
- **用途**：本小节为后续开发迭代、以及对外写深度分析 / 营销推广文章，提供定位依据与素材。

---

## 二、四条设计原则（老板定，蓝图落地）

### ① 网关+中台架构
- **网关层**（L1 已有，增强）：API Gateway + 协议适配器（Responses↔ChatCompletions）+ 负载均衡（Failover / RoundRobin / 成本优化）+ 路由规则热插拔
- **中台层**（L2 核心，新增）：Agent Registry + 编排引擎 + 插件运行时 + 记忆服务 + 技能服务 + 健康监控
- **管理界面层**（新增）：Agent 看板（类 Marvis）+ 编排面板 + 插件市场 + 记忆/技能管理

### ② 一切皆插件（项目内部热插拔）
- **范围**：项目自身的模块可热插拔——路由规则、供应商适配器、健康检查器、UI 面板、记忆适配器
- **边界**：**绝不热插拔到 Agent 外部**（不写 `~/.codex` / `~/.hermes` 文件）
- **参考**：DeepSeek Harness（Everything is a Plugin）+ Cordis（时空可组合）
- **落地方式**：每个插件有标准接口契约，运行时加载，可单独禁用/替换

### ③ 公共+个性记忆复用
- **公共层**（全局共享）：`~/.multi-proxy-manager/shared/` — 跨 Agent 的通用配置、偏好、错误模式库
- **个性层**（per-Agent）：各 Agent 自己的 `~/.codex` / `~/.hermes` / `~/.cursor` — 项目**只读、不写**
- **注入层**（新增）：启动 Agent 时，公共+个性配置合并 → 通过**环境变量**注入 Agent 进程
- **关键**：Agent 感知不到这个中枢存在——这是"非侵入"和"记忆复用"同时成立的唯一解法

### ④ 非侵入（不碰 Agent 自身代码/文件）
- **拦截转发**：像 L1 一样，通过环境变量注入 base_url + 代理端口，不修改 Agent 的配置文件
- **记忆/技能管理**：项目自己维护一份"公共记忆"和"每个 Agent 的 profile"，启动时注入环境变量
- **绝不写回 Agent 文件**：`~/.codex` / `~/.hermes` / `~/.cursor` 是 Agent 自己的领地，项目只读
- **好处**：Agent 升级/重装/换版本，项目不受影响；项目 bug 也不会把 Agent 改崩

---

## 三、架构图（L1 → L2 演进）

```
┌─────────────────────────────────────────────────────────────────────┐
│                    管理界面层（新增 · L2）                             │
│  ┌──────────┐  ┌──────────┐  ┌─────────┐  ┌────────────────┐        │
│  │ Agent    │  │ 编排面板   │  │ 插件市场 │  │ 记忆/技能管理   │        │
│  │ 看板(Marvis│ │(任务流+依赖│  │(热插拔  │  │(公共+个性     │        │
│  │  式)     │  │  可视化)   │  │  市场)  │  │  统一视图)      │        │
│  └──────────┘  └──────────┘  └─────────┘  └────────────────┘        │
├─────────────────────────────────────────────────────────────────────┤
│                    中台层（新增 · L2 核心）                            │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Agent       │ │ 编排引擎    │ │ 插件运行时│ │ 记忆服务  │ │ 健康   │ │
│  │ Registry    │ │(拆解→路由→ │ │(热插拔,  │ │(公共+个性  │ │ 监控   │ │
│  │(Profile/    │ │ 执行→聚合) │ │ 项目内)  │ │ 注入/同步) │ │(已有)  │ │
│  │  标签/版本/  │ │            │ │          │ │           │ │(M2)   │ │
│  │  能力)       │ │            │ │          │ │           │ │        │ │
│  └────────────┘ └────────────┘ └──────────┘ └──────────┘ └────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│                    网关层（增强 · L1 基础）                            │
│  ┌──────────┐ ┌──────────────┐ ┌──────────┐ ┌────────────────┐      │
│  │ API Gateway │ │ 协议适配器   │ │ 负载均衡  │ │ 路由规则(可热插拔)│      │
│  │(已存在)    │ │(Responses↔   │ │(Failover/│ │ (类 Harness)    │      │
│  │            │ │  ChatComp)   │ │  RR/成本) │ │                │      │
│  └──────────┘ └──────────────┘ └──────────┘ └────────────────┘      │
├─────────────────────────────────────────────────────────────────────┤
│                    代理层（已有 · L1 核心）                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                           │
│  │ Codex   │  │ Hermes    │  │ Cursor    │                           │
│  │ :18790  │  │ :18793    │  │ :18794    │                           │
│  └──────────┘  └──────────┘  └──────────┘                           │
│  ↑ 拦截转发，绝不写 Agent 自身配置文件（④ 非侵入）                       │
├─────────────────────────────────────────────────────────────────────┤
│                    外部 API（已有 · L1）                               │
│  ┌────┐ ┌─────┐ ┌────────┐ ┌─────┐ ┌──────────┐                     │
│  │OpenAI│ │Anthropic│ │DeepSeek│ │Agnes│   │更多...    │             │
│  └────┘ └─────┘ └────────┘ └─────┘ └──────────┘                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四、模块清单（按"可热插拔"组织）

### 4.1 Agent Registry（Agent 注册表）
**职责**：管理所有 Agent 的 Profile、版本、能力标签、使用统计  
**状态**：缺失（0831 Phase 1）  
**依赖**：无  
**接口契约**：
```js
// 标准 Agent Profile
{
  id: string,
  name: string,
  type: 'codex' | 'hermes' | 'cursor' | 'custom',
  description: string,
  systemPrompt: string,
  toolsAllowed: string[],
  maxRounds: number,
  contextLength: number,
  costBudget: number,  // token budget
  capabilityTags: string[],  // code/writing/analysis/vision/audio
  version: string,
  createdAt: ISODate,
  updatedAt: ISODate
}
```
**非侵入实现**：Agent 启动时，项目读 Registry 里的 Profile，通过环境变量注入（`AGENT_SYSTEM_PROMPT` / `AGENT_TOOLS_ALLOWED` / ...），Agent 自身配置文件不修改。

### 4.2 编排引擎（任务拆解 + 路由 + 执行 + 聚合）
**职责**：接收复杂任务，自动拆解 → 路由到最合适的 Agent → 执行 → 聚合结果  
**状态**：缺失（0831 Phase 2）  
**依赖**：Agent Registry（4.1）  
**执行模式**：
- **串行**：子任务按依赖顺序执行
- **并行**：无依赖的子任务同时执行
- **条件分支**：根据中间结果决定下一步

**任务生命周期**：
```
用户输入 → 任务拆解(LLM) → 依赖图 → 调度器 → Agent A/B/C 并行/串行 → 结果聚合 → 最终输出
```

**路由规则**（和 L1 的路由是两层）：
- **L1 路由**：Agent 的模型请求 → 哪个供应商（已有，成本优化/故障转移）
- **L2 路由**：用户任务 → 哪个 Agent（新增，按能力标签 + 当前负载 + 成本预算匹配）

### 4.3 插件运行时（热插拔）
**职责**：项目内部模块的运行时加载、启用/禁用、版本管理  
**状态**：缺失（0831 隐含，Harness 核心）  
**依赖**：无  
**插件类型**：
- 路由规则插件（L1 + L2）
- 供应商适配器（OpenAI/Anthropic/DeepSeek/...）
- 健康检查器插件（自定义探活逻辑）
- UI 面板插件（Dashboard 可插拔卡片）
- 记忆适配器插件（不同的公共记忆后端）

**接口契约**（类 DeepSeek Harness）：
```js
// 插件标准接口
{
  id: string,
  version: string,
  type: 'route-rule' | 'provider-adapter' | 'health-checker' | 'ui-panel' | 'memory-adapter',
  enabled: boolean,
  config: object,
  load(): void,
  unload(): void,
  run(input): output
}
```

### 4.4 记忆服务（公共+个性）
**职责**：跨 Agent 的记忆复用 + per-Agent 个性化  
**状态**：部分（L1 有 providers.json，L2 需要重构）  
**依赖**：无  
**三层架构**：
1. **公共记忆**（`~/.multi-proxy-manager/shared/`）：
   - 全局错误模式库（error-patterns.json）
   - 全局路由偏好（routing-mode.json）
   - 跨 Agent 共享的配置/模板
2. **个性记忆**（各 Agent 自己的目录）：
   - `~/.codex/` / `~/.hermes/` / `~/.cursor/`
   - 项目**只读**，不写
3. **注入层**：
   - 启动 Agent 时，公共+个性合并 → 环境变量注入
   - Agent 感知不到中枢存在

### 4.5 技能服务（Skill 管理）
**职责**：管理 Agent 的能力（skill），支持 CRUD + 市场 + 版本  
**状态**：缺失  
**依赖**：Agent Registry  
**接口**：
- 标准 Skill 格式（name / description / trigger / content）
- 技能市场（预置 + 用户上传）
- 技能版本管理 + A/B 测试（可复用 content-audit 的 A/B 框架）

### 4.6 健康监控（已有 M2 + 增强）
**职责**：Agent 健康状态监控 + 告警 + 成本分析  
**状态**：部分（M2 有故障记录，缺告警+成本分析）  
**依赖**：Agent Registry  
**增强点**：
- 实时监控面板（Agent 状态 + Token 消耗 + 响应时间趋势）
- 告警机制（错误率 / 成本超预算 → 邮件/Telegram/微信）
- 熔断机制升级（连续失败 N 次 → 自动隔离 → 备用 Agent）
- 成本分析报告（每日/周/月）

### 4.7 管理界面层（Marvis 式 GUI 看板）
**职责**：可视化 Agent 团队的工作状态  
**状态**：缺失（0831 Phase 4 + 老板新提）  
**依赖**：Agent Registry + 编排引擎 + 插件运行时  
**形态**：
- **类 Marvis**：模拟"员工在办公"——每个 Agent 是一个工位，显示当前任务 / 状态 / 产出
- **编排面板**：任务依赖图 + 实时执行进度
- **插件市场**：插件卡片 + 启用/禁用 + 版本切换
- **记忆/技能管理**：统一视图 + 个性化编辑

---

### 4.8 Agent Adapter 协议（核心卖点 · 开放接入）

> **L2 区别于 CC-Switch / codex++ 的本质**：不锁定主流 agent，任何能实现本协议的 agent 都能接入/卸载（含 Claude 全家桶、用户自研 agent、任何使用大模型的项目——见「一之补、支持范围与接入原则」）。

> **接入层设计硬约束（老板 2026-09-25 明确）**：通用化 / 低成本接入 / 高扩展性 / 兼容性。即：用统一协议抽象接入，任意 agent 可插拔；接入改造量要小；adapter 可独立启停替换不重启；兼容 CLI/GUI/本地 Web 服务/自研进程等不同形态。

**职责**：定义"任意 agent 如何接入 + 卸载"的规范接口契约。   
**状态**：缺失（新增，最高优先级）   
**接口契约**：
- **任务接收**：至少支持 HTTP POST / MCP / 文件队列一种
- **结果回传**：HTTP GET / MCP response / 文件写入
- **能力声明**：adapter 启动时向 Agent Registry 注册能力标签（code / writing / vision / image / video / audio ...）
- **健康检查**：adapter 暴露 `/health` 端点（项目探活）
- **热插拔**：adapter 可独立启用/禁用/替换，不重启项目

**已覆盖的 adapter 形态**：

| Agent 类型 | 接入方式 | 改造量 |
|---|---|---|
| Codex / Cursor | MCP adapter | 零（已原生支持） |
| Hermes | MCP + HTTP | 半天（需补 MCP） |
| **h3web**（本地 Minimax H3） | HTTP adapter（已暴露 REST，包一层 adapter） | 小 |
| **AIGC 生图生视频**（FastAPI） | HTTP adapter（已暴露 REST，包一层 adapter） | 小 |
| 用户自研 agent | 实现 Adapter 协议 | 用户自理 |

> **h3web / AIGC 是 L2 开放接入的典型场景**：它们是本地 Web 服务，天然支持 HTTP 接任务；
> h3web 后面要做"agent 理解用户诉求 → 自动拆解成视频创作工作流"，正好是 4.2 编排引擎的一个用例。

**风险（互通性）**：记忆/skill 采用可替换的开源方案时，需保证数据能被不同方案解析。
对策：项目定义**规范数据格式**（记忆 YAML、skill 为 `{id, trigger, content}` 结构），各开源方案只做"适配器"，
方案互换时在规范格式上无损转换，适配器本身可热插拔。

**非业务插件（基础设施能力也是插件）**：如 zg 项目（减少 token 消耗）可作为"成本优化插件"
接入 4.3 插件运行时，作用于模型智能切换/调用场景。**用户可删除或替换**（热插拔），
这正是 ②一切皆插件 的卖点，也是 L2 的特色。


## 五、数据流（核心链路）

### 5.1 任务编排链路（L2 新增）
```
用户输入 "帮我写一个 FastAPI 服务，支持 JWT 认证 + 数据库"
  ↓
[任务拆解 LLM]
  → 子任务1: 设计 API 接口 (type=code, complexity=low)
  → 子任务2: 实现数据库模型 (type=code, complexity=medium)
  → 子任务3: 实现 JWT 认证 (type=code, complexity=medium)
  → 子任务4: 写单元测试 (type=test, complexity=low)
  → 依赖图: 1 → 2 → 3 → 4
  ↓
[L2 路由引擎]
  按 capabilityTags + 当前负载 + 成本预算 匹配 Agent
  → 子任务1 → Codex (最强编码能力, 当前空闲)
  → 子任务2 → Cursor (擅长数据库)
  → 子任务3 → Hermes (擅长认证)
  → 子任务4 → Codex (回归测试)
  ↓
[调度器]
  按依赖图串行/并行执行
  实时监控每个子任务状态
  失败 → 自动重试或降级到备用 Agent
  ↓
[结果聚合]
  聚合所有子任务结果 → 生成最终报告 (Markdown/JSON/HTML)
  → 协作历史记录 (可复盘)
```

### 5.2 记忆注入链路（非侵入实现）
```
[项目 Registry] 读取 Agent Profile + 公共记忆 + 个性记忆(只读)
  ↓
[记忆服务] 合并公共+个性配置
  → 环境变量: AGENT_SYSTEM_PROMPT / AGENT_TOOLS_ALLOWED / AGENT_MEMORY_CONTEXT / ...
  ↓
[Agent 启动器] 
  启动 Agent 进程时，注入环境变量
  → Agent 感知不到"中枢"存在，只知道自己的环境变量被设置了
  → Agent 的配置文件 ~/.codex / ~/.hermes / ~/.cursor 一点没动
  ↓
[Agent 运行]
  使用注入的环境变量 → 执行任务 → 结果回传给项目
```

---

## 六、关键风险 / 卡点（需要老板拍板）

### 6.1 Agent 间通信协议 ✓ 已讨论（2026-09-11）
**结论**：分层，不按单一方案——
| 方式 | 原理 | 侵入性 | 适合 |
|---|---|---|---|
| A. 文件队列 | 项目写 `~/.agent-queue/<agent>/<task_id>.json`，agent 轮询/启动扫描 | 最低 | 通用兜底（任意 agent） |
| B. MCP 协议 | agent 做 MCP client，项目做 MCP server | 低 | Codex/Cursor（已支持，零改造） |
| C. HTTP 回调 | 项目 POST `http://localhost:<port>/tasks/` | 中 | 本地 Web 服务（h3web/AIGC） |
**落地**：主流 agent 优先 B（MCP 零改造）；本地自研（h3web/AIGC）用 C（原生 HTTP）；通用兜底用 A。
**本质区别保留**：L1 被动接请求，L2 主动派发任务——这是项目从代理升级中枢的关键。
### 6.2 任务拆解 LLM 的选择
**问题**：任务拆解需要一个 LLM 来理解用户意图 + 生成依赖图。  
**选项**：
- 用 Agent 集群里的某个 Agent 自己来拆解（自举）
- 用外部 API（OpenAI / DeepSeek）来拆解
- 用本地模型（Qwen3.8 27B）来拆解
- **我的建议**：初期用外部 API（DeepSeek flash 最便宜），后期切换到本地（Qwen3.8 27B 已有部署）。  
**卡点**：无，可自由切换。

### 6.3 记忆注入方式 ✓ 已定（2026-09-11，分工）
**结论**：环境变量与运行时 hook 各管一层，不冲突——
- **记忆/skill 注入**（4.4）→ **环境变量**（够用，零改造）：agent 启动时设 `AGENT_MEMORY_DIR` 等，agent 读目录即可
- **任务编排**（4.2）→ **运行时 hook / API**（环境变量传不了"任务"本身）：需要 agent 暴露 hook 或 HTTP/MCP 接口
- **配置文件覆盖（B）淘汰**：违反 ④ 非侵入，不用
**分工依据**：记忆/配置是"声明式数据"→ 环境变量天然适合；任务/中间结果是"过程式数据"→ 需要 hook/API。
本地 Web 服务（h3web/AIGC）原生就是 HTTP 接口，直接用 ①的 C 方式接任务，无需额外 hook。
**问题**：如何把"公共+个性记忆"注入 Agent，且 Agent 感知不到？  
**选项**：
- A) 环境变量（最简单，Agent 不需要改造）
- B) 配置文件覆盖（侵入，违反 ④）
- C) 运行时 hook（Agent 需要暴露 hook 接口，非侵入但需要 Agent 配合）
- **我的建议**：A 环境变量 + C 运行时 hook（Agent 支持的话）。  
**卡点**：需要确认各 Agent（Codex / Hermes / Cursor）是否支持"运行时 hook"。

### 6.4 插件安全 + 互通性（2026-09-11 扩展）
**安全**：
- 插件沙箱（独立进程 / WorkerThread）· 插件签名 · 审计日志
- **初期**：只做本地插件（不开放市场），降低风险
**互通性（新增 · 对应补充 2.1）**：记忆/skill 方案可替换（x→y，或改造 x），
需保证数据被不同方案解析——对策见 4.8"风险（互通性）"：**规范数据格式 + 方案适配器 + 无损转换**。
**非业务插件（新增 · 对应补充 2.2）**：基础设施能力（成本优化/监控/日志）也是插件，
如 zg 项目接 4.3 运行时，用户可热插拔删除/替换。
## 七、实施路径（模块级，非"Phase"）

按优先级排序，每个模块**独立实施、独立测试、独立 commit**：

| 优先级 | 模块 | 工作量 | 依赖 | 交付物 | 状态 |
|--------|------|--------|------|--------|------|
| **P0** | 插件运行时框架 | 2-3 天 | 无 | 插件加载器 + 接口契约 + 示例插件（含 zg 成本优化样例） | ✅ 已落地：`plugin-runtime.js`+demo 14 checks PASS（状态机+热插拔+能力聚合，零依赖非侵入） |
| **P0** | **Agent Adapter 协议** | 2-3 天 | 插件运行时 | 任务接收/结果回传/能力声明/健康检查 契约 + Codex/Hermes/h3web/AIGC 各 1 样例 | ✅ 已收口：4 接口契约定稿 + 4 样例全跑（h3web 6 + AIGC 10 + L1 25 checks PASS）；Codex/Hermes 走 L1chat 3 分支（真 chat / discovery 退化），全 mock-first 零副作用 |
| **P0** | Agent Registry | 1-2 天 | 插件运行时 | Agent Profile CRUD API + 能力标签注册 | ✅ 已落地：`agent-registry.js`+demo 18 checks PASS + 接 manager HTTP API（jest 12/12 + :18792 真跑 200/401） |
| **P1** | 记忆服务（公共+个性+环境变量注入） | 2 天 | Agent Registry | 记忆合并 + 规范数据格式 + 方案适配器 + 环境变量注入 | ⚠️ **P1.1a 落地**：规范格式+互通性（`specs/agent-memory` node/py 两侧 PASS）+ **合并/适配器/注入内核 `l2/memory-merge.js`**（merge 公共+个性·冲突策略 personal/shared/error + envInject 非侵入投影 `AGENT_SYSTEM_PROMPT/ERROR_PATTERNS/TOOLS_ALLOWED/CONFIG/MEMORY_CONTEXT` + 可热插拔 scheme 适配器 json/yaml-text/view，demo 11/11、jest 14/14、规范 validate ALL PASS，manager jest 570/570）；**剩 P1.1b**：agent 启动注 env 接线 + 持久化（暂无非侵入接入缝，列后续） |
| **P1** | 技能服务（含互通性） | 2 天 | Agent Registry | Skill CRUD + 版本 + 规范格式适配 | ✅ **P1.1b 落地**：`l2/skill-service.js`（Skill CRUD + 版本管理 bump/rollback + 市场 registerBuiltin/upload + 规范格式适配 json/yaml-text/view + 热插拔适配器，demo 13/13、jest 13/13、规范 `specs/skill` validate ALL PASS，manager jest 583/583）；**剩 P1.1b**：生产接线（API 路由 + 持久化 store）列后续（YAGNI，无非侵入接入缝） |
| **P2** | 编排引擎（任务拆解+路由+执行+聚合） | 5-7 天 | Agent Registry + 记忆服务 + Adapter | 编排 API + 5 用例（含 h3web 视频工作流） | ✅ 落地：`l2/orchestrator.js`+`decomposer.js`（拆解+调度+容错+聚合+协作历史，19+16=35 checks PASS）+ `/api/orchestration` 生产接线（`routes/orchestration.js`，门控 `PROXY_ORCHESTRATION` 默认关/shadow 默认开，manager jest 546/546）；**P2.2 LLM 拆解已落地**（`l2/llm-decomposer.js` `makeLlmDecomposer` 填 `decomposer.js` 预留缝：可注入 OpenAI-兼容 http 传输 + DAG 解析/环复算/全路径降级回 template，19 checks PASS；`routes/orchestration.js` 门控 `PROXY_LLM_DECOMPOSE` 默认关，接 LLM 拆解路径，manager jest 556/556） |
| **P2** | 健康监控增强（告警+成本分析） | 2-3 天 | Agent Registry | 告警服务 + 成本报告 | ✅ **告警内核 `l2/alert.js`** + ✅ **成本分析内核 `l2/cost.js`（B 路余额趋势，2026-09-15 补完）**：告警 4 规则 + cooldown 去重 + 可插拔 sink + 非侵入（不写 providers.json/不触路由/不落盘）；成本分析 `createCostService()` 余额快照→消费额→报告 + 信号喂 alert.js `cost-budget-exceeded`（端到端 test 实证，B 路零热路径、A 路 token×单价 信号源无关、`PROXY_COST_TRACK` 门控默认 observe 不写盘）。demo 13+14/13+16=33、全量 jest 620/620（39 suites，+8 alert-route 零回归）+ l2 七 demo 全绿。✅ **告警生产接线 `routes/alert.js`（/api/alert，门控 PROXY_HEALTH_ALERT 默认 403，2026-09-15）**：三信号源（provider-health / error-patterns / cost）拉式→`alertSvc.emit`，零热路径、非侵入，live 冒烟 403/200 实证，jest +8 零回归。✅ **cost 信号源接线（2026-09-18 完成）**：`routes/alert.js` 第 3 路读 `cost-track.getAll()`（A 路 token×单价累计 × `PROXY_COST_BUDGET` 全局/`PROXY_COST_BUDGET_<PROXY>` per-proxy 预算，cost≥budget→`cost-budget-exceeded` 事件，无预算=不触发 YAGNI 正确）；定时 scheduler 门控 `PROXY_COST_SCHEDULE`（默认关=不建 timer，unref=不阻塞退出，可清=clearInterval）+ server.js 启动调用。零热路径、非侵入，jest +17 全零回归（**635→644/644·40 suites**）。 |
| **P3** | 文档 + 案例 + 性能测试 | 1 周 | 全部 | README / ARCHITECTURE / 3 案例 / 测试报告 | ✅ **已落地（2026-09-16）**：`l2/CASES.md` 3 案例（① 编排视频 orchestrator 16+decomposer 19+llm-decomposer 19 / ② 告警 alert 13 / ③ 成本 cost 14 + A 路 token×单价 live 0.06/28.7）+ `l2/PERF-REPORT.md`（appendLog O(n²) review C1 已修 `f19aeb6` 计数触发裁剪，实测旧 1670→40157ms vs 新 131→2216ms = 12.8×→19.8× 加速 N=5k→100k + 开放性能项 C2/B7/rr_index 诚实标注）；数字全部 demo/live 真跑，非纸面；jest 635/635·40 suites + l2 七 demo + 3 adapter + specs validate 全绿。 |
| **P5（可选）** | Marvis 式 GUI 看板（锦上添花） | 3-5 天 | 编排引擎 | Electron 壳 + 前端组件 | 未开始，可延后 |
| **P5（可选）** | 编排面板 + 插件市场 UI | 2-3 天 | 编排引擎 + 插件运行时 | 任务流可视化 + 插件卡片 | 未开始，可延后 |

**总工期**：核心 P0-P3 约 4-5 周；Marvis GUI 是锦上添花，可延后到 P3 之后或不做（老板定）。

## 八、与 0831 规划的对照

| 0831 规划 | L2 蓝图 | 差异 |
|-----------|---------|------|
| Phase 1: Agent 配置管理 | Agent Registry + 记忆服务 + 技能服务 | 拆成 3 个独立模块，加了"记忆注入"和"非侵入"约束 |
| Phase 2: 多Agent协作 | 编排引擎 | 保留了，但加了"非侵入实现"和"插件化路由规则" |
| Phase 3: 健康监控 | 健康监控增强 | 保留了，M2 已有基础，只需加"告警+成本分析" |
| Phase 4: 文档/案例 | 保留 | 没变 |
| （隐含）插件化 | 插件运行时（P0） | 新增，类 DeepSeek Harness |
| （新提）Marvis GUI | Marvis 式看板（P3） | 新增，老板今天提的 |

---

## 九、决策记录（2026-09-11 已与老板对齐）

| # | 议题 | 结论 |
|---|------|------|
| 1 | 6.1 Agent 间通信协议 | **分层**：主流用 MCP（B），本地 Web 服务用 HTTP（C），通用兜底文件队列（A） |
| 2 | 6.3 记忆注入 | **分工**：记忆/skill 用环境变量（零改造），任务编排用运行时 hook/API |
| 3 | Marvis GUI | **锦上添花**，降为可选 P5，可延后或不做 |
| 4 | 开放接入（补充 1） | 新增 **4.8 Agent Adapter 协议**，支持 h3web/AIGC/用户自研 agent 接入，是 L2 核心卖点 |
| 5 | 记忆互通（补充 2.1） | **规范数据格式 + 方案适配器 + 无损转换**，方案可热替换 |
| 6 | 非业务插件（补充 2.2） | 成本优化(zg)/监控/日志等基础设施能力皆插件，可热插拔删除/替换 |

**待实施前确认**：
1. P0 三个模块先后顺序（插件运行时 → Agent Adapter 协议 → Agent Registry）是否认可
2. 记忆/skill 规范数据格式的具体 schema（YAML? JSON? 字段定义）—— 这是互通性的地基
3. h3web / AIGC 的 adapter 是否要在新会话先做 1 个端到端样例验证协议可行性

**确认后再动手，不擅自实施。**
---

*最后更新：2026-09-11 v2（决策对齐）→ 2026-09-13 Hermes 补充：M6 方向四 / M2 健康增强 已闭环；L2 P0-P3 待排期，确认后再动手 → 2026-09-15 P1.1a 记忆服务内核 + P1.1b 技能服务内核落地，P2/P3-a/b 已收口 → 2026-09-16 方向五 P3 文档+案例+性能报告落地（`l2/CASES.md` 3 案例 + `l2/PERF-REPORT.md`，数字全部真跑）*
---

## 方向六 P1-P3 实施状态（2026-09-14）

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P1 worktree 隔离** | `lib/worktree-manager.js` + 测试 | ✅ 已落地 commit `f99111f`（522/522 全绿，真 git 往返） |
| **P2 Paseo 安装验证** | `brew install --cask paseo` + daemon 探针 | ✅ 已验证 2026-09-14：Paseo 0.8.0 装上，daemon 起于 127.0.0.1:6767（PID 86062），Codex provider available（Claude not found）。daemon relay disabled（安全模式） |
| **P3-a 设计草案** | `l2/p3-sessions-checkpoint-design.md` | ✅ 已落盘 commit `58d30da`（checkpoint schema + tmux-keepalive 原语 + 崩溃恢复流程 + 与 P1 协同） |
| **P3-b tmux-keepalive 实现** | `lib/tmux-keepalive.js` + 测试 | ✅ 已落地 `lib/tmux-keepalive.js` + `tests/unit/tmux-keepalive.test.js`（10/10 全绿，真 tmux 3.7c 往返 + 注入假 binary 覆盖 not-found 降级；per-binary 可用性守卫；m7- 前缀隔离自有 session 不碰用户） |
| **P3-c session-store 接入** | `lib/session-keepalive.js` 胶水层 + 测试 | ✅ 已落地 `9641925`：`bindSessionKeepalive`（起 tmux + 写 checkpoint）/ `resumeSessionKeepalive`（从 checkpoint 读 tmux 名 + 崩溃重建）；非侵入（不碰 session-store 热路径，opt-in）；6/6 全绿，真 SessionStore+TmuxKeepalive 联调 |
| **P3-d 崩溃恢复 e2e** | 杀进程 → 重启 → 续跑 | ✅ 已落地 `754fedd`：`tests/unit/p3d-crash-recovery.test.js` 2/2 全绿（进程级：bind→kill tmux+旧store释放→新store从sessions.json加载→从checkpoint重建tmux→二次崩溃循环） |

**Paseo 验证结论（P2）**：Paseo 已能管本地 agent（Codex available），daemon 模式跑通。P3-b 是否自研 tmux 保活，取决于 Paseo 的保活能力是否满足需求——Paseo 自带 daemon + 多端监工，可能可直接借用，不必自研。建议老板决定：**P3-b 继续自研 or 直接用 Paseo 原生能力**。
