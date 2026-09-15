# l2/ — L2 Agent 编排中枢 P0 落地

P0 第一交付物：互通性地基（决策 2）+ Agent Adapter 协议契约（决策 3）。
P0 模块顺序：**Agent Registry → 插件运行时 → Adapter 协议**（见 MEMORY-2026-09-11「三决策已拍板」）。

## specs/ — 记忆/skill 规范数据格式（决策 2）

**结论：JSON 为 canonical 存储 + YAML 为人类可读视图，双向无损 + specVersion。**

| 文件 | 角色 |
|---|---|
| `agent-memory.schema.json` | JSON Schema（draft-07）：记忆条目契约 |
| `skill.schema.json` | JSON Schema（draft-07）：技能条目契约 |
| `agent-memory.{json,yaml,schema.json}` | 记忆 |
| `skill.{json,yaml,schema.json}` | 技能 |
| `agent-profile.{json,yaml,schema.json}` | Agent Registry 条目（type=codex/hermes/cursor/custom, capabilityTags） |
| `validate.mjs` | node 侧验证：双向无损 + ajv schema 校验 + 负例（权威） |
| `validate.py` | python 侧验证：yaml 往返 + 结构校验（降级，无 jsonschema 时不装包） |

**已现场验证（2026-09-11 实测，非纸面）**：node 侧 / python 侧三类（memory+skill+profile）全 PASS。
- node：每类 `JSON==YAML(parsed)` + `YAML round-trip` + `JSON valid against schema` + `bad specVersion rejected`
- python：语义相等 + 双结构校验 + 负例（每类）
- 已知噪音：node 打印 `unknown format "date-time" ignored`——ajv 默认不带 format 校验，
  不影响结构/类型/必填/枚举/const；要校验日期格式需装 `ajv-formats`（生产可选，零依赖策略下留钩子）。

**字段草案**（详见 schema，互通性保证在规范格式上无损转换）：
- 记忆：`{id, type, scope, key, value, tags[], source, createdAt, updatedAt, specVersion}`
- skill：`{id, name, trigger, description, content, version, tags[], enabled, source, specVersion}`
- profile：`{id, name, type, capabilityTags[], description?, systemPrompt?, toolsAllowed?, maxRounds?, contextLength?, costBudget?, version, createdAt, updatedAt, specVersion}`

复现：`cd l2/specs && node validate.mjs && python3 validate.py`

## adapter-protocol.md — Agent Adapter 协议

任意 agent 接入/卸载的**最小契约**，见 `adapter-protocol.md`。示例骨架 `adapter.yaml`。
决策 3 的端到端样例选 **h3web**（最硬 case，老板定）；P0 只做契约验证，不碰编排/shadow。

## agent-registry.js — Agent Registry 内核（P0 增量 2）

Agent Profile 的 CRUD + 能力标签注册/查询，编排引擎"按能力路由"的地基。
- **非侵入**：默认内存；文件持久化写注入的 `dir`（绝不默认写 home/agent 文件），格式同 `agent-profile.json`，原子写 .tmp→rename。
- **零依赖**：内核仅用 node 内置（schema/校验归 validate，内核可移植）。
- 能力查询 `byCapability(tag)` / `registerCapabilities(id, tags)`——Adapter 启动时声明能力的落点。
- 真跑：`node l2/agent-registry.demo.js`（CRUD + 能力 + 跨实例持久化 + 负例，18 checks 全 PASS）。
- **增量 2b（已落地）**：接 manager HTTP API（`multi-proxy-manager/routes/registry.js` + jest 12/12 + :18792 真跑探测 200/401）。
  route 必须挂在代理 wildcard（`apiRoutes` 的 `/:proxy/*`）**之前**，否则 `/api/registry/agents` 被 `:proxy=registry`
  误捕获并被白名单 404。registry 默认内存存储（非侵入、绝不写 home）；设 `L2_REGISTRY_DIR` 才落文件。

## plugin-runtime.js — 插件运行时内核（P0 增量 3）

