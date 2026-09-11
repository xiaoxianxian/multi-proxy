# MEMORY.md — multi-proxy 项目记忆

> 供 WorkBuddy / Claude / Codex / Hermes 等 agent 读取，作为本项目单一事实来源。
> 仅内部使用，分发包剔除。最后更新：2026-09-10（原名 proxy-rebuild，已合并改名）

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
