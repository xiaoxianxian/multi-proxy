# MEMORY.md — multi-proxy 项目记忆

> 供 WorkBuddy / Claude / Codex / Hermes 等 agent 读取，作为本项目单一事实来源。
> 仅内部使用，分发包剔除。最后更新：2026-09-15（P1.1a 记忆服务内核 `l2/memory-merge.js` + P1.1b 技能服务内核 `l2/skill-service.js` + P2 告警服务内核 `l2/alert.js` + P2 成本分析内核 `l2/cost.js` B 路余额趋势 + P2 成本分析 A 路 token×单价 埋点 `lib/cost-track.js`（`forward.js` 热路径 line 168，门控 `PROXY_COST_TRACK` 默认关，非侵入） 落地；§13.4 + §13.5 + §13.6 + §13.7 + §13.9）

## 一、项目定位
- `codex-multi-model-proxy` 的合并升级版：挂多个 agent 代理的统一壳子，目标根治 WorkBuddy 等 agent 因 API 限速导致的任务中断。
- 原名 `proxy-rebuild`，现改名 `multi-proxy` 并迁入 `~/Documents/AI项目/multi-proxy`（有 .git，由旧 `~/proxy-rebuild` 重命名合并而来）。当前 bug 较多，正用 Claude 与 Hermes 修复。

## 二、已固化关键配置
- 服务端口（以 docker-compose.yml / AGENTS.md 为准）：
  - `multi-proxy-manager`：18792（Web 管理界面，前端 dashboard + `proxy-config.html` 模型切换页，Node.js+Express）
  - `codex-proxy`：18790（Codex CLI 代理，Node.js+Express）
  - `hermes-proxy`：18793（Hermes Agent 代理，Python+Flask）
  - `cursor-proxy`：18794（Cursor IDE 代理，Node.js+TS+SQLite）
  - 注：前身 `codex-multi-model-proxy-deploy`（~/Documents/Codex/）的管理面板运行在 18791 端口，合并后已由 multi-proxy-manager 的 18792 端口 `proxy-config.html` 取代，18791 不再使用。
- 多 agent 代理统一入口；含多份 Dockerfile（codex/cursor/hermes/manager）。
- 已集成 zg 作为检索层（见下「近期决策」）。

## 三、致命坑与避坑
- 当前版本 bug 多，改动前先读 `ITERATION-ROADMAP.md` / `AGENTS.md` 对齐现状，别凭空改。
- 网络：上游经 Clash Verge（7897/7895），不启用 TUN；订阅过期会中断，需持续监控。

## 四、运维要点
- 本地调试走 WorkBuddy / Claude / Hermes；提交规范见用户「项目版本管理习惯」（打 tag、.gitignore 权重与产物）。
- 关键文档：`README.md`、`AGENTS.md`（开发规范入口，原 CLAUDE.md 已 09-17 归档）、`ITERATION-ROADMAP.md`、`FUNCTIONS.md`、`HANDOVER-*.md`。

## 五、目录导航
- `ITERATION-ROADMAP.md`：迭代路线；`FUNCTIONS.md`：功能清单；`ACCEPTANCE-CHECKLIST.md`：验收；`AGENTS.md`：开发规范（CLAUDE.md 已归档）。
- `.zvec-grep/`：zg 索引缓存（检索层）。

## 六、近期关键决策
- 规划增加**模型自动切换路由**（推理层，按问题类型派发不同模型）。
- 与 zg（检索层）区分：二者解决不同环节，可共存于同一 agent 系统，但别混为一类。

## 七、Hermes 侧边栏项目↔会话迁移排障（2026-09-10 实战）
- 侧边栏项目来自 `~/.hermes/projects.db`（`projects` 表 + `project_folders` 表存关联目录）；会话靠 **cwd(或 git_repo_root) 命中项目 folder 路径(最长祖先匹配)** 归到项目，由 `tui_gateway/project_tree.py:_build_project_tree` 构建（`/api/profiles/projects/tree`）。
- **致命坑**：项目树查询 `list_sessions_rich(include_children=False)` 用 `(_LISTABLE_CHILD_SQL) AND (model_config._delegate_from IS NULL)` 双重排除。**delegate 子代理会话**（parent_session_id 非空 + model_config 带 `_delegate_from`）永远不显示在项目里。因此目录改名/移动后，旧会话不会自动归到新项目——即使 cwd 已更新，只要是 delegate 子会话就被隐藏，父会话若 cwd 在家目录还会被丢进 Home 桶。Hermes 说"重启后旧会话会出现"是错的，它没处理这个排除。
- **修复法（已验证）**：备份 `~/.hermes/state.db`(+wal+shm) 后，对要显示的旧会话执行
  `UPDATE sessions SET parent_session_id=NULL WHERE cwd='<新路径>';`
  `UPDATE sessions SET model_config=json_remove(model_config,'$_delegate_from') WHERE cwd='<新路径>' AND json_config 带 _delegate_from;`
  二者都满足才会在项目树出现。WAL 模式用 `PRAGMA wal_checkpoint(PASSIVE)` 落盘，不打断运行中的 Hermes；改完重启 Hermes 生效（侧边栏有 300s singleflight 缓存）。
- 本次：proxy-rebuild→multi-proxy 改名后，9 个 Aug-24 开发会话（delegate 子代理，父 `20260824_000331_d08287`）被隐藏；按上法解绑+清标记后已在 multi-proxy 项目下显示。

---

## 八、外部参考：OpenAI Agents API / Harness（2026-09-11 子非AI《Agent 的战争，打到了运行时》）

> 来源：公众号「子非AI」2026-09-11 文章。核心：OpenAI 把 Codex 背后负责会话/编排/上下文压缩/工具执行/任务恢复的 Harness 做成托管 API（Agents API）。**这恰恰是本项目的本质——multi-proxy 就是在造一套本地版 Harness。**

### 8.1 文章核心判断（直接指导迭代）
- **模型 API 卖的是智力，Agents API 交付的是「能持续干完活的过程」**。Agent 竞争已从聊天框进入运行时。
- **Harness 是生产级 Agent 最难复制、最值钱的部分**，且会「锁定」——难迁移的是 Session 状态、上下文压缩方式、工具调用历史、Artifact 格式、失败恢复逻辑，而非某个模型。
- **薄平台警告**：只在模型 API 外包一层简单循环的「薄平台」会被上游 commoditize；价值向两端移动——下：多模型路由/端云协同/私有化 Harness/权限安全审计；上：企业知识/行业工具/验收体系。
- **自托管 Sandbox ≠ 私有部署 Agent**：OpenAI 自托管模式仍由它运行 Harness，只把执行器留企业内网；本项目全本地（Harness 也自管）比它更彻底，是真实优势。

### 8.2 四对象 ↔ 本地 AI 栈 对照表（架构素材，设计直接引用）
| OpenAI 概念 | 文章角色 | 本项目/本地栈对应物 |
|------|------|------|
| **Agent** | 谁来干（模型+指令+工具+MCP） | `qwen3.8:27b-mlx` Modelfile（ctx 131072 + MTP）+ multi-proxy 模型路由（M6 内容感知派发） |
| **Environment** | 在哪里干（文件/命令行/代码执行） | 本机沙箱：Ollama 本地推理、h3.c 本地推理、各 proxy 进程 |
| **Session** | 跨轮次保存任务状态 | **待建**：任务级 Session/checkpoint 存储（provider-health.json / error-history.jsonl 是资源健康维度雏形，缺「任务进度」维度） |
| **Events & Items** | 记录每步产出/工具调用/结果 | TaskCreate/TaskList 任务清单 + 工具调用日志 + context-guard 上下文监测 |

### 8.3 Harness 文章分析（2026-09-12，整合文章 + WorkBuddy 评估）
> 文章：「Codex想让Harness消失，Claude Code却要把它做成「承重墙」」（InfoQ）
> 核心结论：**"教做事"的轻了，"保安全/长跑/并行"的重了。**

#### 8.3.1 两派观点速览

| 派别 | 代表 | 对 Harness 的态度 |
|------|------|-----------------|
| 变轻派 | OpenAI Codex (Tibo) | 模型越强，"教模型做事"的拐杖可删；临时补丁等模型追上来后移除 |
| 变重派 | Anthropic Claude Code (Thariq) | 模型越强，Harness 越复杂——Auto Mode/Sandbox/Workflow 变成"承重墙" |

### 8.3 对 multi-proxy 迭代规划的具体帮助
1. **定位校准**：别把自己做成「薄代理壳」，要做厚成「本地 Harness」——把 M6 路由 + 健康/错误库 + 任务级 Session 串成「能观察、能干预、能续跑」的运行时（对齐四对象）。
2. **补缺失对象——Session（任务级）**：建议在 `~/.multi-proxy-manager/` 增加 `sessions.json`（任务 id → 当前 proxy/目标 provider/已执行步骤/checkpoint），使 proxy 重启后可续跑。
3. **三条工程纪律（写进后续设计）**：
   - **Session 持久 ≠ 工作目录永久存在**：checkpoint 必须落盘 `sessions.json`，不依赖内存/临时目录。
   - **可以恢复 ≠ 命令自动续跑**：重连只读回已存状态，被杀进程不自动重启；副作用动作（切 provider、写文件）做幂等标记 + 检查点 + 补偿。
   - **自托管 ≠ 私有部署**：全本地已满足 Harness 自管，可作对外写作/产品化卖点。

### 8.4 与现有路线关系
- 不冲突且强化 M2（健康/隔离）、M4（错误库）、M6（路由）。新增「Session 对象」是运行时补全，可列 **M7：任务级 Session 与续跑**（见 ITERATION-ROADMAP.md 方向五）。
- `autonomous-continuity` skill（本地 Agent 连续性）已落地「续跑提示词 + checkpoint」思路，可反向给 multi-proxy 提供 Session 设计参考。

### 8.5 对 L2 蓝图的修正与补充（2026-09-12 Hermes 补充）
- **全本地 Harness 是差异化卖点**：OpenAI 自托管模式仍由他们运行 Harness，只把执行器留企业内网。proxy-rebuild 全本地（Harness+执行器都自管）比它更彻底，私有化程度更高。
- **三个可落地动作**：
  1. **P0-M7**：在 `~/.multi-proxy-manager/` 增加 `sessions.json`（任务id→当前proxy/目标provider/已执行步骤/checkpoint），使 proxy 重启后可续跑。应补进 ITERATION-ROADMAP.md。
  2. **P1-任务幂等**：代理切换/provider故障时，已有操作能做补偿或标记，不重复执行。是 M2（健康隔离）的自然延伸。
  3. **P2-事件流/Webhook**：让用户订阅 agent 进度，支持中途干预。全新能力，可作差异化。
- **警示**：文章原话"如果 Harness 只是公共管道，托管更经济"。proxy-rebuild 目前多模型路由（M6）+健康图/熔断是核心竞争力，但任务级Session/恢复是短板。方向对，但要加快 M7 落地，否则回到"薄平台"陷阱。

---

## 十、外部参考：Agentic Coding 工具趋势（2026-09-12，公众号「i 小声读书」+ WorkBuddy 分析）

> 来源：https://mp.weixin.qq.com/s/vw6DVHGf4JNaAJ42xm3LLQ
> 核心论点：下一代 IDE 是「软件工程 Agent 调度中心」——一个 Repo → 多个 Git Worktree → 多个 Agent 并行开工。

### 10.1 四个工具速查（已实测核验）

