# L2 Agent 编排中枢 — 落地案例（Cases）

> 配套文档：`L2-BLUEPRINT.md`（架构与排期）/ `l2/README.md`（模块清单）/ `l2/PERF-REPORT.md`（性能）。
> 三个案例均由 demo 真实运行产出，非纸面描述。复现命令在每节末尾。
> 运行环境：macOS M5 / Node 22.22.3 / jest 实测 635/635（40 suites）。
> 生成日期：2026-09-16。

L2 内核统一范式：**信号注入式 + 非侵入 + 门控默认关 + shadow 优先**。三案例分别覆盖
**编排（orchestrator+decomposer）**、**告警（alert）**、**成本（cost + A 路埋点）** 三条主线，
都是「内核确定性可跑 + 生产接线门控非侵入」的闭环。

---

## 案例一：编排引擎视频工作流（orchestrator + decomposer）

**目标**：把「做一个视频」这类自然语言任务，自动拆成 DAG 子任务、拓扑调度、条件分支、
失败重试/降级、结果聚合，全程可 shadow（不触真实执行）、可落盘协作历史。

**内核**（`l2/decomposer.js` + `l2/orchestrator.js`）：
- `decomposer.js`：`templateDecompose` 内置规则模板（`video-workflow` / `fastapi-jwt` / 兜底单节点）
  + 可注入 `llmDecompose` 缝（P2.2 由 `llm-decomposer.js` 填充）+ `hasCycle` 环检测。
- `orchestrator.js`：拆解 DAG → 拓扑调度（无依赖并行、`when(ctx)` 条件跳过、`retry`+`fallback` 容错）
  → 经可注入 `executor` 执行 → 聚合（JSON + Markdown）→ 协作历史。
- **非侵入④ + shadow 优先**：默认 shadow 只跑调度不触真实 adapter（executor 零调用）；
  协作历史默认仅内存，注入 `dir` 才原子落盘（写注入 dir，绝不再 home/agent 文件）；全程零依赖。

**视频工作流模板**（`decomposer.js:BUILTIN_TEMPLATES[video-workflow]`，`match: /视频|短片|video/i`）：
```
storyboard ──┬── gen-clip-a ──┐
            └── gen-clip-b ──┴── compose（合成 + 音频，deps=[a,b]）
```
4 节点、`compose` 严格排在两个片段之后——这正是案例「编排视频」的骨架（UC2/UC4 实测验证执行序）。

**生产接线**：`routes/orchestration.js` 门控 `PROXY_ORCHESTRATION`（默认关 → 403）、
shadow 默认开；P2.2 `PROXY_LLM_DECOMPOSE` 门控决定是否走 LLM 拆解（默认关走内置模板，确定可复现）。

**实测（`node l2/orchestrator.demo.js`，16/16 PASS）**：
```
PASS UC1: 4 子任务全 done / shadow 不产生真值 / 协作历史登记
PASS UC2: 5 子任务全 done / A/B 并行的前置(片段)都 done
PASS UC3: 条件 false 的 branch-b 被 skip / 条件 true 的 branch-a 执行
PASS UC4: 非 shadow 经 executor 执行 / 聚合 JSON+markdown / 执行序含 compose 在片段之后
PASS UC5: flaky 经 retry 耗尽后降级 fallback 成功 / 备用确实被调用
PASS UC6: 循环依赖 DAG 被拒调度
PASS UC7: 协作历史落盘到注入 dir（非 home）+ 内容含 runId + 子任务
PASS shadow: 不触碰 executor（非侵入）
orchestrator demo: 16 checks PASS   exit 0
```
配套 `node l2/decomposer.demo.js` 19/19、`node l2/llm-decomposer.demo.js` 19/19
（真起 http 假 LLM + 全降级路径：宕机/非法 JSON/自环 DAG 一律降级 template）。

**复现**：`node l2/orchestrator.demo.js && node l2/decomposer.demo.js && node l2/llm-decomposer.demo.js`

---

## 案例二：告警服务（alert · 信号驱动 + 非侵入 observe）

