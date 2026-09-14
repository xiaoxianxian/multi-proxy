# Munder Difflin 对 multi-proxy L2 的借鉴点

> 目的：评估「agent 办公室」项目 Munder Difflin（github.com/chaitanyagiri/munder-difflin,
> 5.3k★, MIT, Electron+Pixi.js+xterm.js+node-pty）能否直接给 multi-proxy 用，以及它的设计里
> 哪些能抄进 L2（Agent Registry / 编排引擎 route-engine / hive）。
> 结论速览：**代码不能拆进来（单体 Electron app，MIT 可改但拆不动也不该拆），设计可以抄。**
> 这份笔记只记设计对照，不 import 任何它的代码。

## 1. 它是什么，跟 multi-proxy 的定位差异

| 维度 | Munder Difflin | multi-proxy (L2 方向) |
|---|---|---|
| 核心对象 | 终端 CLI agent（claude/codex/gemini/kimi/qwen/opencode/crush/copilot/cursor） | 模型 API 上游 provider |
| 协同方式 | GOD 编排者(Michael) + 共享 hive（memory/mailbox/blackboard/task ledger） | Agent Registry 能力标签 + 按任务类型路由 |
| 可视化 | Pixi.js 2D 办公室地板，agent 当 avatar 走动、信封 desk-to-desk | Dashboard 卡片 + 运行中任务区块 |
| 智能层 | 每个 agent 是真 CLI 进程（自带 agent loop） | 引擎做任务分类 + 候选排序，不跑 agent loop |

**所以不能"抠 GUI 塞进 multi-proxy"**：那是单体的 Electron+Pixi.js 应用，耦合它的
node-pty / hooks / 办公室场景。多 agent 协同 GUI 是它的主打，但那是个完整产品，
不是可复用组件。

## 2. 真正可借鉴的 5 个设计（按 L2 价值排序）

### ① Stigmergy + 共享 hive（最高价值，直接对 L2 Agent Registry）
Munder 的 hive 是个 git repo，所有 agent 共享的协调介质就是**文件**：
```
hive/
  registry.json   # roster：每个 agent 的 role / capabilities / status / seat
  board.md        # 共享黑板（多方协作编辑的 plan）
  tasks.json      # 任务台账（id, assignee, spec, status, result ref）
  log.jsonl       # 追加式事件流（驱动 UI activity）
  agents/<id>/
    identity.md   # agent 启动时读：我是谁、能力
    memory.md     # 长期记忆，启动读、学习时追加
    inbox/        # 投递给我的消息
    outbox/       # 我要发的消息
    cursor.json   # 已处理到哪条（幂等）
```
**对 L2 的可抄点**：
- L2 现在 `agent-registry.js` 只管 CRUD + 能力标签。Munder 的 `registry.json` 里
  `capabilities` 字段正是 route-engine `byCapability()` 的数据源——可把 registry 的
  schema 扩展成 `{role, capabilities[], status, seat}`，让编排引擎的候选来源与
  agent 的真实角色对齐。
- `tasks.json`（任务台账）= L2 任务级 session（M7 方向）的落盘形态。Munder 用
  纯 JSON 文件 + 单写者，比 L2 现在 SQLite `sessions.json` 更轻；但 L2 已有 SQLite，
  不必回退，只借"任务台账带 spec + result ref + 状态机"的字段设计。

### ② Single-writer-per-file + router 搬箱（并发安全，对 L2 多 agent 并发有用）
Munder 铁律：**每个 agent 只写自己 `agents/<id>/`，跨 agent 投递由 router（主进程）
把 sender 的 outbox 搬到 recipient 的 inbox**。没有两个进程写同一个文件。
消息是"一文件一 JSON + temp→rename 原子写"，绝不共编辑共享 mailbox。
**对 L2**：L2 全栈是"无跨进程锁、last-writer-wins"（session-store 的 known 约束）。
Munder 的 single-writer 模式是升级方向——如果 L2 将来要真跑多 agent 并发协作，
**"写自己目录 + router 搬箱"** 比加锁更稳，值得记进 L2 蓝图。

