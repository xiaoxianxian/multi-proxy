# VetarAI 竞品分析 · 借鉴意见与迭代 Backlog

> 状态：**分析留底（不进入开发，待当前需求开发完由老板读取续做）**，2026-09-23
> 来源：抖音作者提及的开源项目「VetarModel」→ 经核实为 **VetarAI**（GitHub `zero11924065-dev/VetarAI`，中文团队，GPL v3，Apple Silicon Mac 本地 AI 桌面端）
> 关联：`README.md`（L2 编排中枢定位）· `l2/README.md` · `desktop/README.md` · `L2-BLUEPRINT.md` · `ITERATION-ROADMAP.md` · `docs/04-business/marvis-p5-gui-design.md`
> 核实方式：本分析基于 2026-09-23 对 multi-proxy 仓库的**代码核读**（README / l2 / desktop / 蓝图 / 路线图 / FUNCTIONS），竞品信息来自 GitHub 仓库与公开介绍文章的二手整理，**竞品功能描述未经本仓代码实证**，落地前建议再开仓库核对一次。

---

## 一、结论先行（核心判断）

1. **你不是"想做" agent 编排——你已经在做，且中台层比 VetarAI 更成熟。**
   multi-proxy 已是 **L2 Agent 编排中枢**：Agent Registry + orchestrator + decomposer(规则/LLM) + memory-merge + skill-service + alert + cost + 3 适配器 + Electron 桌面壳 + Web 管理台（18792），882/882 测试全绿。VetarAI 在你这层**没有领先**，它偏「本地 LLM 应用层」。

2. **VetarAI 与你是「同层不同轴」的竞品。**
   - VetarAI 编排对象 = **本地 LLM 模型**（Ollama 模型当 Agent）+ 知识库 + 圆桌共识 + 可视化工作流。
   - 你编排对象 = **AI 编程 Agent CLI**（Codex / Hermes / Cursor）+ AIGC 服务；路由是「胜者通吃」单路由（按复杂度 tier / failover / round-robin）。
   - 你缺的是 VetarAI 的**应用层三块**，不是基础设施。

3. **最该抄的是 RAG 知识库（拉模式）；可视化拖拽工作流最贵且可不做。**

---

## 二、竞品背景（VetarAI 是什么）

| 项 | 内容 |
|----|------|
| 名称 | VetarAI（抖音被听成「VetarModel」） |
| 仓库 | `github.com/zero11924065-dev/VetarAI` |
| 协议 | GPL v3.0 |
| 平台 | macOS · Apple Silicon |
| 技术栈 | Electron + React + Python(FastAPI) 侧车 |
| 当前状态 | 活跃（v0.4.x，2026-09 仍在更新） |
| 一句话 | 100% 本地的多 Agent 编排桌面端：把本机 Ollama/LM Studio 模型组织成多 Agent 工作流 + 知识仓库 |
| 旗舰能力 | ① 多 Agent 协作（主-子委派 / 圆桌讨论）② 知识仓库（拉模式，永不自动注入）③ 可视化节点工作流 ④ 纯推理 pass-through 节点 ⑤ 网络守卫（失败熔断） |

> ⚠️ 注意：抖音文案「让每台 Mac 创建独属于自己的大模型」是口语化误读——VetarAI **不训练/不生成模型**，只是调度本机已有模型。真正「在 Mac 上训自己的模型」是另一个项目 LabLLM（Swift/SwiftUI + MLX，MIT，Beta），与本次对标无关。

---

## 三、功能对标（你已有 vs VetarAI 有）