插件动态加载 + 生命周期管理（类 DeepSeek Harness 2026-08 的"一切皆插件"）：
- 状态机：`register → enabled → started → stopped`；`unload` 是热插拔的逆操作。
- 热插拔：`loadFromDir(dir)` 扫描 `dir/<name>/index.js`，require 前清缓存（重载拿最新代码）。
- 能力汇总：`listCapabilities()` 聚合所有已启插件能力，供编排引擎按能力路由。
- **非侵入④**：插件 dir 由调用方注入（test 写 os.tmpdir，绝不默认写 home/agent 文件）；零依赖（仅 node 内置）。
- 真跑：`node l2/plugin-runtime.demo.js`（状态机 + 热插拔 + 能力聚合 + 负例，14 checks 全 PASS）。
- 修过 1 个 bug：`validatePlugin` 成功返 `[]` 而 `if(errs)` 对空数组为 truthy（与 registry 内核 `返 null` 不一致）→ 统一为 `errs.length ? errs : null`。

## adapters/h3web-adapter.js — h3web 端到端样例（P0 增量 4 · 收口）

决策 3 的 adapter 契约在真实 HTTP round-trip 下验证（**非侵入**）：
- **协议四类接口**：能力声明 `capabilitiesDeclaration()` / 健康 `health()` / 任务接收 `submit(task)` / 结果回传 `result(taskId)`，外加便捷 `run(task)` 轮询到终态。
- **非侵入④ 实测**：adapter 对 h3web **只读转发**（不写 h3web 任何文件）；端口**动态探测**（`probePort` 取候选中在 LISTEN 的，否则用注入端口，绝不写死）；零依赖（仅 node 内置 http）。
- **下游替身**：用 `mock-h3web.js`（node 最小 HTTP，模拟 h3web 的 `/api/gen`+`/api/status` job 状态机 pending→running→done），零副作用——不起真 h3web、不触 Minimax 云端。**真实"起 8731 h3web + 真文生视频"属 P1**（h3web 未运行、云端费用、时长长）。
- 真跑：`node l2/adapters/h3web-adapter.demo.js`（6 checks 全 PASS）；jest `tests/unit/h3web-adapter.test.js`（5/5 PASS，锁 HTTP round-trip 进 CI）。
- **环境漂移记录（重要）**：实测 8732 上跑的是 `wechat-style-extractor-py` 的 `server.py`（非 h3web）——印证 adapter「必须动态探测、绝不写死端口」的铁律现实价值；故 P0 用 mock 替身验证契约，真实 h3web 接入待 P1 服务起来再做。

## adapters/aigc-adapter.js — AIGC（绘境 AI 生图生视频）样例（P0 增量 5 · AIGC 缺口收口）

据老板反馈（AIGC adapter 缺口 = 本地 `~/Documents/AIGC生图生视频` = 绘境 AI / hujing-ai），把 AIGC 包成第 5 个 adapter 样例，证明「任意本地 HTTP 服务实现 4 接口即可接入 Agent Registry」：
- **真实契约核实（非臆测）**：据 hujing-ai `backend/app/routers/tasks.py` + `schemas/task.py` + `models/task.py` —— `POST /api/v1/tasks`（`{subtype, params}`）+ `GET /api/v1/tasks/:id` + `POST /:id/cancel` + `GET /api/v1/health`；状态机 `pending → processing → 终态 completed|failed|cancelled`；7 种 subtype（text/image/matte/outpaint/bg/style/img2video）。
- **AIGC 独有（区别于 h3web）**：① **OAuth2 Bearer 鉴权**（`_authHeaders` 注入 token；token 由调用方注入，adapter 不打印/不落盘，缺失/错误 → 401）② **任务 cancel 语义**（`cancel(taskId)` POST `/api/v1/tasks/:id/cancel`，支撑 M7 session 崩溃恢复/手动中止）③ `/api/v1` 前缀 + 原生 `/api/v1/health`（无需补桩，比 h3web 更规范）。
- **非侵入④ 实测**：对 AIGC 只读转发（不写其文件、不改配置）；端口动态探测（候选 `[8731, 8732]`，AIGC 实测漂移）；零依赖（仅 node 内置 http）。
- **下游替身**：`mock-aigc.js`（node 最小 HTTP，模拟 AIGC FastAPI 的 `/api/v1/tasks*` 状态机 + Bearer 鉴权 + 7 subtype），零副作用——不起真 AIGC、不触生图/生视频云端。**真实"起 AIGC 服务 + 真文生视频 round-trip"属 P1**（AIGC 当前未运行、需真实 token、需云端调用）。
- 真跑：`node l2/adapters/aigc-adapter.demo.js`（**10 checks 全 PASS**，含鉴权 401 路径 + cancel）。