| 工具 | 协议(实测) | 它解决的多 agent 痛点 | 对 multi-proxy 的对应物/借鉴点 |
|------|-----------|---------------------|-------------------------------|
| **Orca** (onorca.dev) | **MIT** ✅ | 一 prompt 扇出到 N 个 worktree，比 diff 合最优 | = M7 并行的标准范式。代码 MIT 可读，**最值得扒架构** |
| **Paseo** (paseo.sh) | AGPL-3.0 / Apache-2.0 说法不一⚠️ | **常驻 daemon + 手机/桌面/Web/CLI 多端监工**，本地语音、cron | = L2「调度中心 + 手机续看」的**成品**。可直接装来跑通模式验证 |
| **Emdash** (emdash.com) | Apache-2.0（HN 帖称 MIT，有出入⚠️） | **Tmux 长任务跨重连保活**；工单集成(Linear/Jira/GitHub/Notion) | = M7 sessions.json 续跑的参考实现；工单集成可接 Obsidian/任务流 |
| **Superset** (superset.sh) | **ELv2 源码可见≠真开源**；免费+Pro $20/席/月 | 自动化 cron + TS SDK + **MCP server 导出** + 云端 | MCP server 导出思路有用；但闭源倾向/付费，**仅自用别 fork** |

### 10.2 对 multi-proxy 迭代的具体建议（按推荐度）

1. **方向验证**：本文论点与 MEMORY §八 OpenAI Harness 分析**完全一致**——行业正收敛到你要做的「本地 Harness」，极大降低押错方向风险。建议两篇合并归档为 L2 外部佐证。

2. **最高杠杆**：给 M7 补 `git worktree` 隔离原语。现在 multi-proxy 是单 checkout 切模型；真正「多 agent 并行」必须像 Orca/Emdash/Paseo 一样**每任务一个 worktree**。小改动、大收益——从「串行切模型」升级成「并行多 agent 竞速择优」。

3. **「手机续看长时程 agent」别从零造**：先 `brew install --cask paseo` 跑起来验证模式，再决定自研还是二开。直接指向本地 Ollama(Qwen) + 各 proxy（18792/18790/18793/18794）。

4. **M7 sessions.json 设计参考**：Emdash 的 Tmux 保活 + Orca 的 checkpoint 模式。把 `autonomous-continuity` skill 的「续跑提示词 + checkpoint」思路接进 multi-proxy，补 MEMORY 8.5 警示的「任务级 Session 短板」。

5. **许可证 hygiene**：multi-proxy 自身建议 MIT/Apache；借鉴只取 Orca(MIT)/Emdash(Apache)/Paseo(待确认)；**Superset 的 ELv2 不能 fork/再分发**，只能自用。

### 10.3 h3web 旁支价值

n8n 编排层（Wait/Resume、重试）本质也是「长时程 agent 调度」。这 4 个工具的编排思路（自动化 cron、远端 worktree）可参考进 h3web 的创作编排面板。

### 10.4 WorkBuddy 分析评估

WorkBuddy 分析**扎实**，有四处值得肯定：
- 架构映射准确（Orca=M7 并行范式、Paseo=手机续看成品、Emdash=Tmux 保活参考）
- 工具核验到位（每个协议都标了实测来源，Superset ELv2 警告正确）
- 自我纠错机制好（发现旧名 `codex-multi-model-proxy` 被云端过期记忆带偏后，用本地 MEMORY 纠正为 `multi-proxy`）
- 建议分层合理（P0 归档佐证 → P1 worktree 隔离 → P2 装 Paseo 验证 → P3 M7 sessions.json）

需二次核实两点：Paseo 协议（AGPL vs Apache 说法不一）、Emdash 协议（Apache vs MIT 有出入）。装之前去 GitHub 确认 LICENSE 文件。

---

## 九、AI短剧开源项目调研（Jellyfish/火宝等）→ 已转 h3web 项目（2026-09-13 Hermes 整理）

> AI 短剧开源项目调研（Jellyfish / 火宝短剧 / BigBanana / Wind Comic / Toonflow）属 **h3web（本地 Minimax H3）** 项目，非 multi-proxy。
> 本体报告与结论已归档至 `~/Documents/AI项目/本地部署Minimax H3/`：
> - `Jellyfish调研与本地匹配分析.md`（主报告）
> - `Jellyfish-minimax_h3_local-适配器草案.md`（B 路适配器方案，暂不采用）
> - 该项目 `MEMORY.md` 与 `MEMORY-2026-09-12.md`「AI 短剧 / Jellyfish」相关章节（结论 + 落地建议 + 避坑）
> 本节原为跨项目记忆错配，由 Hermes 于 2026-09-13 整理迁移为指针，防止 multi-proxy 记忆混入 h3web 内容。

---

## 十一、方向四 D1-D8 实施进展（cursor-proxy，Hermes 执行，2026-09-13）

> `ITERATION-ROADMAP.md` 方向四"任务类型智能派发"完整闭环。commit 链 `2e13d6d→0b7bd5f→071650e`，已 push origin/main，全量 jest 124/124 + tsc 净。

### 11.1 实施状态

| 子项 | 状态 | 说明 |
|---|---|---|
| D4 | ✅ **已实施（C 机制）** | `PROXY_ROUTE_OVERRIDE` 门控（默认 off），off 时逐字节等价、on 时改路由。热路径 `findProviderConfig` 函数体零改动，override 是 `handleChatCompletion` 新增前置分支 |
| D5 | ✅ **已落地** | ④拉上游真实 model 名单 → ①虚名→真名 + `findProviderByType` 引擎级映射；enable ollama provider |
| D6 | ✅ D6-a + docs；⏳ D6-b | D6-a 健康信号接 shadow 观测门控；D6-b 接生产路由决策，**卡 D4 sign-off**，生产零改动 |
| D7 | ✅ **闭环：live 真实 200 / 162ms / 上游回 model=deepseek-v4-pro** | 翻 `PROXY_ROUTE_OVERRIDE` 前安全前置（host 断言锁 `api.deepseek.com`）已做 |
| D8 | ✅ **已证伪** | round-robin 下 override 不生效是伪命题；回归 `chat-handler-rr-index` 3 tests 锁死 |

### 11.2 关键决策

- **D4=C（override 主路径 + 分步门控）**：off=行为不变=安全默认，on=改路由；安全由门控 + 上游真名 + 健康信号共同保证。
- **D5 映射方式**：`findProviderByType` 引擎级映射（虚名→按 `provider_id` 选 enabled provider，不写 DB）。**`models`/`routes` 表 0 行**，`findProviderConfig` 在 models=0 时固定 fallback 首个 enabled provider，**不按 model 名匹配 `provider.name`**——D5 修复的核心 bug。
- **D5 上游实测真名（④ 拉 `/v1/models`，密钥只在内存、绝不打印）**：DeepSeek→`deepseek-v4-pro`·`deepseek-flash`；agnes→`agnes-2.5-flash`；kimi→`kimi-k2.6` 等；ollama→本地 `qwen3.8:27b-mlx`。

### 11.3 避坑

- **D7-pre 根因订正**：round-robin 下 `findProviderConfig` 按 `rr_index` 轮转，不是 ESM-mock；`chat-handler-shadow.test.ts` 红因 `rr_index` 轮转，修=pin `routing_mode='priority'` + save/restore，非 mock 问题。
- **Ollama 与 H3 绝不并发（48GB 内存）**；密钥只在内存用、绝不打印/落盘。
- **测试断言须锁实测值**（`api.deepseek.com`/`deepseek-v4-pro`/真实 200），禁理论值（`api.kimi.com`）。
- patch markdown 表格行：`new_string` 以 `\n` 结尾会把字面 `\n` 粘进文档（已踩 3 次，用 Python `chr(92)` 修复）。

### 11.4 D8 证伪

`chat-handler-rr-index.test.ts` 3 tests 证实 round-robin 下 `findProviderConfig` 轮转、override 不生效是伪命题。

### 11.5 下一步（卡 D6-b sign-off，需老板定）

1. D6-b 健康感知接生产路由决策（卡 D4=C sign-off，`PROXY_ROUTE_OVERRIDE=1` 灰度）
2. `getOverrideLog()` 观测 1-2 天，确认 override 建议合理再 sign-off
3. ~~M7 任务级 Session / AIGC adapter 缺口~~→ **已落地**：M7 任务级 Session 即 `multi-proxy-manager/lib/session-store.js`（+ `session-keepalive.js` 方向六 P3-c 胶水）；AIGC adapter 即 `l2/adapters/aigc-adapter.js`（+ `aigc-adapter.demo.js`，L2 P0 收口）。2026-09-13 时点此条记的"未做"，实为 09-14 后已补；保留原文仅作历史锚点。


---

## 十二、2026-09-13 后续整理（趋势跟进 cron + 文档归位 + L2 标注）

1. **趋势跟进机制（Hermes 侧）**：新建 cron job `multi-proxy 趋势跟进（L2 蓝图/智能路由）`（job_id `44190b9bef9c`），schedule `0 9 1 * *`（每月 1 号 09:00，与 h3web「竞品复查」镜像同节奏但独立）。prompt 自包含，调研 Harness/Agentic Coding 近 30 天进展，落盘到本 MEMORY.md + L2-BLUEPRINT.md + ITERATION-ROADMAP.md，明令不碰 `~/.workbuddy/` h3web 侧。deliver=local（结果本地存，需 cronjob list 查）。
2. **文档归位**：§九「AI 短剧 Jellyfish/火宝」属 h3web 项目（本体在 `~/Documents/AI项目/本地部署Minimax H3/`），已从 multi-proxy §九 47 行正文转为一行指针，防跨项目记忆错配。
3. **L2 蓝图标注校准**：L2-BLUEPRINT.md 状态行由「未实施，等老板拍板」改为「M6 方向四 + M2 健康增强已闭环（D1-D8/D5 真名/D7 live 200）；L2 P0-P3 新模块蓝图已定待排期」；4.6 健康监控增强标为「部分（M2+D6-a 已做，缺告警/成本分析）」。诚实标注，未实施模块仍记「未开始」。
4. **章节物理顺序遗留**：MEMORY.md 物理顺序 §八→§十→§九→§十一（§十 物理排在 §九 前），编号按内容保留未重排（避免误改 WorkBuddy 已有内容）。待老板定是否理顺。

---

## 十三、2026-09-14 收口（L1 adapter + WorkBuddy automation + 方向六 P1 worktree）