| 能力 | 你 multi-proxy 现状（2026-09-23 核读） | 结论 |
|------|------|------|
| 多 Agent 编排 | ✅ `l2/orchestrator.js` + `agent-registry.js` 已落地 | 你领先 |
| 任务拆解（规则/LLM） | ✅ `l2/decomposer.js` + `llm-decomposer.js` | 你领先 |
| 记忆 / 技能服务 | ✅ `l2/memory-merge.js` + `skill-service.js` | 你领先 |
| Electron 桌面壳 | ✅ `desktop/`（commit `42ea997` 壳 + `2163ca9` 验收） | 你已有 |
| Web 管理台 | ✅ 18792，6 页（dashboard/health/alerts/registry/sessions/logs） | 你已有 |
| 失败熔断 / 限流 / 健康 | ✅ `l2/circuit-breaker.js` + `rate-limiter.js` + `health-monitor.js` | 你已有 |
| 省钱路由（难度档位） | ✅ `l2/savings-gateway/`（`PROXY_SAVINGS_GATEWAY` 默认关） | 你已有 |
| **RAG 知识库（拉模式）** | ❌ **无**（memory-merge 是跨 Agent 记忆 env 注入，非文档摄取+RAG） | **真缺口** |
| **圆桌共识 / 多 Agent 辩论** | ❌ 你是「胜者通吃」单路由，无并发 N→合成 | **真缺口** |
| 本地 LLM 当一等公民 Agent（带角色/人设） | ⚠️ 本地 Ollama 仅作 savings-gateway **Tier4 兜底**（`ITERATION-ROADMAP.md:273`），非可定义角色的编排单元 | 半缺口 |
| 人设/角色可视化定义 | ⚠️ `agent-registry` 有 profile(systemPrompt/capabilityTags) 但无可视化 UX | 半缺口 |
| 可视化节点工作流（拖拽） | ⏳ `L2-BLUEPRINT.md:354` P5「编排面板 + 插件市场 UI」**未开始，可延后**；`marvis-p5-gui-design.md` 是看板草案（非拖拽画布） | 规划过未做 |
| 100% 本地隐私叙事 | 不适用（你是多云多供应商网关，隐私非卖点） | 别抄 |

---

## 四、值得借鉴的（按性价比排序）

### ① RAG 知识仓库（拉模式）—— 最该抄
VetarAI 旗舰：知识「永不自动注入」，Agent 显式检索、读完即忘。你当前所有"上下文"靠 memory-merge 注入 env，缺**文档摄取 → chunk → 向量 → 按需检索**这一层。若要让编排出的 Agent 能基于你的公众号素材/项目文档干活，这是最关键的一块。
- **落地建议**：新增 `l2/knowledge-base/`（摄取 + 检索内核，零依赖优先），接 `orchestrator` 的可注入 `retrieve` 缝；沿用**非侵入 + 门控默认关 + shadow**。（接口草图见 **§八**）
- **成本**：中（轻量向量库可先纯内存原型验证）。

### ② 圆桌共识 mode —— 编排模式补盲
你每个任务只路由给**一个** Agent；VetarAI 是同一 prompt 并发打 N 个 Agent → 投票/合成。这与你的 savings-gateway「省钱选最便宜」**正交**——是另一种「贵但准」的质量取向。
- **落地建议**：`orchestrator.js` 加 `mode: 'route' | 'consensus'`，consensus = 并发经 executor 调 N 个 adapter → 可注入 `synthesize` 聚合；`PROXY_CONSENSUS_MODE` 默认关。（接口草图见 **§九**）
- **成本**：低~中，复用现有 executor + `mcp-default-seed` 三档 tier。

### ③ 本地 LLM 升为一等公民 Agent（带角色/人设）—— 贴合你 M5 Pro/48G
你本地 qwen3.8 现在只是"断网兜底 tier"。VetarAI 思路：给一个模型端点配 role + system prompt + tools，它就成可编排 Agent。
- **落地建议**：`agent-registry` 增 `type: 'model'`（含 baseUrl/model/systemPrompt/capabilityTags/toolsAllowed），新增 `l2/adapters/model-adapter.js`（接 OpenAI 兼容端点，Ollama `localhost:11434` 即一类），进编排 DAG。
- **成本**：低（profile 数据模型现成，加一类 adapter）。

### ④ 人设/角色可视化定义 UX（轻量版）—— ③ 之后做
不一定要拖拽画布，先在 Web 台 `registry.html` 加「Agent 定义」CRUD（角色/系统提示词/能力标签/工具白名单），复用现有 `routes/registry.js`。
- **成本**：低。

### ⑤ 可视化节点工作流（拖拽）—— 最贵，明确后置
VetarAI 核心交互就是拖节点画工作流。你 L2 蓝图 P5 已规划「编排面板」但标延后。开发量大、对网关型产品未必刚需。**建议先不做**，等 I2/I3 编排语义稳定后再考虑（详见 §六 I5）。

