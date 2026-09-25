# AGENTS.md

> **状态：已批准**。这是给所有 AI 代理（Hermes / WorkBuddy / Claude Code / Codex 等）
> 定的统一规则。关联：`03-adr/`（3 份 ADR）+ `07-ops/ENV-NOTES.md`（环境）+ `P0-FIXES.md`。

## 0 · 必读前置

动手前先读 `03-adr/`（3 份 ADR）、`07-ops/ENV-NOTES.md`（环境）、`P0-FIXES.md`（安全修复）——原 `CLAUDE.md` 铁律已 09-17 弃用归档。
再读 `docs/INDEX.md`（项目文档总入口）和 `docs/01-feature-matrix.md`（功能完成度，评估单一入口）。

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
- 测试总计（2026-09-25 全量真跑；jest 合计 1051 = 770+62+219；+l2 318 + 6 Playwright TS + 11 bats ≈ 1380）：
    - multi-proxy-manager: 47 files / 770 测试（2026-09-25 实跑；jest 含 e2e-scenarios）
      - cursor-proxy: 17 files / 219 测试（需 NODE_OPTIONS=--experimental-vm-modules）
    - codex-proxy: 6 files / 62 测试（jest 2026-09-25 实跑）
    - hermes-proxy: 4 files / 77 pytest 项（含 e2e_hermes 14；integration_test.py 20 为独立 integration，不计入 77）
      - l2: 23 demo / 318 checks（全部 PASS，逐 demo 实跑求和 2026-09-25）
    - shell: 11 bats（本机无 bats binary，沿用历史值，不纳入 jest 合计）
    - E2E Playwright（独立矩阵，jest 不跑）：6 .ts 文件 ≈165，沿用历史快照

---

## 7 · 文档更新后同步 INDEX

每完成一个文档或功能变更，更新 `docs/INDEX.md` 的变更日志行，
让后续 agent 读入口即可掌握全局，无需翻全仓库。

---

## 8 · 禁止事项清单

- ❌ 不得改写 `03-adr/` / `07-ops/ENV-NOTES.md`（原 CLAUDE.md 铁律，09-17 收敛至此，改动需授权）
- ❌ 不得 `launchctl setenv NO_PROXY '*','...'` 类全局裸通配
- ❌ 不得 `git add -A` / `git add .`
- ❌ 不得向 `forward.js` / `codex-proxy/proxy.js` 热路径注入未经授权的改动
- ❌ 不得把文档中"历史问题"误述为"当前状态"
- ❌ 不得从文档中摘录性能数字，必须真跑

---

## 9 · 参考文件

- `03-adr/`（3 份 ADR：lsof/NO_PROXY/L2 非侵入）+ `07-ops/ENV-NOTES.md` + `P0-FIXES.md` — 原 CLAUDE.md 铁律/已知坑，09-17 弃用归档
- `docs/INDEX.md` — 全项目文档入口
- `docs/01-feature-matrix.md` — 功能完成度矩阵
- `ITERATION-ROADMAP.md` — 长期迭代路线图 + DSH 接入规划
- `l2/README.md` — L2 编排中枢入口文档
- `l2/adapter-protocol.md` — L2 开放接入协议
- `l2/CASES.md` — 3 个核心使用案例（含复现命令）
- `l2/PERF-REPORT.md` — L2 性能报告