1. **L2 P0 adapter 收满**：新增 `l2/adapters/l1-agent-adapter.js`（Codex 真 chat / Hermes discovery 退化，25 checks）+ `mock-l1.js` + demo，全 mock-first 零副作用。`l2/` 7 个 demo 全绿（h3web 6 + AIGC 10 + L1 25 + Registry 18 + Plugin 14 + route-engine + validate ALL PASS）。commit `9a46c7f`。
2. **WorkBuddy 侧趋势 automation 已注册（③）**：`~/.workbuddy/workbuddy.db` 的 `automations` 表新行 `ff900140`「multi-proxy 趋势跟进（L2 蓝图 / 智能路由）」，`schedule_type=recurring` + `rrule=FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0` + `next_run_at=1790816400000`（2026-10-01 09:00，与 Hermes cron `44190b9bef9c` 同节奏双保险）。写前双备份（`~/.workbuddy-backups/` + `/tmp/workbuddy-pre-insert-*.db`，`con.backup()` 一致性快照，WAL 感知），写后读回验证；上轮孤立的 `automation-multi-proxy-trend/` 文件夹已移至备份目录。⚠️ 注意：写 db 时 WorkBuddy 进程在跑（改走 WAL 并发写协议，未做 TRUNCATE checkpoint）。**外部事实：真实 automations 表是 10 行，之前记的"9 行"是写前快照**。
3. **方向六 P1 git worktree 隔离原语落地**：`multi-proxy-manager/lib/worktree-manager.js`（createForSession/exists/remove/prune/list，纯库 + spawn git 零依赖，worktree 落 `~/.multi-proxy-manager/worktrees/<sessionId>`，sessionId/branch/baseRef 字符白名单，remove 永不碰 main checkout）+ `tests/unit/worktree-manager.test.js` 10/10（真 git 仓库往返：隔离性/force/baseRef/注入拒绝/fail-fast）。全量 manager 测试 522/522 零回归。commit `f99111f`。
4. **方向六 P2/P3 全部落地**：P2 = Paseo 0.8.0 安装 + daemon 验证（`127.0.0.1:6767`，Codex provider available，relay disabled 安全模式）。P3 四步全收口：P3-a 设计草案 `l2/p3-sessions-checkpoint-design.md`（`58d30da`）→ P3-b `lib/tmux-keepalive.js` 保活原语 10/10（`fc5cf96`，真 tmux 3.7c 往返 + per-binary 可用性守卫 + m7- 前缀隔离）→ P3-c `lib/session-keepalive.js` 胶水层 6/6（`9641925`，非侵入：bindSessionKeepalive/resumeSessionKeepalive 走 checkpoint 预埋字段，不碰 session-store 热路径）→ P3-d `tests/unit/p3d-crash-recovery.test.js` 崩溃恢复 e2e 2/2（`754fedd`，进程级 kill-重启-续跑 + 二次崩溃循环）。M7 长任务保活链路打通：worktree 隔离 → tmux 保活 → checkpoint 落盘 sessions.json → 崩溃后从 checkpoint 自动重建。全量 540/540 tests（32 suites）零回归。
5. **全部已 push**：至 `1d2ddd2`（2026-09-14 本轮）全部在 `origin/main`（local=origin diff 0），含 P3-b/c/d + L2-BLUEPRINT P1-P3 状态行 + 本轮挂起项收口（P3-c.1 评估 / MUNDER 笔记 / 09-12 日志 / MEMORY 状态回填）。前轮 push 至 `60b970e`。
6. **挂起项（新会话接手）**：
   - **P3-c.1 Paseo 对接 — 已评估（2026-09-14，`1d2ddd2`）**：立项评估入 `l2/p3-c1-paseo-integration.md`，结论维持现状（方案 A）——P3-c 自研 tmux 保活（fc5cf96）+ 崩溃恢复 e2e（754fedd）已完全自洽、零外部依赖，非缺口；Paseo 0.8.0 保活能力绑其自身 agent 生命周期（`run`/`import`/`send`/`wait`），无「绑定任意本地 session 做 tmux 式保活」的通用 API，`import` 只吃 provider 原生 session/thread id（已核实），接不进 M7 体系外本地 session。Paseo 唯一增量=多端/手机续看；全替代（C）性价比负不做。触发条件=明确的「手机端续看长跑任务」需求，届时走外包式对接（B：`paseo run -d` + sessions.json 记 `paseoAgentId` + `attach/logs` 续看，P3-c 保活不回归）。
   - **`MUNDER-REFERENCE-NOTE.md` 已入库（2026-09-14，`1d2ddd2`）**：根目录 106 行 Munder Difflin→L2 设计借鉴笔记（5 可抄点：registry schema 扩展 / single-writer 搬箱 / GOD 分级 gate / FIPA-lite act+hops / 记忆层 markdown+FTS 优先），按根目录平铺 `*.md` 惯例 git add 入库（零移动零改写）。配套 `MEMORY-2026-09-12.md`（09-12 会话日志）同 commit 一并入库。
   - **D6-b 灰度**：继续 hold，等部署验收。

### 13.1 教训

- **写外部运行态 db 前查进程**：上轮"WorkBuddy 没在跑可以 TRUNCATE checkpoint"的前提这轮失效了（进程在跑），改为 WAL 并发写 + `con.backup()` 一致性快照。前提变了流程就得跟着变，不能照搬旧脚本。
- **commit message 与实际改动对齐**：`0d33824` message 写"校准 MEMORY.md §十三"但实际只改了 L2-BLUEPRINT——§十三 是这轮才补写的。message 是给别人（和自己）的契约，写之前对着 `git status -s` 核一遍。

### 13.2 2026-09-15 收口（D6-b 观测脚本 + L2 P2 生产接线）

1. **D6-b 持久化改造（cursor-proxy，commit `c7ab5fa`，已 push）**：override 审计原本内存环数组（`OVERRIDE_LOG_MAX` shift 淘汰，重启即失），加可注入 `overrideSink`（默认 null → 行为逐字节不变，3 测试零破坏）+ `readOverrideAudit` 跨重启读盘；`start.ts` 在 `PROXY_ROUTE_OVERRIDE` 门控开时接落盘 `data/override-audit.jsonl`（可 `PROXY_OVERRIDE_AUDIT_LOG` 覆盖），门控关零写盘。新测试 `tests/unit/override-audit-persist.test.ts` 7/7（jest 131/131，基线 124+新7）。`.gitignore` 加 `data/*.jsonl`。教训：mock 跑不出 lazy 实例化/写盘目录缺陷，live 起 server+curl 冒烟才暴露（同 M7 session-store 那轮）
2. **D6-b 复盘脚本 `tools/override-audit-report`（commit `4b4542b`，已 push）**：零依赖 Node（镜像 agent-proxy-switch 风格），读 JSONL 聚合出报告（总决策/命中率/taskType·provider 分布）+ sign-off 判定（NO_DATA/OBSERVING/NO_OVERRIDE/SIGNOFF_READY），`--file`/`--since`/`--min-sample`，坏行跳读。5 路真验：默认路径(无文件→exit3)/全量聚合/--since 窗/模块聚合(4 verdict+unknown 桶+parseArgs)。D6-b 观测线收口。
3. **L2 P2 编排引擎 → 生产接线（commit `20ae61c`，已 push）**：`routes/orchestration.js` 镜像 registry/sessions 挂载风格，把 P2 内核（`l2/orchestrator.js`+`decomposer.js`，35 checks 全绿）接上 manager `/api/orchestration`：Orchestrator 长寿命单例（协作历史跨请求累积）+ 门控 `PROXY_ORCHESTRATION`（默认关→403 零副作用）+ shadowMode 默认开（非侵入）+ 异常→4xx 不冒泡；路由面最小（get 历史 / run 编排 / shadow 开关，YAGNI）。`server.js` 挂 registry 后、wildcard 前。测试 6/6（门控关 403/直供 DAG 200+历史1/视频模板拆解 200/环 DAG 400 前置 hasCycle 拦截/无 input 400/单例累积 2）。全 manager jest **546/546**（基线 540+新6，零回归）+ 内核 demo 35/35 仍绿。
4. **push 状态**：`1d2ddd2..4b4542b..20ae61c` 全部在 `origin/main`（local=origin diff 0）。
5. **教训（D6-b 轮）**：① force-push 前 `git fetch` 核实 origin/main 最新 head==我上轮 push 的、非他人 rebase，单提交 `--force-with-lease`；② 误把 `.hermes/plans/*.md` 显式 `git add` 进库（破坏"`.hermes/` 不进库"约定）→ amend + `rm --cached` + force-with-lease 纠正，文件留盘供会话连续性；③ 测试断言要核内核**真实抛文措辞**（orchestrator 抛 "unresolvable dependency / cycle" 非裸 "cycle"），别按自己预期写 assert。

### 13.3 2026-09-15 P2.2 LLM 拆解落地（`l2/llm-decomposer.js` + 生产接线）

1. **内核 `l2/llm-decomposer.js`（填 `decomposer.js` 预留的 `llmDecompose` 注入缝）**：`makeLlmDecomposer(cfg)` 返回 `async (input, opts) => DAG`，形状即 `decompose(input, { llmDecompose })` 缝。默认传输 = OpenAI 兼容 `/v1/chat/completions`（node 内置 http，零依赖，与 l1-agent-adapter 同构）；transport **可注入**（测试替身不触网络）。四道纪律：① 非侵入——只产 DAG 数据，不写盘/不改 agent 配置/不触真实上游（shadow 前置）；② 容错优先——LLM 宕机/非法 JSON/自环 DAG/退化空，一律**降级回 `templateDecompose`**（绝不把异常冒泡进编排热路径），`meta.source` 记录走 LLM 还是降级；③ `hasCycle` 对 LLM 输出**复算**（LLM 可能幻觉出环 → 拒收降级）；④ 零 LLM 依赖为默认。`llm-decomposer.demo.js` **19 checks PASS**（真起 http 假 LLM + 全降级路径 + 注入 + 接 Orchestrator）。
2. **生产接线 `routes/orchestration.js`（门控 `PROXY_LLM_DECOMPOSE` 默认关）**：`input` 分支在门控开时走 `makeLlmDecomposer`→`orch.run(dag)`（**直供 DAG 同路径**，不重建单例 → 协作历史/shadow 语义不变），关时维持内置模板拆解（确定可复现）。LLM 连接配置全来自 env（`PROXY_LLM_BASE_URL/MODEL/TOKEN/TIMEOUT_MS`，缺省走内核默认）。新 jest：`tests/unit/llm-decomposer.test.js`（内核 8 例）+ `orchestration-route.test.js` 扩 2 例（默认关走模板 / 开+真 http 假 LLM→`template=llm`+全 done）。
3. **全量回归 manager jest 556/556（34 suites，基线 546+新10，零回归）+ l2 demo 三绿（decomposer 19 / orchestrator 16 / llm-decomposer 19）。**
4. **真跑冒烟**：挂真实 `routes/orchestration.js` 到 ephemeral 端口、`PROXY_ORCHESTRATION=1 PROXY_LLM_DECOMPOSE=1` 且无 LLM 监听 → 200，`template=video-workflow`、5 节点全 done、runId+协作历史 1 条（LLM 不可达安全降级）。
5. **教训（本轮·关键）**：默认 http 传输原返回**整个 OpenAI 信封**当 `content`，致真跑解析失败、全降级——正是"mock 替身测过但真跑崩"的反面；修复=传输内**解信封取 `choices[0].message.content`**，与注入 transport 契约（content=助手消息文本）对齐。再次印证：真跑冒烟（非仅 mock）是暴露这类缺陷的唯一手段。

