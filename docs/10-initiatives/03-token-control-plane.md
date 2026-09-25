# multi-proxy Token-Control-Plane 设计文档（03）

> 来源：2026-09-26 与用户的多轮讨论（Graft 核验 → zg 核验 → token 节省环节地图 → 架构决策 → 竞品研判）。
> 用途：落码前的方案文档，供后续迭代直接读取推进。**设计不写实现代码**。
> 核心论点：multi-proxy 应做"代理原生 token 控制平面 + 多 agent 编排脑 + 按 agent 类型可选启用的 curated 场景包"，不下沉重造引擎。
> 诚实标注：本文引用的外部 benchmark 多数未经本仓独立复现，已逐条标"验证状态"。

---

## 0. 缘起与已拍板结论（一页速览）

讨论起点：用户发现 Graft（coding-agent 代码库上下文引擎），问能否让 multi-proxy 编排层更健壮 + 省 token。经核验，结论收敛为：

1. **Graft / zg 救不了编排层健壮性**（那是 L2 自己的 bug，见 `02-L2热路径改造计划.md`），但能成为"编排出去的 agent 的上下文加速引擎"。
2. **token 节省的核心价值不在"重造引擎"，在"代理原生层"**（只有站在请求路径中枢才做得了的事）。
3. **架构决策（用户拍板）**：token-control-plane 采用 **"核心通用层 + 可选场景包(pack)"** 形态，**curated 不 crowdsource、不做开放平台**；扩展面（稳定 hook 接口）与分发面（bundled + 索引）解耦。
4. **竞品研判（本文 §4 新增）**：通用网关层已被 LiteLLM 压住、代理原生压缩层已有先行者（Context Gateway / LiteLLM server-side compression）→ multi-proxy 的真正 wedge = **编排脑 + 按 agent 类型场景包 + AIGC 成本管控一等公民**。

---

## 1. 问题定义：agentic 任务的 token 浪费全景

> 注意：本节覆盖**通用 agent 场景**（coding / AIGC 生图生视频 / 通用对话 / 研究检索），不限于 coding。

### 1.1 浪费层级地图（8 层 + 2 场景专属 + 编排独占）

| # | 浪费环节 | 机制 | 开源参考（验证状态） | multi-proxy 落点 |
|---|---|---|---|---|
| 1 | 系统提示词 / 工具 schema 每请求重发 | 重复塞满上下文 | prompt caching（cache_control，缓存输入 9 折，最大单杠杆）；mcp-compressor（MCP schema 懒加载） | ✅ 扩 `savings-gateway` / `cost-track`（已实测 cacheHit 28.7%，非侵入铁律④） |
| 2 | 对话历史每步重发全量、累积膨胀 | 50k→500k 复利 | Claude Code `/compact`、Headroom（可逆压缩）、MemGPT/Letta | ✅ `memory-merge`（公共+个性记忆注入）做 transparent 历史压缩 |
| 3 | 代码库 re-exploration | 每次从零 grep/追依赖 | **Graft**（trailhq，tree-sitter 图谱，已核验 README）；Graphify；Aider repo map；Repomix | ⚠️ 场景包 `packs/coding` 集成 Graft，不重造 |
| 4 | 语义检索轮次 | agent grep 多次才找着 | **zg(zvec-grep)**（阿里开源，通用检索，已核验）；Continue.dev RAG | ⚠️ 场景包接入 zg MCP / 扩 `knowledge-base` |
| 5 | 命令 / 工具输出膨胀 | git log/diff/长输出进上下文 | rtk(Rust, 80-90%, vendor 自宣)；Headroom | ⚠️ 仅在代理进 agent 运行时拦截 tool I/O |
| 6 | 模型输出冗长 | 啰嗦解释 | Caveman(~65%, vendor 自宣)；Headroom | ⚠️ 后处理，须保留 code/命令/错误原文 |
| 7 | 写代码方式（整文件重写 vs diff） | whole-file 重写费 token | Aider edit formats（diff/udiff/architect 双模型） | ⚠️ 场景包规范下游编辑格式 |
| 8 | 过度工程 | 做不需要的东西 | Ponytail(YAGNI, code -54%, vendor 自宣) | ⚠️ 路由层可注入 KISS 约束 |
| ＋ | 模型分级路由 | 简单任务用贵模型 | （multi-proxy 核心） | ✅ `route-engine` 复杂度分级 small/med/large |
| 🆕 | AIGC 生成成本（非 token，是按次计费） | 重复生成 / 废单 / 无分级 | 无现成（蓝海） | ✅ `AIGC adapter` + `route-engine`：草稿低分辨率→便宜模型、终稿超分→贵模型；prompt 前缀缓存；参考图按哈希去重；`cancel` 防废单 |
| 🆕 | 子 agent 上下文重复下发（编排独占） | 扇出任务时共享上下文重复塞给每个子 agent | 无现成（agent 侧工具碰不到请求链路） | ✅ `orchestrator`+`memory-merge`+`agent-registry`：共享上下文注入一次、子 agent 按需取 |