---

## 五、明确不借鉴的（含理由）

| 不借鉴项 | 理由 |
|---------|------|
| **100% 本地 / 数据不出本机 叙事** | 你是多云多供应商网关，这人设与定位冲突，抄了自相矛盾 |
| **本地模型显存生命周期调度（卸载旧模型再加载）** | 那是本地推理的 VRAM 管理，你是网络连接管理，不相关 |
| **Electron 桌面壳** | 你**已有**（`desktop/`，commit `42ea997`/`2163ca9`），勿返工 |

---

## 六、迭代意见 Backlog（供后续开发直接接手）

> 约定：每条均沿用本仓纪律——**非侵入**（只读下游、不写 agent 文件）、**门控默认关**、**shadow 优先**（不触真实上游）。优先级 P0=最该做。

| 编号 | 借鉴项 | 对标 VetarAI 能力 | 你当前现状 | 建议落地动作 | 落地模块 / 文件 | 优先级 | 门控纪律 | 依赖 |
|------|--------|------------------|-----------|-------------|----------------|--------|---------|------|
| **I1** | RAG 知识仓库（拉模式） | 知识库（永不自动注入，显式检索） | ❌ 无；memory-merge 非 RAG | 新增 `l2/knowledge-base/`（摄取→chunk→向量→检索 API）；给 `Orchestrator` 注入第 5 个可注入项 `retriever` | 新 `l2/knowledge-base/` + `multi-proxy-manager/routes/knowledge.js`（挂 `/api/knowledge`）+ `multi-proxy-manager/public/knowledge.html`（`PROXY_KNOWLEDGE_BASE` 默认 0） | **P0** | 默认关 observe；检索只读，不写 agent 文件 | 向量库选型（轻量：sqlite-vec 或纯内存原型先验证）；复用 `adapter-protocol.md` **纪律**而非其 4 接口契约 |
| **I2** | 圆桌共识 mode | 圆桌讨论（同 prompt 并发 N→合成） | ❌ 单路由胜者通吃 | `orchestrator.js` 加 `mode: 'route'\|'consensus'`；consensus 并发调 N adapter + 可注入 `synthesize` | `l2/orchestrator.js` + `multi-proxy-manager/routes/orchestration.js`（增 mode 参数）+ demo | **P1** | `PROXY_CONSENSUS_MODE` 默认关；shadow 验证 | 复用现有 executor + `mcp-default-seed` 三档；synthesize 先模板（投票/取最长），LLM 合成留缝（接口草图见 §九） |
| **I3** | 本地 LLM 一等公民 Agent | 把 Ollama 模型当可定义角色的 Agent | ⚠️ 仅 savings-gateway Tier4 兜底（`ITERATION-ROADMAP.md:273`） | `agent-registry` 增 `type:'model'`；新增 `l2/adapters/model-adapter.js`（接 OpenAI 兼容，Ollama `localhost:11434` 即一类） | `l2/agent-registry.js` + 新 `l2/adapters/model-adapter.js` + `adapter-protocol.md` 补 model 类 | **P2** | 默认内存；`L2_REGISTRY_DIR` 才落盘；非侵入 | 复用 adapter 四接口（capabilities/health/submit/result） |
| **I4** | 人设/角色可视化定义 UX | 可视化定义 Agent 角色/系统提示词/技能 | ⚠️ profile 有数据模型但无 UX | `public/registry.html` 扩「Agent 定义」CRUD（角色/系统提示词/能力标签/工具白名单） | `multi-proxy-manager/public/registry.html` + `routes/registry.js` | **P3** | 复用现有 registry 路由（已门控 401） | I3 的 profile 模型稳定后 |
| **I5** | 可视化节点工作流（拖拽） | 拖拽画布 | ⏳ P5 未开始可延后（`L2-BLUEPRINT.md:354`） | **暂不实施**；先做 I2/I3 把编排语义稳定，拖拽画布是编排能力的 UI 表达 | `docs/04-business/marvis-p5-gui-design.md`（看板草案，非画布） | **P4（可不做）** | N/A | I2/I3 先稳 |

### 推荐实施顺序
**I1（RAG）→ I2（共识）→ I3（model agent）→ I4（UX）→ I5（延后）**

