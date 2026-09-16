# AGENTS.md（草稿）

> **状态：待老板批准**。这是给所有 AI 代理（Hermes / WorkBuddy / Claude Code / Codex 等）
> 定的统一规则。因系统把 `AGENTS.md` 视同受保护的 agent 指令文件，agent 无法自行创建根目录版本，
> 故先存草稿，由老板 review 后落地。
> 落地方式（二选一）：① 老板在对话中明确批准我写根目录 `AGENTS.md`；② 老板手动 `mv docs/_proposed-AGENTS.md AGENTS.md`。
> 关联：`CLAUDE.md`（项目铁律，写保护，优先读）。

## 0 · 必读前置

动手前先读 `CLAUDE.md`（项目铁律，写保护，不可改写）。
再读 `docs/INDEX.md`（项目文档总入口）和 `docs/01-feature-matrix.md`（功能完成度）。

---

## 1 · lsof 绝对路径

`lsof` 必须使用完整路径 `/usr/sbin/lsof`。
Node.js 子进程的 `PATH` 不包含 `/usr/sbin`，使用裸 `lsof` 会导致 `isProcessRunning` 误判代理未运行，
表现为所有代理在 manager 面板上显示"未运行"。

违反此规则的典型后果：代理状态检测静默失败。

---

## 2 · NO_PROXY 铁律

**绝对禁止** 往全局 launchd 环境注入裸 `*` 的 NO_PROXY：

```
❌ launchctl setenv NO_PROXY "...,*,..."
```

**原因**：HTTP 客户端按逗号拆项做 `hostname.endsWith(项)`；`*` 去通配符后为空串 →
`endsWith('')` 恒真 → 所有请求绕过系统代理 → 直连被墙 IP → `ETIMEDOUT`。
**曾把 WorkBuddy、CC Switch 全部带崩。**

如确需绕过 localhost，只在代理自身 plist 的 `<EnvironmentVariables>` 内设：
```
NO_PROXY=127.0.0.1,localhost,::1
NO_PROXY 仅允许 localhost 类项：127.0.0.1 / localhost / ::1
```

历史来源：旧版 `codex-multi-model-proxy-deploy` 的 `install.sh:195-196`。
当前 `multi-proxy` 源码已无此写法，**新增代码务必保持**。

---

## 3 · 非侵入铁律（贯穿 L2 全部模块）

- **不写 agent 文件**：adapter 对下游 agent 只读，绝不写 `~/.codex`、cursor 配置等。
- **不注入全局 env**：不执行 `launchctl setenv` / `export` 到全局环境；如需 env，走 plist 局部配置。
- **不写死端口**：h3web adapter 端口**动态探测**（`8731` / `8732`），plist 写 8731，实测可能 8732。
- **门控默认关 / shadow 默认开**：新增能力必须 `gate: closed` 或 `shadow: true`，
  不改变现有行为，观察后再决定上线。

---

## 4 · 性能 / 数字必须真跑

所有性能数字、测试通过数必须来自**真实运行结果**，不得从文档摘录。
`docs/01-feature-matrix.md` 中每个数字必须可追溯到一条真实命令和它的输出。

---

## 5 · git 操作规范

1. **`git add --` 显式列文件**，绝不 `git add -A` / `git add .`。
2. commit 前先 `git status --short` 确认恰好预期文件数。
3. 每批文档 / 功能变更单独 commit，commit message 说明内容。
4. **push 前需老板确认**，不擅自推送到远端。
5. 热路径文件（`forward.js`、`codex-proxy/proxy.js`）非授权不改动。

---

## 6 · 项目结构速查

| 模块 | 技术栈 | 端口 |
|------|--------|------|
| multi-proxy-manager | Node.js + Express | 18792 |
| codex-proxy | Node.js + Express | 18790 |
| hermes-proxy | Python + Flask | 18793 |
| cursor-proxy | TypeScript + SQLite (better-sqlite3) | 18794 |
| cc-switch（独立 App，非本项目） | Rust/Tauri | 15721 |

- L2 编排内核全部在 `l2/` 目录，共 10 个核心模块 + 3 个 adapter。
- 测试总计（截至 2026-09-16）：
   - multi-proxy-manager: 40 files / 635 测试
   - cursor-proxy: 11 files / 119 测试
   - hermes-proxy: 3 files / 63 pytest 项
   - l2: 14 demo / 约 182 checks（全部 PASS）
   - shell: 11 bats

---

## 7 · 文档更新后同步 INDEX

每完成一个文档或功能变更，更新 `docs/INDEX.md` 的变更日志行，
让后续 agent 读入口即可掌握全局，无需翻全仓库。

---

## 8 · 禁止事项清单

- ❌ 不得改写 `CLAUDE.md`（写保护）
- ❌ 不得 `launchctl setenv NO_PROXY '*','...'` 类全局裸通配
- ❌ 不得 `git add -A` / `git add .`
- ❌ 不得向 `forward.js` / `codex-proxy/proxy.js` 热路径注入未经授权的改动
- ❌ 不得把文档中"历史问题"误述为"当前状态"
- ❌ 不得从文档中摘录性能数字，必须真跑

---

## 9 · 参考文件

- `CLAUDE.md` — 项目铁律 + 已知坑（写保护，优先读）
- `docs/INDEX.md` — 全项目文档入口
- `docs/01-feature-matrix.md` — 功能完成度矩阵
- `ITERATION-ROADMAP.md` — 长期迭代路线图 + DSH 接入规划
- `l2/README.md` — L2 编排中枢入口文档
- `l2/adapter-protocol.md` — L2 开放接入协议
- `l2/CASES.md` — 3 个核心使用案例（含复现命令）
- `l2/PERF-REPORT.md` — L2 性能报告