### 1.2 关键认知（纠正"只有通用几个，效果一般"的误解）

- **通用层（① 1/2/6/8 + 分级路由）是 ROI 最高的地基**：prompt caching（9 折）+ transparent 历史压缩 + 分级路由对**所有** agent 复利生效，包括 AIGC。光把 `cost-track` 的 cacheHit 从 28.7% 推高就是躺赚。
- **场景包是乘数不是基础**：coding 接 Graft/zg 给"读代码"叠 40%+；AIGC 接去重/分级把"每次生成计费"砍掉重复与废单。
- **结论**：通用层 = 60~80% 收益 / 20% 工作量（地基）；场景包 = 剩下 20~40% 精细收益（抛光）。不是"一般"，是地基与抛光的关系。

---

## 2. 核心论点：multi-proxy 的"代理原生"位置与边界（含诚实修正）

### 2.1 原审"独占位置"论断——已修正

早期讨论曾称 multi-proxy 对"透明历史压缩 / 工具输出过滤"有**独占位置**。经 §4 竞品研判，**此论断不成立**：

- **Context Gateway（compresr.ai）** 是纯玩家，已落地"代理层历史压缩 + 工具输出压缩（宣称 up to 20x / 95% token 削减）+ 按轮工具发现"，零配置。
- **LiteLLM v1.83.14** 已加 **server-side prompt compression**，且新增 Agent Hub / A2A Agent Gateway。

→ 这些"代理原生上下文压缩"**已是成长中的品类，并非 multi-proxy 独占**。文档据此修正，避免对外宣称虚假护城河。

### 2.2 multi-proxy 真正的位置

- **确实独占的只有"编排脑 + 请求路径中枢"的组合位置**：multi-proxy 不是单纯网关，而是"把 Codex/Hermes/Cursor 当员工"的 decomposer/orchestrator（见 `architecture.md`：项目是大脑和调度器不是路由器）。单纯网关（LiteLLM/One-API）不做多 agent 拆解编排；单纯编排框架（LangGraph/CrewAI）不做透明 token 控制。
- **护城河对齐**：见 `01-multi-proxy战略定位备忘.md`——multi-proxy = 集成/加速层，一切皆插件，不下沉抢"做引擎"的活。因此 Graft/zg/压缩引擎应**作为 pack 集成**，不重造。

---

## 3. 架构决策：核心通用层 + 可选场景包（curated，非开放平台）

### 3.1 为什么不做"开放平台 / 市场"

用户担忧："不能像 workbuddy 等搞成开放平台，重，也没那么多开发者维护。"

- **开放平台的重，全在"提交 / 审核 / 开发者认证 / 变现 / 发现"机器上**；curated 模型根本不需要这些。
- **修正（用户 9/26 纠正"你既是作者又是用户"）**：用户未来目标是**开源 / 商业化**，故 v1 不做市场≠永久不做。正确表述是——**v1 不需要市场机器；稳定的 TokenPolicy hook 接口本身就是为未来社区贡献 pack 留的门**，只是现在不建提交/审核/变现层。等真有外部贡献者再开，不前置。

### 3.2 扩展面 vs 分发面解耦（关键）

| 面 | 是什么 | 需要好好设计？ | 形态 |
|---|---|---|---|
| **扩展面** | 稳定的 `TokenPolicy` hook 接口，pack 往上面注册处理器 | ✅ 是，唯一需要设计好的 | 代码接口 |
| **分发面** | 用户怎么拿到 pack | 否，越简单越好 | 内置 `packs/` 文件夹 + 配置开关 + 轻量索引 |