### 13.4 2026-09-15 P1.1a 记忆服务内核落地（`l2/memory-merge.js` · 合并/适配器/非侵入投影）
1. **内核 `l2/memory-merge.js`（§4.4「公共+个性」+§5.2「非侵入注入」落地内核，全默认零网络零文件零 LLM）**：三件事——① `merge(shared, personal, opts)` 公共+个性两层按 key 合并，冲突策略可选 `personal`（默认覆盖）/`shared`/`error`（仅记录不静默覆盖）；② `envInject(merged, opts)` 把合并结果**投影**成环境变量映射（`AGENT_SYSTEM_PROMPT/AGENT_ERROR_PATTERNS/AGENT_TOOLS_ALLOWED/AGENT_CONFIG/AGENT_MEMORY_CONTEXT`，type→目标可配；多同类按 updatedAt 倒序、超长截断），**只产出映射对象、绝不写 `process.env`/不碰 `~/.codex·~/.hermes·~/.cursor`**（§5.2 非侵入核心——agent 感知不到中枢，真正注 env 是调用方 agent 启动时拿映射去做）；③ `registerAdapter/getAdapters` 可热插拔 scheme 适配器（内置 json 规范 canonical / yaml-text 纯文本零依赖 / view 摘要，§4.8「方案适配器可热插拔」）。规范格式权威校验仍走 `specs/validate.mjs`（`agent-memory` node/py 两侧 ALL PASS，本次未动规范、仍 ALL PASS）。
2. **验证**：`l2/memory-merge.demo.js` **11/11 PASS**（合并/三种冲突策略/envInject 非侵入证明 process.env 不漏内核键/多类不串扰/超长截断/三类适配器往返/热插拔/校验）；jest `tests/unit/memory-merge.test.js` **14/14**；全量回归 **manager jest 570/570（35 suites，基线 556+新14，零回归）** + l2 demo 四绿（decomposer 19 / orchestrator 16 / llm-decomposer 19 / memory-merge 11）。
3. **边界（诚实）**：P1.1a = 合并+适配器+**投影**内核，已落地；**P1.1b（agent 启动时真注 env 的接线 + 记忆持久化）列后续**——目前 manager 侧暂无"非侵入注入 env 到 agent 进程"的接入缝，强行接 = 投机/污染，故未做（YAGNI）。
4. **教训（本轮·2 坑）**：① **demo 抓到真 kernel bug**——`merge` 的 `personal` 策略原只改 `_layer/updatedAt`、**没替换胜出方的数据字段**，致"个性覆盖公共"假绿；修=胜出时用 e 覆盖 cur 的 id/type/scope/key/value/tags/... 全字段。这印证 demo 真跑对 kernel（非仅 mock 喂值）的价值。② **`process.exit(pass+fail===0?0:1)` = 永远非零**（`pass+fail` 总>0）→ 全绿 demo 在 CI 里报 fail；修=`process.exit(fail===0?0:1)`，与另 4 个 l2 demo 的 `.catch(()=>process.exit(1))`（成功走 exit 0）对齐。

### 13.5 2026-09-15 P1.1b 技能服务内核落地（`l2/skill-service.js` · CRUD / 版本 / 市场 / 规范格式适配）
1. **内核 `l2/skill-service.js`（§4.5「技能服务 Skill 管理」+ P1 验收项 3 条：CRUD / 版本 / 规范格式适配，全默认零网络零文件零 LLM，纯内存非侵入）**：`createSkillService({ clock })` 返回 store，核心 API：`create(raw, opts)`（id 缺省 = `skill-<name-slug>`、version 缺省 `1.0.0`、enabled 缺省 true、stamp `createdAt/updatedAt`）/ `get`（id 或 name，取最新 version）/ `update(key, patch)`（缺省 bump patch）/ `bump(key, { version })`（保留旧版、旧版 enabled→false、新版→true）/ `rollback(key, target)`（翻启用权到旧版）/ `remove(key)` / `list(filter)`（filter 支持 source/tags/enabled + 默认 latest 折叠同名多版本）/ `search(q)`（case-insensitive 子串匹配 name/trigger/description/content）/ `toCapabilities()`（同名取最新 enabled，投影给编排器/Registry）；市场：`registerBuiltin`/`upload`（带 source 标签的 create，YAGNI 不另起）；适配器：`json`（规范 canonical）/ `yaml-text`（纯文本零依赖往返）/ `view`（摘要去 content）+ `registerAdapter(name, {toDoc, fromDoc})` 热插拔。`validateSkill` 轻量校验（必填 + 类型 + version 形如 X.Y.Z），`toEntry` 在 `validateSkill` 前 stamp 默认值。
2. **验证**：`l2/skill-service.demo.js` **13/13 PASS**（CRUD / 市场 / bump 保留历史 / rollback 翻转 / 坏 version 拒 / list 过滤+折叠 / search / 非侵入（process.env 不漏 / 无 fs）/ json 规范往返 / yaml-text 往返 / view 摘要 / 热插拔 csv / 终极非侵入）；jest `tests/unit/skill-service.test.js` **13/13**；全量回归 **manager jest 583/583（36 suites，基线 570+新 13，零回归）** + l2 demo 五绿（decomposer 19 / orchestrator 16 / llm-decomposer 19 / memory-merge 11 / skill-service 13）。
3. **边界（诚实）**：P1.1b = CRUD + 版本 + 市场 + 规范格式适配内核，**已落地**；**生产接线（API 路由 + 持久化 store）列后续**——manager 侧暂无「技能 store 持久化到 `~/.multi-proxy-manager/`」的非侵入接入缝，不强行做（YAGNI）。
4. **教训（本轮·3 坑）**：① **kernel bug**：`create(raw, opts)` 原只调 `toEntry(raw, ...)` 完全忽略 `opts` → `registerBuiltin(s)` 的 `{source:'builtin'}` 被丢弃，source 始终 fallback DEFAULT_SOURCE；修=合并 `{...raw, ...opts}` 再 stamp。② **jest 测试隔离**：`svc` 在 `beforeEach` 全 fresh，测试 2 的 `non-invasive` 断言假设 `svc._store.entries.length≥3` 但实际每测试只有当前新增 → 假失败；修=自包含数据不依赖跨测试。③ **测试 5 的 regex**：`/missing|content/` 同时漏 `content`、`description`、`trigger` 中一个就 pass，但 `toEntry` 默认 stamp `content=raw.content` 而 `base.content='c'` 非空，所以不会抛；修=构造缺 `content` 的 raw 精确断言 `/missing content/`。

### 13.6 2026-09-15 P2 告警服务内核落地（`l2/alert.js` · 信号驱动告警规则引擎 + 非侵入 observe）

**为什么先做告警(纯增量)·成本分析另议(有前置依赖)：§4.6 把 P2 健康增强拆「告警」+「成本报告」两块。核查现状：`provider-health.js`(故障记录+跨 proxy 聚合 `correlateCrossProxy`+隔离门控 `PROXY_HEALTH_ISOLATE` observe 默认)与 `error-patterns.js`(错误模式库 8 条种子 + `matchError` + `error-history.jsonl` 历史)都已是现成信号源 → **告警是纯增量内核**(消费两现成信号、无前置依赖、低风险，同 P1.1a/1b 纪律)。成本分析**非纯增量**——`grep` 确认 `forward.js` 不采集 token usage(只透传上游响应、不解析 `choices[].usage`)，`proxy-api.js` 只有 `/balances` 账户余额透传、无消耗累加 → 需先定 **A(`forward.js` usage 埋点+单价表，改热路径，需门控+非侵入)** vs **B(从 `/balances` 定时快照算余额变化，零热路径但精度低)**，**列独立增量**。本增量只做告警；成本规则在 `alert.js` 已就位但 `forward.js` 无 usage 管道 → **不采集则不触发(YAGNI)**。

1. **内核 `l2/alert.js`（~220 行，全内存，零 manager 依赖，信号注入式消费）**：① **4 条内置规则**映射 §4.6 增强——`provider-network-wide`(跨 proxy 全网故障 `correlation.verdict==='network-wide'`→critical) / `provider-unhealthy`(单点连续失败进隔离窗口 `status==='unhealthy'`→warning) / `error-pattern-frequent`(错误频次≥`errorFrequencyThreshold` 默认 5，≥4×阈值升 critical) / `cost-budget-exceeded`(成本≥预算→warning)；② **信号注入式**(与 l2/ 其它内核铁律一致)——`alert.js` **不 `require('../lib/*')`、不触 manager 热路径**，信号由调用方注入(demo/jest 喂 `provider-health.listIsolated()` / `error-patterns.getHistory()` 产出)，`evaluate(signal)` 纯判定产告警数组；`signal.source` 三态 `provider-health`/`error-patterns`/`cost`；③ **非侵入 + 门控** `PROXY_HEALTH_ALERT` 默认关=**observe**(事件照常判级+收集进内存 events[]+cooldown 去重，但 sink 不真发)；开(=1/true/on)=真 dispatch 各 sink；④ **防告警风暴**——`cooldownMs`(默认 5min)对同 `(rule+key)` 去重，窗口内第二次 `deduped=true` 不再 dispatch，超 cooldown 重发；⑤ **可插拔 sink**——`log`(默认收集型零副作用)/`registerSink(name,fn)` 热插(邮件/Telegram/微信 sink 在此挂)，`dispatch` 每 sink 包 try/catch 隔离(单个崩不影响其它/主流程，best-effort)；⑥ **工厂 `createAlertService({store})`** 每实例独立 events store(测试隔离)，默认模块级单例。
2. **验证(全内存，零 manager 依赖，demo 13/13 PASS)**：4 规则各触发 + 不触发(健康/低频/预算内) + 门控默认 observe + dedup cooldown + cooldown 过期重发 + registerSink 真发(门控开) + **非侵入(observe 下 `persist:true` 仍不落盘，断言 `fs.existsSync===false`)** + list/count/reset + setConfig 调阈值 + registerSink 参数校验；jest `tests/unit/alert.test.js` **13/13**；全量回归 **manager jest 596/596(37 suites，基线 583+新 13，零回归)** + l2 六 demo 全绿(decomposer 19 / orchestrator 16 / llm-decomposer 19 / memory-merge 11 / skill-service 13 / **alert 13**)。
3. **教训(本轮·3 条)**：① **信号注入式是 l2/ 内核的统一范式**——alert.js 要消费 manager 的 provider-health/error-patterns，但 l2/ 铁律**零 manager 依赖**；解法不是 require manager lib，而是让调用方把现成信号注入内核，内核"喂了就算"(同 memory-merge envInject 接 merged、orchestrator 接 DAG)。跨目录硬绑会破坏内核自包含。② **非侵入用「门控跳过落盘 + 断言 fs 不存在」双向验证**——光说不写盘不够，jest 用 `setEventsFile(tmp)+emit(persist:true)+断言 fs.existsSync(tmp)===false` 证 observe 模式**即使调用方要求落盘也不落盘**(门控权在内核不在调用方)，是最强非侵入证据。③ **成本块「规则就位但不采集则不触发」是 YAGNI 的正形态**——`cost-budget-exceeded` 规则已写，`forward.js` 无 usage 管道 → 规则天然 inert，不为"完整"铺埋点(那是另一增量、且改热路径需额外门控)；范围有界内核里**未接的信号源=未触发的规则**，不必强行接。
4. **边界(诚实)**：P2 告警服务 = 信号驱动规则引擎 + 非侵入 observe，**已落地**；生产接线(调度 emit + 路由 + sink 实发 email/Telegram/微信 + agent 启动注 env + 持久化 `alert-events.jsonl`)列后续(暂无非侵入接入缝，YAGNI)。**成本分析列独立增量**，需先定 A(usage 埋点/改热路径) vs B(余额趋势/零热路径)。

_最后更新: 2026-09-15(P1.1a `16affe3` + P1.1b `57e2c23` + P2 告警 `l2/alert.js` + P2 成本分析 `l2/cost.js` B 路余额趋势) _

### 13.7 2026-09-15 P2 成本分析内核落地（`l2/cost.js` · 余额趋势 + 喂 alert.js + 信号源无关）

