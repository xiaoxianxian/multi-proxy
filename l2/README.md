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

## 铁律（落地前必读）

- **④ 非侵入**：绝不写 agent 自身文件（`~/.codex` / `~/.hermes` / `~/.cursor`）；
  只读 + 环境变量注入。adapter 对 h3web 也只读、端口动态探测，不改其任何文件/配置。
- **shadow 优先**：shadow 模式永不改真实路由。
- **互通性**：记忆/skill 在规范格式上无损转换，方案可热替换；`specVersion` 做向后兼容。