### ③ GOD 编排者 + 升级策略（直接对 route-engine 的 shadow/live）
Munder 的 GOD agent（Michael）是**常驻的一个普通 claude 进程**，负责 roster/routing/
adjudication/blackboard 誊写/任务台账。关键设计：**routine 请求 GOD 自己解，critical
（破坏性操作/花钱/改范围/解不开的冲突）才升级给 human，且升级是原生嵌在 GOD 自己的
session 里，没有单独审批队列**。
**对 L2**：route-engine 现在是 shadow/dry-run（`PROXY_ROUTING_SHADOW=1` 只记录不触发）。
Munder 给了一条"shadow→live 的渐进升级"范式：引擎像 GOD 一样**分级决策**——
routine 决策自动过（shadow 只记录），critical 决策才 gate 给人。这把 L2 现在
"二态的 shadow/live" 升级成"按决策重要度分级 gate"，比一刀切更安全，也更能落地。

### ④ FIPA-lite 消息 act + hops 防活锁（若 L2 要 agent 间通信）
消息 schema 7 字段，核心是 **act（speech act）**：`request|inform|propose|query|agree|refuse|done`。
防活锁三规则：
- 只有 `request/query/propose` 触发回复（`inform/done` 是终止态）；
- 每条回复 `hops++`，超过上限 → GOD 升级（杀掉两个 agent 互相 ping-pong）；
- 重复看到已处理 id 是 no-op（cursor 幂等）。
**对 L2**：若 L2 的 Agent Registry 要做 agent 间消息（M7 任务 session 的协作层），
这套 act + hops 比"自由文本消息"好控——把"谁会回复、谁终止、几跳必须升级"写进
schema，路由决策可审计。可直接当 L2 消息契约的草案。

### ⑤ Markdown-first 记忆 + MemPalace 语义层（可选，先验证再上）
Munder 明确**不上向量层**（5-15 个 agent 用不上 Letta/Mem0/Zep，且那些框架想 owns
agent runtime，跟它的 CLI-runtime 冲突）。它用 per-agent `memory.md` + 共享黑板 +
SQLite FTS；语义召回走 **MemPalace CLI**（非 MCP），`MEMPALACE_PALACE_PATH` 指向共享
palace，agent 的 memory.md 挖进自己 wing，`mempalace search` 召回。
**对 L2**：L2 互通性 spec 已有"记忆规范"。Munder 的经验是：**先用 markdown + FTS，
向量层只在 keyword 召回不够时才加，且加之前先独立验证其检索质量**（它引第三方审计
说 MemPalace 公开 benchmark 有夸大）。这是 L2 记忆层选型的一个"别过早引入向量"的信号。

## 3. 不能抄 / 不建议抄的
- **Pixi.js 办公室地板**：纯展示层，跟 L2 编排逻辑零关系。要视觉就自己画，别背
  它的 tileset/角色资源（有 ATTRIBUTION.md 版权项）。
- **node-pty + hooks（cth-hook/agy-hook）**：Munder 靠 Claude Code 的 hook 生命周期
  驱动 avatar。L2 不跑 CLI agent loop，不需要这层。
- **单 committer git 审计**：Munder 把整个 hive 当一个 git repo、只有主进程 commit。
  L2 是 HTTP 服务不是 git 工作区，套不上。

## 4. 落地优先级建议
1. **先抄 ①（registry schema + tasks.json 字段）进 L2 Agent Registry** —— 直接喂 route-engine
   `byCapability()`，低风险、纯数据扩展。
2. **再借 ③（GOD 分级 gate 范式）改写 route-engine 的 shadow→live 升级策略** —— 把现在
   "二态 gate" 升级成"按决策重要度分级"，让 live 切换更安全。
3. **记下 ②（single-writer）+ ④（FIPA-lite act/hops）进 L2 蓝图**，等 L2 真做多 agent
   并发协作时再启用，现在不动生产代码。
4. **⑤ 记忆层选型作为决策注脚**：markdown+FTS 优先，向量层延后且先验证。

## 5. 一句话总结
Munder Difflin 是"agent 协同 GUI"的天花板级参考，但它跟 multi-proxy 不是一个赛道：
它是 CLI-agent 运行时 + 办公室可视化，multi-proxy 是模型 API 路由层。直接拿代码 = 背
一个 5k 行的 Electron app；抄设计 = 把 GOD+hive+分级 gate 这套成熟范式并进 L2 的
Agent Registry / route-engine。建议路径：当 blueprint 读，不 import。