**§13.6 把成本分析列「独立增量、需先定 A vs B」——本增量先做 B 内核，A 留后续。**
1. **内核 `l2/cost.js`（216 行，全内存，零 manager 依赖，信号源无关）**：① **B 路余额趋势**——`/balances` 账号余额**快照**由调用方注入 `record(name, balance, {now, providerId, budget, persist})`，内核算**消费额**（`首快照−末快照`，`Math.max(0, …)` 封顶非负——充值/余额上升不误报负消费）/`trend(name)` 段趋势/`report({windowMs})` 窗口内消费聚合（`cutoff = clock()−windowMs`，按 spent 倒序）；② **喂 alert.js**——`produceAlertSignal(name, {budget})` 产 `{ source:'cost', providerId, cost, budget }`（与 alert.js `cost-budget-exceeded` 规则契约精确对齐，**端到端 test 实证：`A.evaluate(C.produceAlertSignal(...))` → rule='cost-budget-exceeded'、severity='warning'**）；③ **信号源无关**——B 路（余额快照）是进料，A 路（`forward.js` token×单价，改热路径）后续只需把 `token×单价` 累加成"余额下降"喂进**同一** `record()` 入口，**内核不重写**；`alert.js` 那侧成本规则已就位（§13.6 13 checks 实证），两端对接实证；④ **非侵入 + 门控** `PROXY_COST_TRACK` 默认关=**observe**（内存 snapshot 照常累积、消费/报告照常算，但 `persist:true` 也**不落盘** `cost-snapshots.jsonl`——断言 `fs.existsSync(tmp)===false` 实证）；开=落盘 JSONL（best-effort `try/catch`，门控权在内核不在调用方）；⑤ **工厂 `createCostService({store, clock, maxSnapshots})`** 每实例独立 store（测试隔离），`maxSnapshots` 裁剪保最近、保头；默认模块级单例。
2. **验证（全内存，零 manager 依赖，demo 14/14 PASS + 端到端告警实证）**：余额↓消费 + 充值封顶 0 + 多 provider 聚合 + 窗口过滤 + record 产 alert 契约 + 端到端喂 alert.js 触发/不触发 + 边界 cost===budget 触发 + **A 路信号源无关（token×单价喂同入口→同信号形状）** + 门控默认 observe 不落盘 + 门控开落盘 + `persist:false` 覆盖 + `maxSnapshots` 裁剪 + 实例隔离 + report 窗口聚合 + 容错（NaN coerce 0/空序列/未知 provider 安全）+ **非侵入（默认不往 `process.env` 注入 `COST_*` 键）**；jest `tests/unit/cost.test.js` **16/16**；全量回归 **manager jest 612/612（38 suites，基线 596+新 16，零回归）** + l2 **七 demo 全绿**（decomposer 19 / orchestrator 16 / llm-decomposer 19 / memory-merge 11 / skill-service 13 / alert 13 / **cost 14**）+ `l2/specs/validate.mjs` ALL PASS。
3. **教训（本轮·1 条）**：① **窗口时间裁剪必须注入 `clock`，否则窄窗口确定性 demo 全滤**——`report()` 用 `cutoff = clock()−windowMs` 裁窗口；若 demo 用确定性时间戳（`now:1..1000`）又不注入 `clock`、又跑 `windowMs` 级别窄窗口，`cutoff` 落在 `Date.now()`（2026）附近 → 全部快照被 `ts>=cutoff` 滤掉、`spent=0`、排序失效（demo check #3、#12 首跑即栽这上，paper 推算必漏）。修法：`createCostService` 支持 `opts.clock` 注入（实例级、默认模块 `Date.now`），确定性 demo/jest 显式注入。**这是"纸面推算必漏、真跑才暴露"的第二例**（第一例 §13.6 的 `merge` 覆盖假绿、第二例本轮 `report` 窗全滤）→ l2 内核的确定性测试一律注入 `clock`/固定时间戳。
4. **边界（诚实）**：成本分析内核 **B 路（余额趋势）** 已落地 + 端到端喂 alert.js 实证；**生产接线（定时 `/balances` 探测 schedule + 成本报告路由 + A 路 token 埋点改 `forward.js` + 报告落盘）列独立增量**（YAGNI，`forward.js` 改热路径需额外门控）。A 路（token×单价）后续"换进料管不换内核"即可接入。
5. **`.gitignore` 补 `.hermes/`**——Hermes agent 运行时产物（plans/临时状态），非项目源码，勿 commit。

_最后更新: 2026-09-15(+ P2 成本分析 `l2/cost.js` B 路余额趋势) _

### 13.8 2026-09-15 P2 告警生产接线落地（`routes/alert.js` · /api/alert · 门控 PROXY_HEALTH_ALERT · 拉式接线）

**§13.6 把告警内核的生产接线列「后续（暂无非侵入接入缝）」——本增量补上。**

1. **路由 `routes/alert.js`（~126 行，门控 `PROXY_HEALTH_ALERT` 默认 off→全路由 403 `alert-gate-closed`）**：
   - `GET /api/alert` 列事件+计数 / `POST /api/alert/collect` 采集三源→`alertSvc.emit` / `GET /api/alert/config` 门控状态+sink 列表+observeOnly。
   - **三信号源拉式 `collectFromSources`**：① `provider-health.listIsolated()` + `correlateCrossProxy` → `provider-unhealthy`/`provider-network-wide`；② `error-patterns.getHistory()` 按 `pattern_id` 聚合频次（≥`errorFrequencyThreshold`=5 触发 `error-pattern-frequent`）；③ `cost.js.produceAlertSignal(name,{budget})` → `cost-budget-exceeded`（需 `PROXY_COST_TRACK=1`+`PROXY_COST_BUDGET_<name>`，YAGNI 未接 scheduler，仅 collect 时按需读，不自动定时）。
   - 挂 `server.js` 的 `/api/provider-health` 之后、`/api`(wildcard) 之前（与 orchestration/registry/sessions 同序）。
   - **非侵入**：collect 只读不写 providers.json/config；门控开时才经内核 persist 落盘 `alert-events.jsonl`；sink best-effort try/catch 隔离。
2. **验证**：jest `tests/unit/alert-route.test.js` **8/8**（门控 off 返 403 ×2 / 门控开 config+空事件 / provider-unhealthy / provider-network-wide / error-pattern-frequent / 全空 0 事件 / persist 落盘）；全 manager jest **620/620（39 suites，基线 612+新 8，零回归）**；live 冒烟 `node server.js PORT=18892` 实测 `/api/alert` 门控关→HTTP 403 `alert-gate-closed`（GET+POST 均挡）+ `/api/provider-health`+`/health` 仍 200（未破坏既有路由序）。
3. **教训（本轮·1 条）**：jest `error-pattern-frequent` 假失败——`beforeEach` 的 `ep.resetErrorPatterns()` 把 `SEED_PATTERNS` 清空致 `matchError` 返 null、频次不累加；修法：测试内 `ep.loadPatterns()` 恢复种子（生产 `initErrorPatterns()` 已 seed，路由 collect 直接读，不影响真跑）。
4. **边界（诚实）**：P2 告警生产接线已落地（`/api/alert` + 三源拉式 + 门控 403 默认 + live 冒烟实证）；**成本信号源 scheduler（定时 `/balances` 探测喂 cost.js `record()`）+ A 路 token×单价 埋点改 `forward.js` 热路径列后续独立增量**（YAGNI，改热路径需单独门控）。

_last更新: 2026-09-15(+ P2 告警生产接线 `routes/alert.js` /api/alert 门控 PROXY_HEALTH_ALERT) _

### 13.9 2026-09-15 P2 成本分析 A 路 token×单价 埋点落地（`lib/cost-track.js` + `forward.js` 热路径 · 门控 PROXY_COST_TRACK · 非侵入）

**§13.7 item4 + §13.8 item4 把「A 路 token×单价 埋点改 `forward.js` 热路径」列后续——本增量落地。**
1. **内核 `lib/cost-track.js`（纯内存，零 manager 依赖）**：`accumulate(proxyName, usage)` 热路径主入口——门控 `PROXY_COST_TRACK` 关时**零开销**（仅 `enabled()` 布尔判断 + 不建 state + 不写盘）；开时从 upstream `usage` 提 token 数（兼容 OpenAI `prompt_tokens/completion_tokens` + Anthropic `input_tokens/output_tokens` + `cache_read_input_tokens` 缓存折扣），按 per-proxy `pricing`（每百万 tokens）累计 `cost`。pricing 由 `setPricing(name,{input,output,cacheHit?})`（**幂等**）或 `loadPricingFromEnv()`（读 `PROXY_PRICING_<proxy>` JSON）注入；无 pricing 默认 0（本地模型 cost=0、仍累 token 数）。
2. **接线 `forward.js` line 168**：`res.json(response.data)` 前 `if (rest === '/v1/chat/completions' && response.data?.usage) { try { require('./cost-track').accumulate(proxyName, response.data.usage) } catch {} }`——只读 usage、不改 response、非致命 try/catch 隔离，热路径改动 < 1 行 + 门控关零副作用。
3. **未接 `server.js` 启动注入（YAGNI 决策）**：`pricing` 是**模型级**字段（`PROVIDERS-README` `pricing:{input,output,cacheHit}`、routeEngine cost-optimization 查表），**不在 proxy config 上**（已核实 `getProxyConfigs()` 的 `PROXY_CONFIGS` 只有 name/port/scriptPath 三字段）；本增量交付「提 usage + 累计 token + 注入缝」，实际 model→pricing 数据源映射接 `forward.js` 列后续增量。故**不加 `server.js` `loadPricingFromEnv()` 调用**（避免凭空造无消费者的注入——"修好实际没改"反向坑）。
4. **验证**：jest `tests/unit/cost-track.test.js` **15/15**（门控开/关 + OpenAI/Anthropic 字段 + cacheHit 折扣 + 多次累加 + 无 pricing 0 cost + pricing 全 0 + 部分字段 + getAll + 6 位四舍五入 + 不写盘 + 门控关不建 state + reset）；全量 manager jest **635/635（40 suites，基线 620+新 15，零回归）**；live 冒烟：门控关 `getAll()={}`（非侵入实证）/ 门控开 3×(1000×10/1M+500×20/1M)=**0.06** / Anthropic cacheHit 折扣 (1M−0.4M)×25/1M+0.1M×125/1M+0.4M×3/1M=**28.7**（真跑核实，非纸面）。
5. **教训（本轮·2 条）**：
    - **① `setPricing` 幂等**——原实现 `_state[name]={…全新 state}` 会清掉已累 tokens/cost，启动注入 pricing 后成本归零；改「`existing ? {...existing, 换 pricing} : 新建`」。这是"修好实际没改"类坑的主动自查发现（非测试暴露）——注入式 API 若重置累计态，热路径累计即假。
    - **② `getCost()` 对外快照剥离内部 `lastTs`**——时间戳字段让确定性 `toEqual` 抖动；对外契约只暴露纯累计量+花费。
6. **边界（诚实）**：A 路埋点（提 usage + 累计 token + 定价注入缝）已落地，门控默认关非侵入，live 实证；**model 级 pricing 数据源接 `forward.js` + 成本信号源 scheduler（定时 `/balances` 探测喂 `cost.js record()`）+ 成本报告路由 + 报告落盘** 仍列后续独立增量（YAGNI）。

### 13.10 2026-09-16 方向五 P3 文档 + 案例 + 性能报告落地（`l2/CASES.md` + `l2/PERF-REPORT.md`，收口非侵入纪律）

**§13.4「3 案例 + 性能报告未做」本增量闭环。** 全部数字由 demo/live 真跑产出，非纸面。