### 3.3 TokenPolicy hook 接口（草案，待实现）

代理在请求生命周期的拦截点，pack 注册处理器：

```
onRequestAssemble(messages, systemPrompt, toolSchemas) → 挂缓存断点 / schema 懒加载 / 场景上下文注入
onHistory(history)                                    → transparent 历史压缩 / 摘要
onToolOutput(toolName, rawOutput)                     → 工具输出裁剪 / 结构化摘要
onResponse(response)                                  → 响应精简（保留 code/命令/错误原文）
onRoute(taskMeta)                                     → 分级 / architect 双模型路由（复用 route-engine）
```

### 3.4 pack manifest 规范（草案）

```yaml
# packs/coding/pack.yaml
name: coding-context
appliesTo: [codex, cursor, hermes, generic-coding]   # 按 agent 类型匹配（复用 route-engine 维度 + adapters）
hooks:
  onRequestAssemble:
    - graft-context-inject      # 注入 Graft 图谱
  onToolOutput:
    - rtk-compress              # 压缩命令输出
enabled: false                  # 默认关 —— 对齐非侵入铁律④（门控默认关 / shadow 默认开）
```

核心通用层（prompt-cache 断点 / schema 懒加载 / 历史压缩 / 分级路由）**不进 pack，是 multi-proxy 常驻能力**，对所有接入 agent 生效。

### 3.5 策略预算约束（防叠加负优化）

⚠️ 调研反复提示：pack 往 `onRequestAssemble` 塞指令会**增加指令开销**，叠太多反而抵消收益。→ 核心层须有**策略预算**：注入总指令有上限，pack 按优先级排队，超预算砍低优先级。这是设计 hook 接口时必带约束。

### 3.6 agent 类型分类（复用现有维度）

- `route-engine` 已有复杂度分级（small/med/large）→ 扩成 **agent 类型维度**：coding / aigc / research / general。
- 已有 `adapters/`：codex / hermes / cursor / h3web / AIGC → 天然提供"接入 agent 的类型标签"。
- pack 通过 `appliesTo` 与该标签匹配，做到"按类型选择性启用"。

### 3.7 与非侵入铁律对齐

- 铁律④（门控默认关 / shadow 默认开，`non-intrusion.md`）：pack 默认 `enabled:false`，与之一致。
- 铁律①②（不写 agent 文件 / 不污染全局 env，ADR-0002）：token-control-plane 在请求路径内做透明改写，**不写 agent 配置、不碰 launchd**，一致。

---

## 4. 竞争格局与差异化（竞品研判 · 2026-09-26 新增）

> 调研方法：WebSearch 5 组（LiteLLM / Portkey / One-API / 代理原生压缩 / 网关综述）。以下为已核实事实，benchmark 数字除特别标注外为 vendor 自宣。

### 4.1 通用网关 + 缓存 + 成本层（已被强手压住）

| 产品 | 状态 | 做什么 | 对 multi-proxy 的启示 |
|---|---|---|---|
| **LiteLLM**（BerriAI，MIT，~40–56k★） | 主导 | 140+ provider 统一 OpenAI 接口、虚拟 key、预算、负载均衡、fallback、**prompt caching + 语义缓存（宣称 RAG 降本 40–60%）**、成本追踪；**v1.83.14 加 server-side prompt compression + Agent Hub + A2A Gateway** | **通用网关层不要和它正面刚**；它的压缩/Agent Hub 已吃掉部分"代理原生"叙事 |
| **One-API**（songquanpeng，MIT，Go，~29k★） | 国内强 | 30+ provider、单二进制 Docker、预算/配额/token 管理，国内模型覆盖广 | 国内分发可参考，但 token 优化弱 |
| **Portkey** | **已被 Palo Alto Networks 收购（2026-05-29），转 Prisma AIRS AI Gateway（2026-07-16 GA）** | 企业可观测 + 语义缓存 + guardrails，托管 | 已成企业安全产品，非创业竞品 |
| **Higress / Envoy AI Gateway** | 阿里开源 / CNCF | 云原生 AI 插件：多模型调度、内容安全、Token 限额、权重路由 | K8s 场景，非个人/小团队 |

