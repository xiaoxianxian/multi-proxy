# l2/ — L2 Agent 编排中枢 P0 落地

P0 第一交付物：互通性地基（决策 2）+ Agent Adapter 协议契约（决策 3）。
P0 模块顺序：**Agent Registry → 插件运行时 → Adapter 协议**（见 MEMORY-2026-09-11「三决策已拍板」）。

## specs/ — 记忆/skill 规范数据格式（决策 2）

**结论：JSON 为 canonical 存储 + YAML 为人类可读视图，双向无损 + specVersion。**

| 文件 | 角色 |
|---|---|
| `agent-memory.schema.json` | JSON Schema（draft-07）：记忆条目契约 |
| `skill.schema.json` | JSON Schema（draft-07）：技能条目契约 |
| `agent-memory.json` / `.yaml` | 记忆示例：canonical ↔ view 一一对应 |
| `skill.json` / `.yaml` | 技能同上 |
| `validate.mjs` | node 侧验证：双向无损 + ajv schema 校验 + 负例（权威） |
| `validate.py` | python 侧验证：yaml 往返 + 结构校验（降级，无 jsonschema 时不装包） |

**已现场验证（2026-09-11 实测，非纸面）**：node 侧 8/8 PASS、python 侧 8/8 PASS。
- node：`JSON==YAML(parsed)` + `YAML round-trip` + `JSON valid against schema` + `bad specVersion rejected`
- python：语义相等 + 双结构校验 + 负例
- 已知噪音：node 打印 `unknown format "date-time" ignored`——ajv 默认不带 format 校验，
  不影响结构/类型/必填/枚举/const；要校验日期格式需装 `ajv-formats`（生产可选，零依赖策略下留钩子）。

**字段草案**（详见 schema，互通性保证在规范格式上无损转换）：
- 记忆：`{id, type, scope, key, value, tags[], source, createdAt, updatedAt, specVersion}`
- skill：`{id, name, trigger, description, content, version, tags[], enabled, source, specVersion}`

复现：`cd l2/specs && node validate.mjs && python3 validate.py`

## adapter-protocol.md — Agent Adapter 协议

任意 agent 接入/卸载的**最小契约**，见 `adapter-protocol.md`。示例骨架 `adapter.yaml`。
决策 3 的端到端样例选 **h3web**（最硬 case，老板定）；P0 只做契约验证，不碰编排/shadow。

## 铁律（落地前必读）

- **④ 非侵入**：绝不写 agent 自身文件（`~/.codex` / `~/.hermes` / `~/.cursor`）；
  只读 + 环境变量注入。adapter 对 h3web 也只读、端口动态探测，不改其任何文件/配置。
- **shadow 优先**：shadow 模式永不改真实路由。
- **互通性**：记忆/skill 在规范格式上无损转换，方案可热替换；`specVersion` 做向后兼容。