理由：I1/I2/I3 是**编排能力本身**的增强（让中枢更聪明），I4 是 I3 的 UI 外显，I5 是编排能力成熟后的可选可视化表达。先补能力、再补 UI，避免为不存在的编排语义做画布。

### 验收纪律（沿用本仓）
- 每条均配套 `l2/*.demo.js`（真跑，非纸面）+ jest；
- 门控默认关 → 全量测试 0 回归；
- shadow 模式下不触真实上游 / 不写盘（断言 `fs.existsSync===false`）；
- 数字/行为变动须真跑取证，不靠模型自验。

---

## 七、来源与可回源

| 来源 | 链接 / 路径 | 用途 |
|------|------------|------|
| VetarAI 仓库 | `github.com/zero11924065-dev/VetarAI` | 竞品一手信息（落地前再核一次） |
| 本仓 README | `README.md` | L2 编排中枢定位、端口、测试数 |
| L2 内核 | `l2/README.md` | 10 内核 + 3 adapter 现状 |
| 桌面壳 | `desktop/README.md` | Electron 壳状态 |
| 蓝图 | `L2-BLUEPRINT.md` | P5 可视化工作流规划（:354） |
| 路线图 | `ITERATION-ROADMAP.md` | 本地 Ollama Tier4 兜底（:273）、内容感知派发 |
| 看板草案 | `docs/04-business/marvis-p5-gui-design.md` | P5 可视化看板（设计态） |
| 商业化决策 | `docs/04-business/commercialization-decided.md` | 定位：个人开发者 + 开源+云增值（与"本地隐私叙事"冲突，印证 §五 不抄项） |

> 竞品功能描述来自二手整理，**未经本仓代码实证**；I1–I5 落地前建议开 VetarAI 仓库核对其知识库/圆桌/模型 Agent 的真实实现，再细化技术方案。

---

## 八、I1 接口草图（可直接接手开发 · 2026-09-23 补全）

> 本节把 I1 落地点**精确到模块 / 接口 / 缝**，对齐你现有 `orchestrator.js` / `agent-registry.js` / `memory-merge.js` / `adapter-protocol.md` 的真实结构（均已核读）。落地前仍建议开 VetarAI 仓库核一次其知识库实现（见 §七）。

### 8.1 定位澄清：RAG 是「服务」不是「agent adapter」
`l2/adapter-protocol.md` 的 4 接口契约（capabilities / health / task-receive / result）是为**可编排的 agent** 设计的。知识库不是一个 agent（它没有"任务接收 / 结果回传"语义），**不应硬塞进 adapter-protocol**。
正确做法：复用 adapter-protocol 的**纪律**（非侵入④ / 门控默认关 / shadow 优先），但定义一套更瘦的 `retriever` 接口。这是避免过度抽象（简洁优先），也符合你"不为不存在的场景加灵活性"的编码准则。

### 8.2 服务内核：`l2/knowledge-base/knowledge-base.js`（零依赖 MVP）
先用纯内存 + 词频/哈希向量做余弦相似度，**不引外部向量库**，验证检索质量后再换 sqlite-vec / 真 embedding。