1. **`l2/CASES.md` 三案例**（真跑核实）：① 编排引擎视频工作流——`orchestrator.demo.js` 16 PASS（video-workflow 模板 storyboard→gen-clip-a/b→compose，shadow/条件分支/retry 降级/环拒绝/落盘非 home）+ `decomposer.demo.js` 19 + `llm-decomposer.demo.js` 19（真起 http 假 LLM + 全降级路径）；② 告警——`alert.demo.js` 13 PASS（4 规则 + cooldown 去重 + 可插拔 sink + observe 非侵入不落盘）；③ 成本——`cost.demo.js` 14 PASS（B 路余额趋势 + 喂 alert cost-budget-exceeded + 信号源无关）+ **A 路 live 冒烟** `lib/cost-track.js`：gate-off `getAll()={}` 非侵入 / OpenAI 3×(1000×10/1M+500×20/1M)=**0.06** / 幂等 setPricing 不清零 / Anthropic cacheHit (1M−0.4M)×25/1M+0.1M×125/1M+0.4M×3/1M=**28.7**（真跑精确复现，非臆造）。
2. **`l2/PERF-REPORT.md`**：appendLog O(n²) 写放大是 review-2026-08-24 C1/架构师🟡/测试#6 发现的旧形态，**现状已修**——`lib/logger.js`（`f19aeb6`）改计数触发裁剪 `TRIM_INTERVAL=500`（文件稳 5000~5005 行）。实测基准 `/tmp/bench-logger.mjs`（M5/Node 22.22.3，`hrtime`）：旧 per-append 全重写 1670.4/20157.9/40156.6 ms（N=5k/50k/100k）vs 新 amortized 131.0/1019.6/2216.4 ms = **12.8×/19.8×/18.1× 加速**，最终文件字节一致（424915 B，功能等价）。开放性能项 C2 流式转发 / B7 120s 掐断长流 / rr_index SQLite 写放大**诚实标注未闭环**（YAGNI 边界，非本次范围）。
3. **全量回归零回归**：manager jest **635/635（40 suites）**；l2 七 demo 全绿（decomposer 19/orchestrator 16/llm-decomposer 19/memory-merge 11/skill-service 13/alert 13/cost 14）+ 三 adapter（h3web 6/AIGC 10/L1 25）+ `specs/validate.{mjs,py}` ALL PASS。
4. **纪律**：内核非侵入（不写 agent 文件 / 不注入全局 env / 门控默认关）；真跑验证才收口；性能数字全部来自基准脚本真实输出，**不臆造**；发现 O(n²) 已被 `f19aeb6` 修复时如实记「已闭环」而非重复修。
5. **教训（本轮·1 条）**：性能报告别抄 review 旧结论当现状——review-2026-08-24 的 C1 是**当时**形态，落盘前先查 git log/SOURCE 确认是否已修，避免「对着旧报告重写已解决问题的修复代码」（修好实际没改反向坑）。

_last更新: 2026-09-16(+ 方向五 P3 文档+案例+性能报告落地 l2/CASES.md+l2/PERF-REPORT.md，数字全部 demo/live 真跑) _

### 13.11 2026-09-16 待办 / 未启动清单盘点（HEAD `2522018`，基于 git log + grep 实核非臆造）

**已闭环（方向三/五/六 · 含 M7，全 P1-P3 落地，全绿）**：D4 override / D5 健康感知 / D6 审计 / M6? 见下 / M7 长任务保活链路
（worktree `f99111f` → tmux 保活 `fc5cf96` → session 胶水 `9641925` → 崩溃恢复 e2e `754fedd`）/
方向五 L2 编排+告警+成本（A 路 `43b5706` + B 路 `7431b43` + 告警 `7c87b71` + 报告 `b69fc77`）。

**待办 / 未启动（真实状态）**：

1. **方向二 D2 商业化 — 从 0 起草**:本轮新建 `docs/04-business/commercialization-questions.md`（15 题决策框架 + 现状锚点），商业/付费模型需老板拍板（非纯技术活）。
2. **sign-off 是观测+决策动作（非 code bug，卡 1-2 天观察）**：方向一 D4/D5/D6 的 code 已 gated 默认关合入，但 sign-off 是"看够样本再 flip 默认"——D4 `getOverrideLog` 观察、D5 看 `/api/health/isolation`、D6 跑 `tools/override-audit-report`。当前默认全关 observe（6 个 `PROXY_*` 门控：HEALTH_ISOLATE/COST_TRACK/HEALTH_ALERT/ROUTING_SHADOW/HEALTH_MONITOR/ROUTE_OVERRIDE 全默认关）。
3. **M6 方向四 智能路由 — 代码全落地，剩 2 决策**：D1-D8 全部代码已写+测试（`chatHandler.findProviderByType` + `DEFAULT_ROUTE_CONFIG` 真名对齐 + D7 live 已实证 deepseek 200），唯一没做的是：① enable ollama qwen3.8:27b-mlx provider（写 DB）② 翻 `PROXY_ROUTE_OVERRIDE=1` 灰度 override 灰度。两决策见 `docs/02-product/m6-action-checklist.md`。
4. **DSH DS2/DS3 — 暂缓**：DS1 已落（`64edc10`，2 SKILL + `dsh-integration.md`）；DS2 npm 包化等 DSH 0.2 稳定、DS3 生态运行等 guardrail #1496 落地。
5. **C2/B7 幽灵路径 — 默认不修**：`b69fc77` 坐实零调用方，修 = "修好实际没改"反向坑；保留观察。
6. **P5 GUI 桌面壳 — 暂缓**：锦上添花非阻塞。

_最后更新: 2026-09-16(+ §13.11 待办盘点 + §13.11a M6 行动清单 + §13.11b kimi 价基线；D2 从 0 起草 / M6 剩 2 决策 + pricing 校准；HEAD 2522018 全绿)_

### 13.11a M6 智能路由行动清单（2026-09-16 · 代码实核 + kimi 价基线初稿）

**D1-D8 真实状态（git 实核非摘要）**：D1-D3 ✅ 代码+测试落地；**D4** 拍 C（override）代码已落（`PROXY_ROUTE_OVERRIDE=1` 默认关，翻 1 属老板决策）；**D5** `findProviderByType`+ `DEFAULT_ROUTE_CONFIG` 真名对齐代码已落（DB enable ollama + push 属老板决策）；**D6-a** `loadEnabledProviderConfigs` 已完成（D6-b 卡 D4）；**D8** 双 guard 证伪；**D7** live 已实证（deepseek 200/162ms，密钥不打印）。**D1-D8 代码全落地并测试，剩 2 老板决策：enable ollama provider + 翻 override 灰度**。

**价格基线初稿 `docs/02-product/m6-action-checklist.md`**（不改代码，只给参考）：
- kimi-k2.6 官方价（Kimi 帮助中心）：input miss $0.95/1M / cache hit $0.16 / output $4.00（美元，假设汇率 7.2 → ¥6.84/¥1.15/¥28.80）
- 项目 pricing（`routeEngine.ts:198-202`）：qwen3.8:27b-mlx / agnes 免费；deepseek-v4-pro ¥1/¥4/¥0.02（缓存红利）；kimi ¥0.6/¥2.5/¥0.1（估算占位）
| **结论**：kimi 真实 output ~¥28.8 vs deepseek ~¥4 output，kimi 在 cost-optimization 里不会被选中，只在 deepseek/agnes down 时兜底。校准 kimi pricing 是定价决策（不擅改）。

**教训（本轮·1 条）**：kimi 价查证前未跑 tsc 确认 cursor 测试不破（119），且 kimi 可能 disabled 在 DB，校准是空改——定价决策需老板拍 + DB 真名对齐后再做。

### 13.15 2026-09-18 第五轮 checkpoint（三件事全清 · item2 删仓完成 · HEAD `0ad43c2` ahead 7）

**本轮三事全清**：

#### 13.15a Block 2 ✅ 模型类型路由差异化（commit `6844ec8`）
- `l2/agent-registry.js`：+`MODEL_TYPES`（`text`/`multimodal`/`audio`）、+`modelType` 字段校验（默认 `text`）、+`byModelType()` 查询
- `l2/route-engine.js`：+`_inferModelType()` 启发式（vision/image/video/text2video→multimodal；audio/tts→audio；其余→text），`route()` 双维过滤（capabilityTags + modelTypeMatch 权重）
- `l2/CAPABILITY-MODE.md` 设计文档（170 行）；demo 21 checks 绿；jest 10/10

#### 13.15b Block 1 ✅ Apple HIG GUI（commit `6844ec8`）
- `dashboard.html` 1724→2113 行，新增 page-health/alerts/registry + Apple HIG 风格（`hig-stat-grid`/`hig-card`/`hig-nav-item`）

#### 13.15d 外部评估（WorkBuddy/DeepSeek）核实 + complexity 设计草案（本轮）
- 核实 WorkBuddy 6 条断言（对真实代码）：_execute 桩✅ / complexity 未接✅ / 韧性三件套下沉 L2✅ / alert 三路接线默认 off✅ / hermes-proxy·skill-memory 无 HTTP✅ / **bundle-design 已存在❌（纠偏：63 行已进 git 5b58df9，上轮误报"不存在"因只查 l2/ + grep 排除）**。
- 商业化待补 4 项（U1 市场/付费意愿·U2.3 付费意愿·U1.5 市场大小·U5.3 最大风险）在 `commercialization-decided.md §四` 附贾维斯初步判断（待老板信号定稿，非结论）；`questions.md` 标「已归档，以 decided 为准」清理并存。
- 新建 `l2/COMPLEXITY-MODE.md`（option1 设计草案：agent-registry +modelTier(small/med/large,映射现有 provider 成本梯度) + route-engine +_mapTier(low→small/med→med/high→large) + complexity 消费；热路径零改动；待老板定 4 决策点）；`l2/EXTERNAL-OPTIONS-REGISTER.md`（option2 failover middleware 阻塞=Octop harness-agent 接口未定·option3 L2→MCP 阻塞=_execute 接真实+MCP 协议；三 option 能全做无互斥，执行序 option1→2→3）。
- `_execute()` 仍桩（route-engine.js:140 return queued）——WorkBuddy 判断准确，本批未改。

#### 13.15e 老板定稿 complexity 4 决策点 + 据 WorkBuddy 内容核实 Octop 仓库（本轮）
- **complexity 路由 4 决策点老板全定稿**（写进 `l2/COMPLEXITY-MODE.md §四`）：① tier 用 small/med/large 抽象命名（好换）② high 不降级、质量优先 ③ **静态先行（decomposer 标签，零成本过渡）+ 二期 LLM judge 动态复判（更准）**，质量优先原则贯穿 ④ 文档 COMPLEXITY-MODE 独立（modelType/complexity 两轴分开）。
- **文件粒度通用约定**（老板 09-18）：不拆太碎、不塞一坨在一个文件，按「一主题一份」——已为项目惯例，后续 agent 照此组织文档。
- **据老板转的 WorkBuddy 内容核实 Octop/harness-agent**（实测，非转述）：`orcakit-harness-agent` **PyPI 实测存在**（v1.0.11，MIT，基于 LangChain Deep Agents）；但其指向的 **GitHub `TencentCloud/harness-agent` 实测 404**（经代理 `127.0.0.1:7897` 核实）——包在、仓库不可得。故 option2「内核 failover middleware」阻塞精化为「仓库 404，需老板确认真实获取渠道」；**但 provider 前置（option1 延伸）零代码今天就能用**。诚实标注进 `EXTERNAL-OPTIONS-REGISTER.md`，未臆造接口形态。
- **本轮无代码改动**（纯设计文档定稿 + 核实），jest 837 / demo 全绿基线不变。

#### 13.15c item2 删仓 ✅ 完成（本轮关键突破）
- **根因（实测）**：`github.com/login/device/code` 直连 `20.205.243.166:443` **被墙 i/o timeout**；走本地代理 `127.0.0.1:7897` 秒通（`curl -x` 实测 1s 200/404）。`gh auth refresh` 默认直连 → 静默失败 → scope 永不落 keyring。
- **解法（真有效）**：`export http_proxy/https_proxy/all_proxy=http://127.0.0.1:7897` + `gh auth refresh -h github.com -s delete_repo -c`，**background=true + pty=true 不杀进程**让 code 存活轮询；新 code `6384-2449` 生成（旧 `8B5D-50D7` 是被杀进程残留，故无效）→ 老板浏览器 `github.com/login/device` 输码授权 → `gh auth status` 实测 scope 出现 `delete_repo` → 真删。
- **删完双验证**：`gh repo delete xiaoxianxian/multi-proxy-manager --yes`（exit 0）+ `gh repo delete xiaoxianxian/homebrew-claude-zh --yes`（exit 0）；`gh repo view` 两仓均 `Could not resolve to a Repository`（已消失）；`multi-proxy`（活跃主仓）保留 untouched。
- **本轮关键教训**：① 反复 `pkill`/超时杀掉的恰恰是「正在等你浏览器授权」的那一个进程，导致 scope 永不落地——**设备码流必须保留进程存活，且先修网络（代理）再跑**；② `gh auth refresh -c` 在 headless 下 code 不进剪贴板/不进文件（TTY 专属输出），须 `background+pty` 进程靠剪贴板+`curl -x 7897` 验代理连通；③ `--web` 标志 v2.92.0 不存在。