## decomposer.js + orchestrator.js — 任务拆解 + 编排调度内核（P2 增量 6 · 收口）

L2 P2 编排引擎（蓝图 4.2 / 5.1）的拆解层 + 调度层，P0 route-engine 之上：
- **decomposer.js**：规则模板拆解（`fastapi-jwt` / `video-workflow` 两条内置 + 兜底单节点）+ 可注入 `llmDecompose`（接口预留，不内置 LLM）+ 可注入 `templates` 缝 + `hasCycle` 环检测。**19 checks PASS**。
- **orchestrator.js**：拆解 DAG → 拓扑调度（无依赖子任务并行、条件分支 `when(ctx)` 跳过、重试 `retry` + 降级 `fallback`）→ 经可注入 `executor` 执行 → 聚合（JSON + Markdown 报告）→ 协作历史。
- **非侵入④ + shadow 优先**：默认 shadow 只跑调度不触真实 adapter（executor 零调用）；协作历史默认仅内存，注入 `dir` 才原子落盘（写注入 dir，绝不写 home/agent 文件）；全程零依赖。
- **修复 2 个调度真 bug（真跑发现，非纸面）**：① `for (const id of ready) remaining.delete(id)`——`ready` 元素是子任务对象非 id，导致 `remaining` 永不收敛；② 全 done 时误把全部子任务标 `blocked`。改用 `processed/total` 驱动终止。
- **真跑**：`node l2/decomposer.demo.js`（19 PASS）+ `node l2/orchestrator.demo.js`（16 PASS，含 5 用例 + 条件分支 + 容错重试降级 + 环拒绝 + 非侵入落盘）。

## llm-decomposer.js — LLM 拆解内核（P2.2 · 填 `llmDecompose` 预留缝）

`decomposer.js` 预留的 `llmDecompose` 注入缝，由本内核填充（P2.2 落地，2026-09-15）：
- **`makeLlmDecomposer(cfg)`**：返回 `async (input, opts) => DAG`，形状即 `decompose(input, { llmDecompose })` 缝。默认传输 = OpenAI 兼容 `/v1/chat/completions`（node 内置 http，零依赖，与 `adapters/l1-agent-adapter.js` 同构）。
- **transport 可注入**（cfg.transport）——测试用内存替身不触网络；缺省走 http。
- **四道纪律**：① 非侵入（只产 DAG 数据，不写盘/不改 agent 配置/不触真实上游，shadow 前置）；② **容错优先**——LLM 宕机/非法 JSON/自环 DAG/退化空，一律降级回 `templateDecompose`，绝不把异常冒泡进编排热路径；③ `hasCycle` 对 LLM 输出**复算**（幻觉出环 → 拒收降级）；④ 零 LLM 依赖为默认。
- **`meta.source`** 标识走 `llm` 还是降级 `template(...)`；降级原因归类 `llm-down`/`llm-http-error`/`llm-bad-json`/`llm-error`。
- 生产接线：`routes/orchestration.js` 门控 `PROXY_LLM_DECOMPOSE`（默认关→走内置模板，确定可复现；开→LLM 拆解，LLM 配置全来自 env `PROXY_LLM_BASE_URL/MODEL/TOKEN/TIMEOUT_MS`）。
- 真跑：`node l2/llm-decomposer.demo.js`（**19 PASS**，真起 http 假 LLM + 全降级路径 + 注入 + 接 Orchestrator）；jest `tests/unit/llm-decomposer.test.js`（8 例）+ `tests/unit/orchestration-route.test.js` 扩 2 例。全 manager jest **556/556**（34 suites）。
- **真跑教训**：默认 http 传输首版返回整个 OpenAI 信封当 `content`，致解析失败全降级；修复=传输内解信封取 `choices[0].message.content`，与注入 transport 契约（content=助手消息文本）对齐。

