# MEMORY.md — multi-proxy 项目记忆

> 供 WorkBuddy / Claude / Codex / Hermes 等 agent 读取，作为本项目单一事实来源。
> 仅内部使用，分发包剔除。最后更新：2026-09-12（新增 §十 Agentic Coding 工具趋势分析）

## 一、项目定位
- `codex-multi-model-proxy` 的合并升级版：挂多个 agent 代理的统一壳子，目标根治 WorkBuddy 等 agent 因 API 限速导致的任务中断。
- 原名 `proxy-rebuild`，现改名 `multi-proxy` 并迁入 `~/Documents/AI项目/multi-proxy`（有 .git，由旧 `~/proxy-rebuild` 重命名合并而来）。当前 bug 较多，正用 Claude 与 Hermes 修复。

## 二、已固化关键配置
- 服务端口（以 docker-compose.yml / CLAUDE.md 为准）：
  - `multi-proxy-manager`：18792（Web 管理界面，前端 dashboard + `proxy-config.html` 模型切换页，Node.js+Express）
  - `codex-proxy`：18790（Codex CLI 代理，Node.js+Express）
  - `hermes-proxy`：18793（Hermes Agent 代理，Python+Flask）
  - `cursor-proxy`：18794（Cursor IDE 代理，Node.js+TS+SQLite）
  - 注：前身 `codex-multi-model-proxy-deploy`（~/Documents/Codex/）的管理面板运行在 18791 端口，合并后已由 multi-proxy-manager 的 18792 端口 `proxy-config.html` 取代，18791 不再使用。
- 多 agent 代理统一入口；含多份 Dockerfile（codex/cursor/hermes/manager）。
- 已集成 zg 作为检索层（见下「近期决策」）。

## 三、致命坑与避坑
- 当前版本 bug 多，改动前先读 `ITERATION-ROADMAP.md` / `CLAUDE.md` 对齐现状，别凭空改。
- 网络：上游经 Clash Verge（7897/7895），不启用 TUN；订阅过期会中断，需持续监控。

## 四、运维要点
- 本地调试走 WorkBuddy / Claude / Hermes；提交规范见用户「项目版本管理习惯」（打 tag、.gitignore 权重与产物）。
- 关键文档：`README.md`、`CLAUDE.md`（Claude 专用上下文）、`ITERATION-ROADMAP.md`、`FUNCTIONS.md`、`HANDOVER-*.md`。

## 五、目录导航
- `ITERATION-ROADMAP.md`：迭代路线；`FUNCTIONS.md`：功能清单；`ACCEPTANCE-CHECKLIST.md`：验收；`CLAUDE.md`：Claude 上下文。
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