**目标**：消费健康/错误/成本信号，4 条内置规则判级、cooldown 去重防风暴、可插拔 sink，
默认 observe（只判级收集、不真发、不落盘）——内核确定性、生产门控非侵入。

**内核**（`l2/alert.js`，全内存零 manager 依赖）：
- **4 条内置规则**：`provider-network-wide`（跨 proxy 全网故障 → critical）/
  `provider-unhealthy`（单点 unhealthy → warning）/
  `error-pattern-frequent`（错误频次 ≥ 阈值默认 5，≥ 4× 升 critical）/
  `cost-budget-exceeded`（成本 ≥ 预算 → warning）。
- **信号注入式**：`evaluate(signal)` 纯判定，内核不 `require('../lib/*')`——信号由调用方注入
  （同 memory-merge `envInject`、orchestrator 接 DAG 的统一范式）。
- **cooldown 去重**：`cooldownMs`（默认 5min）对同 `(rule+key)` 去重，窗口内第二次 `deduped=true` 不发。
- **可插拔 sink**：`log`（默认收集型零副作用）/ `registerSink(name,fn)` 热插 / `dispatch` 每 sink 包 try/catch 隔离。
- **非侵入 + 门控**：`PROXY_HEALTH_ALERT` 默认关 = observe（即使 `persist:true` 也不落盘，门控权在内核）；
  开 = 真 dispatch + 落盘 `alert-events.jsonl`。

**生产接线**：`routes/alert.js`（`/api/alert`、门控 `PROXY_HEALTH_ALERT` 默认 403、live 冒烟 403/200 实证）
三源拉式采集：`provider-health.listIsolated()` / `error-patterns.getHistory()` / `cost.js.produceAlertSignal`。

**实测（`node l2/alert.demo.js`，13/13 PASS）**：
```
PASS 规则1 provider-network-wide → critical
PASS 规则2 provider-unhealthy → warning
PASS 规则3 error-pattern-frequent（5→warning / 20→critical）
PASS 规则4 cost-budget-exceeded → warning
PASS 不触发：健康+低频+预算内
PASS 门控默认 observe（PROXY_HEALTH_ALERT 未设）
PASS 去重 cooldown（同 rule+key 窗口内只算一次）
PASS cooldown 过后重新触发（deduped=false）
PASS registerSink 热插拔 + dispatch（门控开真发）
PASS 非侵入：observe 模式 emit 不落盘 / 不触 fs
PASS list/count/reset 查询
PASS setConfig 调 errorFrequencyThreshold + cooldown
PASS registerSink 参数校验（必须 name+fn）
[Alert-Service demo] PASS 13 / 13   exit 0
```
配套 jest `tests/unit/alert.test.js` 13 例 + `tests/unit/alert-route.test.js` 8 例（零回归进 620）。

**复现**：`node l2/alert.demo.js`

---

## 案例三：成本分析（cost 内核 B 路 + A 路 token×单价 埋点 + 喂告警）

**目标**：从「余额趋势」和「token×单价」两路进料算消费/趋势/报告，并喂 alert `cost-budget-exceeded`；
A 路热路径埋点门控非侵入、可复现精确金额。

**内核（B 路，`l2/cost.js`，信号源无关）**：
- `createCostService({store, clock, maxSnapshots})` 独立 store（工厂隔离）；
  `record(name, balance, {now,...})` 追加快照算消费（余额上升封顶 0，不误报负消费）；
  `consumption/name` / `trend(name)` / `report({windowMs})` 窗口聚合。
- **喂 alert**：`produceAlertSignal(name, {budget})` → `{source:'cost', providerId, cost, budget}`
  （alert.js 契约，喂了就算；端到端实证 cost 产信号 → alert.evaluate → `cost-budget-exceeded`）。
- **非侵入 + 门控**：`PROXY_COST_TRACK` 默认关 = observe（`persist:true` 也不落盘 `cost-snapshots.jsonl`，
  断言 `fs.existsSync(tmp)===false` 实证）；开 = 落盘。