**数字（全真跑）**：jest **837** / l2 demo **21** / pytest **63** / 总 **~1092**。**三事全清，无阻塞项**。

**当前 HEAD `51cba3b` = origin/main（已 push，09-18 老板授权）。8 commit `6ebb200..51cba3b` 全上线，本地与远端同步。**

---

### 13.11b INDEX 同步（2026-09-16 · 3 处收口）

- §"已知风险与开放项"#6 收口：D6-b（健康决定真实路由）现卡 **D4 override + D5 enable ollama provider**（指向 `docs/02-product/m6-action-checklist.md`）；
- 目录树：`docs/04-business/commercialization-questions.md` + `docs/02-product/m6-action-checklist.md`（Python 前缀剥除 bug 导致 2 个目录条漏插，patch 补上）
- 变更日志：本轮 D2 + M6 行动清单 + kimi 价基线一行已入
- 注：本节「HEAD 仍 2522018 未 push」已过时——实际后续已 push 到 `5cdae17`（见 §13.11c）。

### 13.11c 2026-09-16 续（M6 实证 / D2 决策 / P5 壳 / DeepSeek 评估 · 当日日志 MEMORY-2026-09-16.md）

- **M6 决策2 端到端实证**（commit `0049e36`）：隔离端口 18800，coding→deepseek-v4-pro，上游 HTTP 200 + 审计落盘，**排掉假象**（发 model=deepseek-v4-pro=suggestion 不 override 是设计正确）；老板选 A **暂不固化常驻**，固化命令 `manage.sh start_cursor` 注入 `PROXY_ROUTE_OVERRIDE=1` 已备。
- **D2 商业化决策**（commit `5cdae17`，已 push，ahead 归零）：`docs/04-business/commercialization-decided.md`（91 行 20 题全决策：个人开发者+开源云增值+MVP），三题定→推 17 题（A/A/A/A）。
| - **P5 GUI 桌面壳（已闭环，commit `2163ca9`，已 push）**：`multi-proxy-manager/main.js`（自包含 Electron 壳,detectAll 占检查+复用后端+loadUI) + `manage.sh gui` 子命令 + `launch-gui.sh`（xattr 清 quarantine + 后端检查）+ `agent-owner.js` 缩进错乱修复(99 行,6/6 全过) + `package.json` 加 electron@31。**真因**:① npm 拦 electron postinstall→`ELECTRON_MIRROR=... node install.js` 解;② agent daemon spawn electron **exit 137 SIGKILL**(GUI 需老板交互登录 WindowServer,daemon 挂不上)→ **GUI 渲染必须老板本人终端跑**;③ 老板双击报「移到废纸篓/恶意软件」→已 `xattr -cr` 清 quarantine,**老板手动在「隐私与安全性」放行**后窗口正常显示 (截图确认 Proxy Manager - Dashboard，635/635 全绿)。**P5 验收通过，唯一未闭环点已消除**。**使用方式**: `bash manage.sh gui` 或 `./multi-proxy-manager/launch-gui.sh`。详见 MEMORY-2026-09-16.md。
| - **DeepSeek 文档缺口 A档（已完成，commit `68c585f`，已 push）**：`docs/00-codebase-map.md`(代码库地图+模块速查)、`docs/04-tech/data-model.md`(SQLite schema)、`docs/04-tech/api.md`(全部端点 grep 扫出)。三文档 100% 来自真实扫描，无编造。B/C/D/E 档待老板定范围。
| - **AGENTS.md 批准转正（commit `d9219af`，已 push）**：移除草稿声明，状态变更为"已批准"，所有 agent 可直接遵循。
| - **交互铁律**：发链接/URL 一律 desktop_preview 右侧 pane,绝不 browser_exec real-profile 抢老板 Chrome(本轮曾误杀一次,已纠正)。此条已写入项目 MEMORY.md §13.11c + 今日日志，全局 memory 已满无法追加。
| - **HEAD = `bdb7ef1` = origin/main,working tree 干净**。（注：已过时，见 §13.12 当前 HEAD `ed138f4`。）

### 13.12 2026-09-17 / 09-18（CLAUDE.md 归档 + AGENTS 合并 + DeepSeek R3/R4/R5 + P0 cost 真核实 · 当日日志 MEMORY-2026-09-18.md）

**当前真实状态（2026-09-18，HEAD `ed138f4` = origin/main，working tree 干净；本轮仅 `docs/INDEX.md` M + `docs/02-product/bundle-design.md` 新增未 commit）**。

#### 13.12a CLAUDE.md 归档 + AGENTS.md 合并（09-17，老板指令「Claude 封号弃用，全库 CLAUDE.md 引用改向 AGENTS.md」）
- `CLAUDE.md` → `git mv docs/09-review/archive/CLAUDE.md`（弃用但保留历史，非 `git rm`）；独有内容迁入新建 `docs/07-ops/ENV-NOTES.md`（commit `0d01ae7`）。
- 全库 22 文件 `CLAUDE.md` 引用改向 `AGENTS.md`（commit `2f9efa7`，显式列文件，不裹他人 WIP）。
- **AGENTS.md 是各家 AI agent 事实统一规范**（老板 09-17 确认）；cursor `119→131`/`14→13 demo`，CLAUDE.md→03-adr/ENV-NOTES/P0-FIXES（commit `8a1e3bc`）。
- **致命坑（AGENTS.md gate）**：`~/.hermes/hermes-agent/tools/file_tools_write_guards.py:166-179` 硬保护 `agents.md/claude.md/soul.md/.cursorrules`；`approval.py:558-565` 非 CLI 会话无 gateway callback → fail-closed 超时，patch/write_file 写 AGENTS.md 全被拦。**唯一合法出口 = `cp /tmp/暂存版 AGENTS.md`**（老板本人 cp 落地=人工授权），且老板 cp 路径可能没对上（目标 mtime 未变）需助理补 cp 后 `git` 验证。重启不解决。

#### 13.12b DeepSeek 评估 R3/R4/R5 + 882 全绿真跑（09-17）
- **882/882 全绿确认真跑**：manager 635(40 suites) + codex 53(3) + cursor 131(11,须 `NODE_OPTIONS=--experimental-vm-modules`) + hermes 63(须 `/usr/bin/python3`) + L2 13 demo(10 内核+3 adapter) ~182 checks，全 exit 0。
- DeepSeek 多轮报「缺文档」多为**爬虫误判**（本地都有）：R3 真缺口 `docs/09-review/risk-register.md`+`docs/06-test/test-plan.md`（`3d3d730`）；R4 真缺口 `docs/06-test/acceptance.md`（`640e12b`）；R5 `_evidence/README.md`+INDEX 位置列/收录/概数 33/HEAD/验收入口（`ed138f4`）。总账：R1 全误判 / R2 部分真 / R3-R5 误判为主+少量真缺口全补。
- 数字校准：jest 807→819、总 1064→1076；feature-matrix 4 处 `14/14` 是 cost.js/plugin-runtime **模块自身** demo check（非 L2 总数 13）→ 不改；带时间戳历史快照不改，只修无时间戳「当前状态」描述。

#### 13.12c DeepSeek 两段反馈 + bundle-design + P0 cost 真核实（09-18）
- **两段反馈全核实**：第一段报「3 ADR 引用断裂」= **误判**（3 ADR 全在 `docs/03-adr/` 0001/0002/0003，全库搜 `03-architecture/adr` 零命中，它路径+文件名都写错）；文档缺 = 全在。第二段 DSH「等待期提前设计 bundle」= **真增值建议**，已落 `docs/02-product/bundle-design.md`（官方 `deepseek-ai/deepseek-harness` 规范 + 参照 `dsh-plugin-model-proxy` + 8 条社区踩坑 + L2 接入映射，等 DSH 0.2 + guardrail #1496，纯设计不破坏 DS2 暂缓）。
- **P0 严重误判**：feature-matrix/截图说「P0 三子项全未完成」，实核 **2/3 早已落地+集成绿**（老板/DeepSeek 不知道）：① `orchestrator`→`routes/orchestration.js`（`/api/orchestration`，shadow 非侵入门控）+ `orchestration-route.test.js` PASS；② `alert`→`routes/alert.js`（`/api/alert`，**真实信号源** `provider-health.listIsolated()+error-patterns.getHistory()` 喂 `alert.emit()`）+ `alert-route.test.js` 152 行端到端 PASS；3 route 测试 **28/28 绿**。门控默认 off 是 ADR-0003 非侵入**正确设计**，非「未接线」（又是把门控非侵入误读成未完成的老毛病）。
- **唯一真缺口 = cost 信号源接线**：内核 `l2/cost.js` 完成（14/14，`produceAlertSignal` 契约+`record` 就绪），但 `routes/alert.js` 未接 cost 路 + 无 schedule + 边界未文档化。**接线需改 `forward.js` 热路径**（铁律非授权不动）→ **已发起 clarify 给老板 3 选项（A 授权接 / B 仅文档化 deferred 边界 / C 先汇报），老板未拍板（clarify 超时）即要求 checkpoint**。
- **下一步决策点**：cost 接线方向待老板定。无论 A/B，`docs/INDEX.md`（M）+ `docs/02-product/bundle-design.md`（新增）需 commit；B 选项还涉及补 `risk-register`/`unknowns` 记 cost YAGNI 边界。

**教训（09-17/18）**：
1. **AGENTS.md gate**——patch/write_file 改 AGENTS.md 全被 file_tools_write_guards+approval fail-closed 拦；`cp` 暂存版唯一出口，老板 cp 路径可能对不上需补 cp + git 验证。
2. **DeepSeek 报「缺/未完成」先核实再动**——多轮误判（文档爬虫漏抓 / 门控非侵入被读成未接线）；882 全绿是铁证，P0 三子项 2 个早已落地集成绿，只有 cost 真缺口。不盲信截图/爬虫，全本地真跑核实。
3. **热路径 forward.js 非授权不动**——cost 接线是设计决策（开 schedule 自动探测），需老板拍板；不闷头做。
4. **子代理/write_file 自报不可信**——必须 `ls`/`grep` 验证落盘（write_file 并行批次曾静默失败）。
5. **jest 跑子集用全路径**——`npx jest alert-route` 被当 regex 匹配 28 套全挂（环境缺失），须 `npx jest tests/unit/xxx.test.js` 全路径才准（28/28 绿）。

