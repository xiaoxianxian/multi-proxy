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
3. M7 任务级 Session（§8.5 P0，蓝图已列）；AIGC adapter 缺口（蓝图列、`find -iname "*aigc*"` 为空，P1）


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
4. **方向六 P2/P3 未动**：P2 = 装 Paseo（`brew install --cask paseo`，brew 上确认真实存在 v0.8.0，2026-09-14 开始安装）；P3 = 参照 Emdash/Orca 设计 sessions.json checkpoint + Tmux 保活（依赖 P1 已完成，可排期）。
5. **未 push 提示**：`9a46c7f`/`0d33824`/`f99111f` 三个 commit 在本地 main，未 push（push 需老板点头）。

### 13.1 教训

- **写外部运行态 db 前查进程**：上轮"WorkBuddy 没在跑可以 TRUNCATE checkpoint"的前提这轮失效了（进程在跑），改为 WAL 并发写 + `con.backup()` 一致性快照。前提变了流程就得跟着变，不能照搬旧脚本。
- **commit message 与实际改动对齐**：`0d33824` message 写"校准 MEMORY.md §十三"但实际只改了 L2-BLUEPRINT——§十三 是这轮才补写的。message 是给别人（和自己）的契约，写之前对着 `git status -s` 核一遍。