```js
// l2/knowledge-base/knowledge-base.js
'use strict';
// 非侵入：只读你的文档（公众号素材 / 项目 md），绝不写 agent 文件、绝不联网。
// 门控：PROXY_KNOWLEDGE_BASE !== '1' 时 orchestrator 不注入 retriever（见 8.4）。

function chunk(text, size = 800) { /* 按段落 + 滑动窗口切分 */ }

class KnowledgeBase {
  constructor({ dir = null } = {}) { this.docs = new Map(); this.dir = dir; }

  // 摄取：一篇文档 → 切块 → 存（保留 title/snippet 供检索返回）
  ingest({ id, title, text, tags = [], scope = 'shared' }) {
    const chunks = chunk(text).map((c, i) => ({ id: `${id}#${i}`, title, snippet: c, vec: toVec(c), tags, scope }));
    this.docs.set(id, chunks);
    if (this.dir) this._persist();
    return chunks.length;
  }

  // 检索（VetarAI 拉模式：只有被显式调用才返回，绝不自动注入）
  retrieve({ query, topK = 3, scope = null }) {
    const q = toVec(query);
    const all = [...this.docs.values()].flat();
    return all
      .filter(c => !scope || c.scope === scope)
      .map(c => ({ ...c, score: cosine(q, c.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ snippet, title, score }) => ({ title, snippet, score }));
  }

  status() {
    return { ready: true, chunks: [...this.docs.values()].reduce((n, c) => n + c.length, 0) };
  }
}
module.exports = { KnowledgeBase, chunk, toVec, cosine };
```

### 8.3 编排缝：给 `Orchestrator` 注入第 5 个可注入项 `retriever`
对齐 `l2/orchestrator.js` 现有构造（已注入 `executor / routeEngine / decomposer / shadowMode / dir`），**加一个可选 `retriever`**，并在 `_executeSubtask` 里于 `_invoke` 之前挂 knowledge 到 ctx。

改动点（最小、精准，不动热路径）：
- 构造：`constructor({ ..., retriever = null } = {})` → `this.retriever = retriever;`
- `_executeSubtask` 内，`if (!this.shadowMode && st.useKnowledge !== false && this.retriever)` 时：
  ```js
  ctx.knowledge = await this.retriever.retrieve({
    query: st.knowledgeQuery || st.prompt || dag.input,
    topK: st.knowledgeTopK || 3,
  });
  ```
- **拉模式语义**：`st.useKnowledge` 默认 `false` → 不检索、不注入（对比 `memory-merge.js` 的 `envInject` 是 agent 启动时**无条件**注入 `AGENT_MEMORY_CONTEXT`）。知识只在子任务显式声明需要时才进 ctx，满足 VetarAI「永不自动注入」原则。
- **shadow 纪律**：`shadowMode` 下不调 retriever、ctx.knowledge 不挂 → 与现有 shadow demo 零回归。

### 8.4 检索如何抵达 adapter：executor 组合，不污染 memory-merge
检索结果走 **executor 组合层**注入 prompt/env，**不要**塞进 `memory-merge`（那是跨 agent 记忆，语义不同）。示意：
```js
// 调用方组合：把 retriever 接到现有 executor 上
const baseExecutor = (st, ctx) => callAdapter(st, ctx); // 现有 executor
const executorWithKB = async (st, ctx) => {
  if (ctx.knowledge?.length) {
    ctx.env = { ...ctx.env, AGENT_KNOWLEDGE_CONTEXT: ctx.knowledge.map(k => `【${k.title}】${k.snippet}`).join('\n') };
  }
  return baseExecutor(st, ctx);
};
const orch = new Orchestrator({ executor: executorWithKB, retriever: kb, shadowMode: true });
```
> 注：`AGENT_KNOWLEDGE_CONTEXT` 是 RAG 专用变量，与 `memory-merge` 的 `AGENT_MEMORY_CONTEXT` 并列、互不干扰——这正是「I1 ≠ memory-merge」的代码级表达。

### 8.5 管理台：真实路径（纠正 §六 I1 行的 aspirational 路径）
manager 已有 `multi-proxy-manager/public/*.html` 与 `multi-proxy-manager/routes/{registry,skill-service}.js`，知识库页**照此套**，无需新建目录：
- 页：`multi-proxy-manager/public/knowledge.html`（摄取表单 + 列表 + 搜索框）
- 路由：`multi-proxy-manager/routes/knowledge.js`，照 `routes/registry.js` 模式：
  - `const { requireAuth } = require('../lib/auth');`（写操作挂 `requireAuth`，GET 只读不挂——与 registry 一致）
  - `const { KnowledgeBase } = require('../../l2/knowledge-base/knowledge-base');`
  - `router.get('/docs', ...)` 列表；`router.post('/ingest', requireAuth, ...)` 摄取；`router.get('/search', ...)` 检索
- 挂载：在 `multi-proxy-manager/server.js` 加 `const knowledgeRoutes = require('./routes/knowledge');` 与 `app.use('/api/knowledge', knowledgeRoutes);`（紧跟现有 `app.use('/api/registry', registryRoutes);` 那行）

### 8.6 门控与 shadow 验收纪律（沿用本仓）
- 门控：`PROXY_KNOWLEDGE_BASE` 默认 `0` / 未设 → 不构造 `KnowledgeBase`、orchestrator `retriever` 为 null → **全量测试 0 回归**。
- 持久化：`PROXY_KNOWLEDGE_BASE_DIR` 才落盘（镜像 `L2_REGISTRY_DIR` 的「默认内存、显式才落」），绝不写 home。
- 测试：`l2/knowledge-base/knowledge-base.demo.js`（真 ingest+retrieve round-trip，内存）、jest 单测；orchestrator shadow demo 断言 `retriever=null` 时 `ctx.knowledge === undefined`。
- 数字 / 行为变动须真跑取证，不靠模型自验（守 §六 验收纪律）。

> **✅ P0 已落地（2026-09-23，本轮）**：① 内核 `l2/knowledge-base/knowledge-base.js`（零依赖纯内存 + CJK bigram 分词 + 余弦相似度，11/11 demo PASS）② orchestrator.js 第 5 可注入项 `retriever`（shadow 默认关 + 拉模式 + `_executeSubtask` 注入缝）③ route `multi-proxy-manager/routes/knowledge-base.js`（门控 `PROXY_KNOWLEDGE_BASE` 默认关 + 写鉴权 requireAuth，4/4 smoke PASS）④ server.js 已注册 `/api/knowledge`。**待 P2+**：jest 单测 + `public/knowledge.html` 前端 UI + 真·embedding 替换纯内存词频。

### 8.7 与 I2 / I3 的关系
- I2（圆桌共识）的 `synthesize` 聚合函数可消费 `ctx.knowledge` → 多 agent 答辩时共享同一检索上下文。
- I3（本地 LLM 一等公民）的 `type:'model'` agent 也可声明 `useKnowledge:true` → 本地 qwen3.8 也能基于你的素材作答。
- 三者都从 `ctx.knowledge` 这一条缝取数，互不耦合。

---

## 九、I2 接口草图（可直接接手开发 · 2026-09-23 补全）

> 本节把 I2（圆桌共识 mode）落地点**精确到模块 / 接口 / 缝**，对齐 `l2/orchestrator.js` / `l2/route-engine.js` `route()` / `l2/mcp-default-seed.js` 的真实结构（均已核读）。落地前仍建议开 VetarAI 仓库核一次其圆桌实现（见 §七）。

### 9.1 定位：consensus 是「质量取向」，正交 savings-gateway 的「省钱取向」
`savings-gateway` 选**最便宜**的一个 agent 跑；consensus 是同一 prompt 并发打 **N 个** agent → 聚合。两者目标不同（省钱 vs 提质），**可叠加不可替换**。默认关，绝不干扰现有「胜者通吃」单路由。

### 9.2 Orchestrator 改动：加 `mode` + `synthesize` 两个可注入项
对齐 `l2/orchestrator.js` 现有构造（已注入 `executor / routeEngine / decomposer / shadowMode / dir / maxRetries`），加：
- 构造：`constructor({ ..., mode = 'route', synthesize = null } = {})` → `this.mode = mode; this.synthesize = synthesize;`
- `_executeSubtask` 内，非 shadow 分支：若 `this.mode === 'consensus' || st.mode === 'consensus'`，走 fan-out（见 9.4），**不走**原 `_invoke`（单 agent）。`route` 模式行为零变化。

### 9.3 候选来源：直接复用 `routeEngine.route(st).candidates`
`l2/route-engine.js:41` 的 `route(task)` 已产出**按 modelTypeMatch → tierMatch → confidence 排序**的 `candidates[]`（每条含 `adapterId`）。consensus 不需要自己选 agent——拿 `candidates.slice(0, N)` 即可：
```js
_consensusCandidates(st, ctx) {
  const n = st.consensusN || 3;
  // 显式候选优先（subtask 自带）
  if (Array.isArray(st.candidates) && st.candidates.length) return st.candidates.slice(0, n);
  // 否则复用 route() 已排序候选；shadow 调只取决策不执行
  if (this.routeEngine && typeof this.routeEngine.route === 'function') {
    const decision = this.routeEngine.route({ ...st, shadowMode: true });
    return (decision.candidates || []).slice(0, n).map(c => c.adapterId);
  }
  return [];
}
```
> 默认 `consensusN=3` 天然对齐 `mcp-default-seed.js` 的 `TIER_PROFILES`（agnes/small · deepseek/medium · qwen/large）——「小/中/大各一个代表辩论」，零额外配置。

### 9.4 fan-out 执行：复用现有 executor + 显式 `candidateId` 留缝
```js
// _executeSubtask 内，consensus 分支
const ids = this._consensusCandidates(st, ctx);
const responses = await Promise.all(
  ids.map(id => this._invokeOne(st, ctx, id))
);
const value = (this.synthesize || defaultSynthesize)({ subtask: st, responses }, ctx);
results[st.id] = { id: st.id, status: 'done', value, mode: 'consensus' };

async _invokeOne(st, ctx, candidateId) {
  // 复用现有 executor；executor 内部经 routeEngine 选 agent，
  // 需支持 candidateId 显式定向（见 9.5 唯一内核改动点）
  return this.executor({ ...st, candidateId }, ctx);
}
```
> **唯一需要动的路由内核点**：给 `routeEngine.route(task, { explicitAdapterId })` 加一个显式覆盖参数——有 `explicitAdapterId` 时 `candidates=[that]`、`chosen=that`（约 1 行改动，写在 `route()` 的候选合并之后、排序之前）。这样 consensus 能让每个 agent 打到指定 adapter，而非各自重新路由到同一个 `chosen`。

### 9.5 synthesize 默认模板（先模板，LLM 合成留缝）
```js
function defaultSynthesize({ subtask, responses }, _ctx) {
  const ok = responses.filter(r => r && r.status !== 'failed' && r.value != null);
  if (!ok.length) return { synthesized: null, note: 'all-failed' };
  const strat = subtask.synthesizeStrategy || 'longest';
  if (strat === 'concat') return { synthesized: ok.map(r => String(r.value)).join('\n---\n') };
  if (strat === 'vote') { /* 计数最频繁值，平局退化 longest（留缝：可接 LLM 判等）*/ }
  // longest（默认安全启发式：取最长且非失败响应）
  return { synthesized: ok.sort((a, b) => String(b.value).length - String(a.value).length)[0].value };
}
```
> LLM 合成留缝：`this.synthesize` 可注入——接 `mcp-default-seed` 的 `qwen`(large) tier，把 `responses` + 原始 prompt 丢进去做真·观点融合。默认不接，先模板验证链路。

### 9.6 管理台 / API：真实路径
`multi-proxy-manager/routes/orchestration.js` 的 `POST /run` 已接收 `input/dag/shadowMode/maxRetries`，**加 3 个透传字段**：
- `mode`（`'route'|'consensus'`，per-run 覆盖 orchestrator.mode）
- `consensusN`（默认 3）
- `synthesizeStrategy`（`'longest'|'concat'|'vote'`）
- 门控：`PROXY_CONSENSUS_MODE` 默认 `0` → 即使请求带 `mode:'consensus'` 也降级为 `route`（与现有 `PROXY_ORCHESTRATION` gate 同风格，见 orchestration.js:38 `isGatedOpen`）。

### 9.7 门控与 shadow 验收纪律（沿用本仓）
- 门控：`PROXY_CONSENSUS_MODE` 默认 `0` → orchestrator.mode 恒 `'route'` → **全量测试 0 回归**。
- shadow 纪律：consensus 在 `shadowMode` 下不真调 executor（`routeEngine.route` 也传 `shadowMode:true` 只取候选决策）→ 与现有 shadow demo 零回归。
- 测试：`l2/orchestrator.demo.js` 加 consensus fan-out case（注入 `synthesize` + mock executor，断言 N 次调用 + 聚合结果）；断言 `mode='route'` 时行为与改动前逐字节一致。
- 数字 / 行为变动须真跑取证，不靠模型自验（守 §六 验收纪律）。

### 9.8 与 I1 的关系
- consensus 子任务可同时 `useKnowledge:true`（见 §八）→ `ctx.knowledge` 被检索后，N 个 agent 各自基于**同一检索上下文**答辩，`synthesize` 聚合 → 既「多视角」又「有依据」。
- 三者（I1/I2/I3）都从 `ctx` 取数，互不耦合。