### 4.2 代理原生上下文压缩层（已有先行者 → 修正"独占"论断）

| 产品 | 做什么 | 验证状态 |
|---|---|---|
| **Context Gateway（compresr.ai）** | 纯玩家：历史压缩（后台摘要）+ 工具输出压缩（宣称 up to 20x / 95% 削减）+ 按轮工具发现，零配置 | 官网+GitHub，vendor 自宣数字未独立复现 |
| **LiteLLM server-side prompt compression**（v1.83.14） | 转发前压缩 token | vendor 自宣 |
| 学术/工程佐证 | SNIA 2026 演讲（Netflix Tejas Chopra）：线级开源代理前置 coding agent，实测 **40–90% token 削减**；ai.codersarts / APIPark 博客系统化了"工具输出截断 / 状态压缩 / 前缀缓存对齐"模式 | 演讲+博客，非本仓复现 |

→ **结论**：透明上下文压缩是真实且被验证的品类，但**先行者已占**。multi-proxy 不应重造，应**优先集成 Context Gateway / LiteLLM 压缩**作为 pack 或后端。

### 4.3 agent 编排层

- LiteLLM Agent Hub / A2A、LangGraph / CrewAI / AutoGen：框架或网关内编排，**不做透明 token 控制**。
- multi-proxy 的差异化：decomposer/orchestrator 把多 agent 当"员工"拆解调度（见 `architecture.md`），这是网关与框架都没缝合的空缺。

### 4.4 诚实的差异化 wedge（multi-proxy 该打的点）

1. **编排脑 + 代理原生 token 控制的缝合**：没人把"多 agent 拆解编排"和"按请求透明省 token"焊在一起。
2. **按 agent 类型可选启用的 curated 场景包**：通用引擎（Graft/zg/压缩）由 pack 集成，用户按需开；核心只做"代理原生 + 别人做不了"的那层。
3. **AIGC 成本管控一等公民（蓝海）**：所有现有网关聚焦文本/agent，**没人把"生图生视频按次计费"当一等公民**——而这是用户 h3web 短剧项目的真实痛点（多镜角色漂移之外的第二大成本）。这是最该抢的差异化。

### 4.5 竞争策略建议

- 通用网关内核：**复用 / 对接 LiteLLM 思路**，不重造（避免与它 40k+ 星正面竞争）。
- 压缩能力：**优先集成 Context Gateway / LiteLLM server-side compression**，pack 系统可承载它们，而非自研压缩算法。
- 主战场：**编排脑 + 场景包生态 + AIGC 成本管控**。

---

## 5. 落地路线图（建议，按 ROI 排序）

| 优先级 | 项 | 落点 | 验证 |
|---|---|---|---|
| P0 | **prompt-cache 断点管理最小 PoC** | 扩 `savings-gateway` / `cost-track`（cacheHit 28.7%→更高），打 `cache_control` 断点 + schema 懒加载 | 非侵入铁律④，零热路径触碰 |
| P1 | **packs/coding 骨架** | `packs/coding/pack.yaml` + `graft-context-inject` stub，验证"核心 + pack"挂载机制 | 复用 `plugin-runtime` |
| P2 | **zg 接 knowledge-base** | 让编排出去的 agent 能用通用语义检索（用户 zg README 原定"后续可做"） | 接 zg MCP |
| P3 | **AIGC 成本管控** | `AIGC adapter` + `route-engine`：草稿/预览→便宜模型、终稿超分→贵模型；prompt 前缀缓存；参考图哈希去重；复用 `cancel` | 服务 h3web 短剧 |

---

## 6. 参考文献（含验证状态）

> 图例：✅ 已核实（本仓/官方文档/公众号直接核验）｜⚠️ vendor 自宣，未独立复现｜🔍 待核实

