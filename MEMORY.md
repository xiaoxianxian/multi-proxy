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