## memory-merge.js — 记忆服务内核（P1.1a · §4.4 公共+个性 + §5.2 非侵入投影）

- 内核：`merge(shared, personal, opts)`（公共+个性按 key 合并，冲突策略 `personal`（默认覆盖）/`shared`/`error`）+ `envInject(merged, opts)`（投影环境变量 `AGENT_SYSTEM_PROMPT/ERROR_PATTERNS/TOOLS_ALLOWED/CONFIG/MEMORY_CONTEXT`，type→目标可配，多同类倒序、超长截断）+ `registerAdapter/getAdapters`（可热插拔 scheme 适配器：json 规范 canonical / yaml-text 纯文本零依赖 / view 摘要）。
- **非侵入铁律（§5.2）**：`envInject` **只产出映射对象、绝不写 `process.env`、绝不碰 `~/.codex·~/.hermes·~/.cursor`**——agent 感知不到中枢，真正注 env 是调用方 agent 启动时拿映射去做。全默认零网络零文件零 LLM。
- 真跑：`node l2/memory-merge.demo.js`（**11 PASS**，含非侵入证明：跑完全程 process.env 不漏内核 5 个 AGENT_* 键）；jest `tests/unit/memory-merge.test.js`（14 例）。全 manager jest **570/570**（35 suites）。规范格式权威校验仍 `node l2/specs/validate.mjs`（ALL PASS）。
- **真跑教训**：① demo 抓到 kernel bug——`merge` 的 `personal` 策略原漏替换胜出方数据字段，致"个性覆盖公共"假绿，修=胜出时用 e 覆盖 cur 全字段；② `process.exit(pass+fail===0?0:1)` 总非零致全绿 demo 在 CI 报 fail，修=`process.exit(fail===0?0:1)`。
- **边界**：P1.1a 止于合并+适配器+投影；P1.1b（agent 启动真注 env 接线 + 持久化）暂无非侵入接入缝，列后续（YAGNI）。

## skill-service.js — 技能服务内核（P1.1b · §4.5 Skill CRUD / 版本 / 市场 / 规范格式适配）

- 内核：`createSkillService({ clock })` 纯内存 store——`create(raw, opts)`（id 缺省 `skill-<name-slug>`、version 缺省 `1.0.0`、enabled 默认 true）/ `get`（id 或 name 取最新 version）/ `update`（缺省 bump patch）/ `bump(key, { version })`（保留旧版本、旧版禁用新版启用）/ `rollback(key, target)`（翻启用权到旧版）/ `remove` / `list(filter)`（source/tags/enabled + 默认折叠同名最新）/ `search(q)`（case-insensitive 子串）/ `toCapabilities()`（投影最新启用版给编排器/Registry）；市场 `registerBuiltin`/`upload`（带 source 标签的 create，YAGNI 不另起）；`validateSkill` 轻量校验（必填 + 类型 + version 形如 X.Y.Z），`toEntry` 在校验前 stamp 默认值。
- **可热插拔适配器（§4.8）**：`json`（规范 canonical）/ `yaml-text`（纯文本零依赖往返）/ `view`（摘要去 content）+ `registerAdapter(name, {toDoc, fromDoc})`。
- **非侵入铁律**：纯内存、不写盘、不写 `process.env`、不碰 `~/.codex·~/.hermes·~/.cursor`；全默认零网络零文件零 LLM。
- 真跑：`node l2/skill-service.demo.js`（**13 PASS**）；jest `tests/unit/skill-service.test.js`（13 例）。全 manager jest **583/583**（36 suites）。规范 `specs/skill` validate 仍 ALL PASS（未动规范）。
- **真跑教训（本轮·3 坑）**：① `create(raw, opts)` 原忽略 `opts` → `registerBuiltin` 的 `{source:'builtin'}` 被丢弃、source 恒 fallback；修=`{...raw, ...opts}` 合并再 stamp。② jest 测试隔离假失败（`beforeEach` 全 fresh，断言了依赖跨测试的 `_store`）；修=测试自包含。③ 校验 assertion 正则过宽；修=构造缺字段 raw 精确断言 `missing content`。
- **边界**：P1.1b 内核已落地；生产接线（API 路由 + 持久化 `~/.multi-proxy-manager/`）列后续（YAGNI，无非侵入接入缝）。