### 6.1 本项目内部（已读，grounded）
- `docs/10-initiatives/01-multi-proxy战略定位备忘.md` — 集成/加速层定位、护城河边界
- `docs/04-tech/savings-gateway-design.md` — savings-gateway 已落地（门控默认关 / shadow 默认开，18795，719/719 零回归）
- `docs/04-tech/non-intrusion.md` — 四非侵入铁律（①②不写 agent 文件/不污染全局 env；③不写死端口；④门控默认关）
- `docs/03-adr/0002-no-proxy-iron-law.md` — 禁 `NO_PROXY *` 全局注入（与"代理原生 token 控制"无冲突）
- `docs/03-architecture/architecture.md` — L2 编排层（decomposer/orchestrator/route-engine…）
- `l2/adapters/aigc-adapter.js` — AIGC 接入位（7 subtype + cancel）

### 6.2 外部引擎（场景包候选，集成不重造）
- **Graft** — `github.com/trailhq/Graft`（npm `@nanonets/graft` v0.19.0, MIT）。coding-agent 代码库结构图谱。✅ README 核验 9/26；benchmark（token -42%/工具 -46%/延迟 -60%/SWE-bench 54→66）为 vendor 自测，对照组 coding 探索场景，**非路由代理**，引用须标注未复现。
- **zg(zvec-grep)** — `github.com/zvec-ai/zvec-grep`（Apache 2.0）。本地混合检索（向量+BM25+rg），**通用**（代码+文档+数据）。✅ 阿里开源已证实（「阿里技术」公众号 2026-08-31，"我们开源了 zg"）；BrowseComp-Plus 非代码场景 input token -37.56%/工具 -43.52%（⚠️ vendor 自宣）。只覆盖读/检索，不覆盖写。
- **LiteLLM** — `github.com/BerriAI/litellm`（MIT, ~40–56k★）。✅ 调研 9/26：统一网关 + 缓存 + 成本 + v1.83.14 server-side prompt compression + Agent Hub/A2A。
- **Context Gateway** — `compresr.ai/gateway`。🔍 调研 9/26：历史压缩 + 工具输出压缩（宣称 up to 20x）+ 工具发现，零配置（⚠️ vendor 自宣）。
- **One-API** — `github.com/songquanpeng/one-api`（MIT, Go, ~29k★）。✅ 调研 9/26：国内强，token 优化弱。
- **Portkey** — ✅ 调研 9/26：2026-05-29 被 Palo Alto Networks 收购，转 Prisma AIRS AI Gateway。

### 6.3 模式 / 学术参考
- SNIA 2026（Netflix Tejas Chopra）上下文窗口分级压缩演讲 — ✅ 调研 9/26，线级代理 40–90% token 削减（演讲数据，非本仓复现）。
- ai.codersarts《Context Window Engineering》— 工具输出截断 / 状态压缩 / 前缀缓存对齐模式。
- APIPark《Master Path of the Proxy II》— MCP 上下文管理策略（滑动窗口 / 摘要 / RAG / 分块）。
- Aider edit formats（diff/udiff/architect）— 写代码省 token 格式（⚠️ vendor 自宣）。
- rtk / Headroom / Caveman / mcp-compressor / Ponytail / Context7 / Repomix / Graphify — 各层开源参考（⚠️ 多来自 WeAreDevelopers/Pinggy/BestHub 文章，benchmark 为 vendor 宣称，未独立复现）。
- RouteLLM（LMSYS/UC Berkeley）、Not Diamond — 算法/托管路由（调研 9/26）。

---

## 7. 决策记录与待定项

### 已拍板（2026-09-26）
- [x] token-control-plane = 核心通用层 + 可选场景包（curated，非开放平台）
- [x] 扩展面（TokenPolicy hook）与分发面（bundled+索引）解耦
- [x] 不做开放市场；v1 不做提交/审核/变现层（未来开源可扩展）
- [x] 修正"独占位置"论断：透明压缩已有先行者，改为"集成不重造"

### 待定 / 待用户拍板
- [ ] TokenPolicy hook 接口的最终签名与注册机制（§3.3 草案）
- [ ] 策略预算的具体上限值（§3.5）
- [ ] agent 类型维度的最终枚举（coding/aigc/research/general 是否够）
- [ ] 压缩能力：自研 vs 集成 Context Gateway/LiteLLM 的最终取舍（§4.5）
- [ ] 是否先落 P0（prompt-cache 断点 PoC）

_落盘：2026-09-26 · 综合 9/26 多轮讨论 + 竞品研判 · 设计稿（非实现）· 外部 benchmark 除特别标注外未独立复现_
