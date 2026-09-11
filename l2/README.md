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

## 铁律（落地前必读）

- **④ 非侵入**：绝不写 agent 自身文件（`~/.codex` / `~/.hermes` / `~/.cursor`）；
  只读 + 环境变量注入。adapter 对 h3web 也只读、端口动态探测，不改其任何文件/配置。
- **shadow 优先**：shadow 模式永不改真实路由。
- **互通性**：记忆/skill 在规范格式上无损转换，方案可热替换；`specVersion` 做向后兼容。