## alert.js — 告警服务内核（P2 健康监控增强 · §4.6 告警机制 · 信号驱动 + 非侵入 observe）

- 内核：`alert.js`（~220 行，全内存，零 manager 依赖）**信号注入式**消费健康信号——不 `require('../lib/*')`、不触 manager 热路径，信号（`provider-health.listIsolated()` / `error-patterns.getHistory()` 的产出）由调用方注入。`evaluate(signal)` 纯判定产告警数组。
- **4 条内置规则**映射 §4.6 增强：`provider-network-wide`（跨 proxy 全网故障 → critical）/ `provider-unhealthy`（单点连续失败进隔离窗口 → warning）/ `error-pattern-frequent`（错误频次≥`errorFrequencyThreshold` 默认 5，≥4× 阈值升 critical）/ `cost-budget-exceeded`（成本≥预算 → warning，**规则就位但 `forward.js` 暂无 usage 埋点 → 不采集则不触发，YAGNI**）。`signal.source` 三态 `provider-health` / `error-patterns` / `cost`。
- **非侵入 + 门控**：`PROXY_HEALTH_ALERT` 默认关 = **observe**（事件照常判级 + 收集进内存 `events[]` + cooldown 去重，但 sink 不真发；即使 `persist:true` 也不落盘，门控权在内核不在调用方）；开（=1/true/on）= 真 dispatch 各 sink，落盘 `alert-events.jsonl`。
- **防告警风暴**：`cooldownMs`（默认 5min）对同 `(rule+key)` 去重，窗口内第二次 `deduped=true` 不再 dispatch，超 cooldown 重发。
- **可插拔 sink**：`log`（默认收集型零副作用）/ `registerSink(name, fn)` 热插（邮件/Telegram/微信 sink 在此挂），`dispatch` 每 sink 包 try/catch 隔离（单个崩不影响其它/主流程，best-effort）；工厂 `createAlertService({store})` 每实例独立 events store（测试隔离）。
- **真跑教训（本轮·3 条）**：① 信号注入式是 l2/ 内核统一范式——要消费 manager 的 provider-health/error-patterns 又不破坏内核自包含，解法不是 require manager lib，而是让调用方注入现成信号（同 memory-merge envInject 接 merged、orchestrator 接 DAG）。② 非侵入用「门控跳过落盘 + 断言 `fs.existsSync===false`」双向验证——jest 用 `setEventsFile(tmp)+emit(persist:true)+断言文件不存在` 证 observe 下即使调用方要求落盘也不落盘。③ 成本块「规则就位但不采集则不触发」是 YAGNI 正形态，未接的信号源=未触发的规则，不强行接。
- 真跑：`node l2/alert.demo.js`（**13 PASS**）；jest `tests/unit/alert.test.js`（13 例）。全 manager jest **596/596**（37 suites，+13 零回归）+ l2 六 demo 全绿（decomposer 19 / orchestrator 16 / llm-decomposer 19 / memory-merge 11 / skill-service 13 / alert 13）。
- **边界**：P2 告警服务内核已落地；成本分析（A usage 埋点 / B 余额趋势）+ 生产接线（调度 emit + 路由 + sink 实发 + agent 注 env + 持久化）列后续（YAGNI，暂无非侵入接入缝）。

## 铁律（落地前必读）

- **④ 非侵入**：绝不写 agent 自身文件（`~/.codex` / `~/.hermes` / `~/.cursor`）；
  只读 + 环境变量注入。adapter 对 h3web 也只读、端口动态探测，不改其任何文件/配置。
- **shadow 优先**：shadow 模式永不改真实路由。
- **互通性**：记忆/skill 在规范格式上无损转换，方案可热替换；`specVersion` 做向后兼容。