- **clock 注入**：窗口裁剪类内核一律注入 `clock`，确定性时间戳不被真实 `Date.now()` 滤出窗口
  （「paper 推算必漏、真跑才暴露」类坑）。

**内核（A 路，`lib/cost-track.js` + `forward.js:168` 热路径，门控非侵入）**：
- `accumulate(proxyName, usage)`：门控关时零开销（仅 `enabled()` 布尔判断 + 不建 state + 不写盘）；
  开时从 upstream `usage` 提 token 数（兼容 OpenAI `prompt_tokens/completion_tokens` +
  Anthropic `input_tokens/output_tokens` + `cache_read_input_tokens` 缓存折扣），按 per-proxy `pricing` 累计 cost。
- 接线 `forward.js:168`：`res.json(response.data)` 前
  `if (rest==='/v1/chat/completions' && response.data?.usage) try { require('./cost-track').accumulate(...) } catch {}`
  ——只读 usage、不改 response、非致命 try/catch 隔离，热路径改动 < 1 行 + 门控关零副作用。
- `setPricing(name, {input,output,cacheHit?})` **幂等**（保留已累 tokens/cost、只换 pricing）；
  无 pricing 默认 0（本地模型 cost=0、仍累 token 数）。

**实测（`node l2/cost.demo.js`，14/14 PASS）**：
```
PASS 余额趋势→消费额：100→40 消费 60
PASS 余额上升→消费封顶 0（充值不误报负消费）
PASS 多 provider 聚合 + 币种透传
PASS 窗口过滤：小窗口只计窗口内消费
PASS 喂 alert.js：cost ≥ budget → cost-budget-exceeded
PASS 喂 alert.js：预算内 cost < budget → 不触发
PASS 信号源无关：A 路（token×单价累计）喂同一 record() 入口
PASS 门控默认 observe：record 默认不写盘
PASS 门控 PROXY_COST_TRACK=on：record 落盘 snapshot
PASS setConfig maxSnapshots 裁剪
PASS 非侵入：默认不写 home、process.env 不漏内核键
PASS 工厂实例隔离：两个 svc 互不影响
PASS report：窗口内消费聚合、按 spent 倒序
PASS 容错：NaN 余额 coerce 0 / 空序列安全
[Cost-Service demo] PASS 14 / 14   exit 0
```

**A 路 live 冒烟（真跑核实，非纸面）**：
```
gate-off getAll keys: 0            ← 门控关 = 非侵入实证（不建 state、不写盘）
OpenAI 3×(1000×10/1M + 500×20/1M) = 0.06        ← 精确复现
after re-setPricing codex cost 仍 0.06          ← 幂等不清零实证
Anthropic cacheHit(1M−0.4M)×25/1M + 0.1M×125/1M + 0.4M×3/1M = 28.7   ← 精确复现
```
配套 jest `tests/unit/cost.test.js` 16 + `cost-track.test.js` 15（全量 635/635 零回归）。

**复现**：`node l2/cost.demo.js`；A 路冒烟见 `lib/cost-track.js` live smoke（`PROXY_COST_TRACK=on`）。

---

## 三案例共性（L2 内核纪律）

| 维度 | 三案例统一做法 |
|---|---|
| 非侵入 | 门控默认关 → 热路径零副作用；绝不写 `~/.codex·~/.hermes·~/.cursor`；不写 process.env |
| shadow | 默认 shadow 只判/调度不触真实执行；shadow 模式永不改真实路由 |
| 信号注入式 | 内核不 require manager lib，信号由调用方注入（`evaluate`/`record`/`run`「喂了就算」）|
| 确定性 | 时钟/传输/store 全可注入；内核测试一律注入 clock + 独立 store，finally 还原 env |
| 门控 | `PROXY_ORCHESTRATION`/`PROXY_LLM_DECOMPOSE`/`PROXY_HEALTH_ALERT`/`PROXY_COST_TRACK` 默认关，显式 opt-in |
| 交付诚实 | 数字来自 demo/live 真跑，非「修好实际没改」；边界 YAGNI 诚实标注 |