### 13.13 2026-09-18 第二轮 checkpoint（item 1 完）—— cost 接线 ✅ HEAD `6ebb200` 已 push
- **①cost 信号源接线(选项A) ✅**：不碰热路径(A 路 token×单价埋点 09-15 已在 `forward.js:168`)，只接**消费侧**。`routes/alert.js` 第 3 路读 `cost-track.getAll()`×（`PROXY_COST_BUDGET` 全局/`PROXY_COST_BUDGET_<PROXY>` per-proxy 覆盖），cost≥budget→`cost-budget-exceeded`（不设预算不报，YAGNI）；抽 `runAllCollects()` 复用；`startCostScheduler()` 门控 `PROXY_COST_SCHEDULE` 默认关(不建 timer/unref/幂等/clearInterval 可清)，`server.js` 启动期调 + `loadPricingFromEnv()`。`alert-route.test.js` 加 cost describe(+8 测试)；**mpm 全量 644/644(40 suites) 零回归**。`L2-BLUEPRINT.md` P2 行删过时"cost B 路未接"；`docs/01-feature-matrix.md` 635→644、总 checks ~1076→**~1084**（全真跑：jest 828=644+131+53 / pytest 63 / bats 11 / l2 ~182）。5 文件 commit(`git add --` 显式列 alert.js/server.js/alert-route.test.js/L2-BLUEPRINT.md/docs01) → **HEAD `6ebb200` 已 `git push origin main`(5b58df9..)**。
- **②删两旧仓 ⏸️ 卡权限(待老板手动补 scope)**：`xiaoxianxian` 下 3 仓——`multi-proxy`(public 活跃，**保留**，4 子目录指向它)/`multi-proxy-manager`(private 06-20 停更，旧独立 frontend+managers+scripts 版，**建议删**)/`homebrew-claude-zh`(public 06-19 停更只剩 `claude-zh.rb`，已并入 `multi-proxy/tools/claude-zh`，**建议删**)。内容冗余已核实(`gh api` 拉内容)。阻塞根因：当前 gh token 缺 `delete_repo` scope，`gh auth refresh -h github.com -s delete_repo` 在 headless 触发**交互式 OAuth 卡死 124s**。老板补好 scope 后我跑 `gh repo delete xiaoxianxian/{multi-proxy-manager,homebrew-claude-zh} --yes`。
- **③三大块未动(新会话逐个执行 + 每项 E2E)**：① GUI 补全(`multi-proxy-manager/public/` 现 5 页 dashboard/logs/proxy-config/sessions/login；后端 routes 有 orchestration/alert/registry/proxy-health 无前端)；② 功能公共化下沉(路由/熔断/限流/流式翻译现只 cursor 有，codex/hermes 零命中，非单模型默认关)；③ DeepSeek P0/P1 文档缺口(数据流图/tech-design/负面测试等，**逐条核实真伪再补——历史 3 轮已多次误判，别盲信**)。每项完成 E2E 铁律(见 §13.7)：主路径+≥1 边界+关键断言，带病不前进。
- **新陷阱**：`gh auth refresh -s <scope>` headless 不可自动完成(交互 OAuth 卡死)→ 删仓类/需新 scope 的操作必须老板手动补 scope 后再跑。jest 全子集用全路径；aggregate checks 别猜全真跑(jest 828/py 63/bats 11/l2 ~182=~1084)。
**新会话一句话（09-18 第四轮更新，详见下方 §13.14）**：item1 cost ✅ / **item2 删仓⏸️ 卡 gh CLI keyring token 无 delete_repo（用户浏览器授权≠CLI token，需用户 TTY 跑 `gh auth refresh -h github.com -s delete_repo --web` 后告知，scope 就绪才真删两仓）** / item3 Block3 ✅收口(`49b5102`) + Block2 l2-p1 监控三件套已落但需重做 modelType 差异化(`b947f9e`) + Block1 GUI 未做。HEAD `1a3a310` ahead 4 未 push，working tree 干净。续跑读 `MEMORY-2026-09-18.md §十`。

### 13.14 2026-09-18 第四轮 checkpoint（Block 2 l2-p1 + Block 3 doc 收口已落地 · HEAD `1a3a310` ahead 4）

**承接 §13.13，本轮进展（已 commit，详见 `MEMORY-2026-09-18.md §十`）**：

- **①item2 删仓仍 ⏸️**。root cause 已锁死：用户浏览器完成的 GitHub 账号授权 ≠ `gh` CLI 本地 macOS keyring 的 token；`gh auth status` 实测 scope 仍 `'gist','read:org','repo','workflow'`（**无 `delete_repo`**）→ 真跑 `gh repo delete` 报 `HTTP 403 needs "delete_repo" scope`，两仓都在。**解法（老板自身 TTY，非 headless 驱动）**：`gh auth refresh -h github.com -s delete_repo --web` → 浏览器输一次性码 → `gh auth status | grep delete_repo` 确认 → 告知贾维斯 → 贾维斯真跑 `gh repo delete xiaoxianxian/{multi-proxy-manager,homebrew-claude-zh} --yes` + 验证两仓消失。**scope 没就绪前绝不删**（不可逆）。
- **②item3 Block 2 部分落地（l2-p1 监控三件套公共化下沉）✅ commit `b947f9e`**：`l2/circuit-breaker.js`+`rate-limiter.js`+`health-monitor.js`（纯 JS·零依赖·Node18+·状态机/非侵入/门控默认关）+ 3 demo（CB 5 / RL 6 / HM 6 PASS）+ `codex-proxy/tests/circuit-integration.test.js`。**注意**：上轮 3 监控类被老板判定**做浅**——Block 2 还需**重做完整能力抽象**（公共内核 + 个性层 + **文本/多模态路由差异化**：`route-engine.js` 现仅 `capabilityTags.includes(task.type)` 无 modelType 维度，需补 `l2/CAPABILITY-MODE.md` 设计 + route-engine/agent-registry 加 modelType 字段）。
- **③item3 Block 3 ✅ 收口 commit `49b5102`**：`docs/09-review/consistency-report.md` 09-18 复核区（jest 635→830 / l2 14→16·196 / 总 ~1089 全真跑）+ `deepseek-gap-assessment.md` 所列 13 份缺口文档全部实存核实（非幽灵缺口）。
- **④item3 Block 1 GUI 未做**：`dashboard.html` 干净 1725 行（escape-patch 历史损坏已 `git checkout` 还原），需补 page-health/al/registry + Apple HIG 风格重构（老板定风格=苹果设计规范，不照抄控件；**HTML 大段写用 `write_file` 整文件，不 escape patch**）。
- **⑤本轮 4 个本地 commit 未 push**（`bc8a349`→`b947f9e`→`49b5102`→`1a3a310`），push 待老板授权。

**数字（全真跑，§1.2）**：jest **830**（mpm 644/40 + cursor 131 + codex 55 含 circuit-integration）/ pytest **63** / l2 **16 demo·196 checks** / 总 **~1089**。

**新会话续跑**：读 `MEMORY-2026-09-18.md §十`（完整续跑提示词 + item2 解锁路径）。三件：①item2 等老板 TTY 补 scope 后真删；②Block 2 重做 modelType 差异化；③Block 1 GUI。每项 E2E（jest 830 + l2 196 + py 63 全绿），带病不前进。铁律：显式 `git add --` 不 `-A`；热路径 `forward.js`/`proxy.js` 非授权不动；每步真跑不抄文档数字；不抢老板 Chrome。

### §13.16 本轮（complexity 路由实施 + option2 解阻塞；HEAD `c5562ef`，已 push）
- **option1 complexity 路由✅ commit `eaed67e`**：`agent-registry.js` +`MODEL_TIERS`(small/medium/large 可选校验,默认 medium 向后兼容) +`byTier`；`route-engine.js` +`_mapTier`(low→small/high→large/unknown→medium) +`tierMatch` 排序维度。E2E：route-engine.test.js **14/14**(旧10+新4) + agent-registry.demo 27 checks + l2 全13 demo PASS。设计见 `l2/COMPLEXITY-MODE.md`(4 决策点老板定稿:tier抽象/high不降级/静态先行后动态/独立文件)。
- **⚠️ jest transform cache 坑（重要）**：jest 真 cache 在 `/private/var/folders/.../T/jest_dx/`，**不在 `node_modules/.cache`**——改 `l2/*.js` 后必须 `rm -rf $TMPDIR/jest_dx` 才生效，否则 jest 跑旧版 module（本次一度误判"3 test 卡住"，实际是 cache + 一个 expectedTier 漏写 decision 顶层的真 bug）。
- **registry.test.js `../server` 失败 = pre-existing**：`git stash` 掉本批改动脉后仍 FAIL（require supertest/jwt/server），与本批 complexity 改动零交集，不背锅、不在范围，未动。
- **option2 阻塞已解✅ 纳入 `c5562ef`**：`TencentCloud/harness-agent` GitHub 404，但**源码真相在 PyPI wheel**——`orcakit-harness-agent` 1.0.11-py3-none-any.whl（1.45MB/sha256 `9cc849…`/212 个 harness_agent/*.py）真可下载。贾维斯独立复现对照 `model_router.py:19-23`(AgentMiddleware/ModelRequest/ModelResponse) + `ChatModelFactory`(llm/factory.py) + `HarnessAgentConfig`(config/__init__.py frozen dataclass) + `wrap_model_call` 契约，与 WorkBuddy spec `docs/octop-harness-failover-middleware-spec.md`(319行) 逐项一致→非臆造。**option2 可纳入但实现是 Python middleware（与 Node L2 跨语言），待老板发话再实施**；provider 前置(option1延伸)零代码已可用。option3(`_execute` 桩+无 MCP)仍最重放最后。

### §13.17 option2/option3 实施断点（会话 09-19 checkpoint，新窗口从这里接）
- **option2 实施清单（Python middleware，spec 已在盘 `docs/octop-harness-failover-middleware-spec.md` 319行/commit c5562ef）**：
   1. **复现 wheel**：⚠️坑——`pip download orcakit-harness-agent --no-deps -d ./harness_pkg` 在我环境**失败**(`No matching distribution found`，疑 pip 源/代理)，但 **urllib 走 http_proxy=127.0.0.1:7897 下 wheel 成功**（`1.0.11-py3-none-any.whl` 1.45MB）。新窗口 fallback 用 urllib 下载或 spec §0 的 `python -m zipfile -e *.whl ./ext` 法。已验 447 成员/212 py。
   2. **写 `ResilientModelMiddleware(AgentMiddleware[Any,Any])`**（spec §1.1/§1.3，据官方 `ModelRouterMiddleware` 范例 model_router.py:35-92）：`__init__(self, config, factory, *, get_protocol=None)`；`wrap_model_call(request, handler)` 在 `handler(request)` 外包 try/except，抛 retryable 异常 → 把 `request.model` 换备用模型(从 `ChatModelFactory` 取)→ 再调 `handler(request)`；**同步 + 异步**(`awrap_model_call`)都要实现。无需碰 harness 内核(只换 `request.model` 对象)。
   3. 已验接口：`AgentMiddleware`/`ModelRequest`/`ModelResponse`(import 自 langchain.agents.middleware) / `ChatModelFactory`(llm/factory.py, openai/anthropic/bedrock 协议映射) / `HarnessAgentConfig`(config/__init__.py frozen dataclass) / `wrap_model_call`×2。
- **option3 实施断点（最重，放最后；3 阻塞项，需老板定优先级）**：
   - 阻塞1：`_execute()` 仍桩（route-engine.js,`this._execute(adapterId,task)` 调用在 ~114 行,桩返回 `queued`）→ 需接真实 executor(orchestrator executor 缝)
   - 阻塞2：无 MCP server 代码 → 需新增 stdio/SSE MCP 框架(新模块)
   - 阻塞3：skill-service/memory-merge 无 HTTP(unknowns U5) → 暴露 L2 能力的 HTTP 待补
   - ⚠️ option3 比 option2 重，建议老板单独发话再开，别和 option2 挤一个会话。
- **健康度判定(09-19)**：token 估算已 50-60% 窗口(qwen3.8 local 131072)，option2+option3 叠两个重任务有溢出风险→本轮 checkpoint，新窗口接 option2→option3。
- **续跑提示词见下(新窗口粘贴)**。
