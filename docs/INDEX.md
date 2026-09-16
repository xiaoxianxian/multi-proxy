# docs/INDEX.md — 项目文档总入口

> **用途**：所有 agent / 人类读项目的第一个入口。只需读本文件 + `docs/01-feature-matrix.md`
> 即可掌握项目全貌；不需要翻全仓库。
| 最后更新：2026-09-17 |

---

## 项目一句话

multi-proxy（Proxy Rebuild）是一个**多代理统一管理系统**：管理 Codex / Hermes / Cursor 三个
AI 代理的启停、路由、日志和告警，核心是 L2 编排中枢，
已按 DeepSeek Harness "一切皆插件" 理念设计，可零改造热插拔新 adapter。

---

## 快速开始

```bash
# 安装依赖
bash install.sh --all

# 启动所有服务
bash manage.sh start

# 查看状态
bash manage.sh status

# 停止所有服务
bash manage.sh stop
```

详见根目录 `README.md` 和 `USER-GUIDE.md`。

---

## 文档地图

### 一级核心文档

| 文件 | 位置 | 用途 |
|------|------|------|
| `AGENTS.md` | 根目录 | AI 代理铁律（本文件前置）|
| `CLAUDE.md` | 根目录 | 项目铁律 + 已知坑（写保护）|
| `README.md` | 根目录 | 项目入门 + 功能概述 |
| `USER-GUIDE.md` | 根目录 | 用户手册 |

### 二级专题文档

| 文件 | 位置 | 用途 |
|------|------|------|
| `docs/INDEX.md` | `docs/` | **本文件 — 文档入口** |
| `docs/01-feature-matrix.md` | `docs/` | 功能完成度矩阵（必读） |
| `docs/00-codebase-map.md` | `docs/` | 代码库地图 + 模块速查（A档） |
| `docs/04-tech/data-model.md` | `docs/` | SQLite 数据模型 schema（A档） |
| `docs/04-tech/api.md` | `docs/` | API 接口文档（全部端点，A档） |
| `docs/03-adr/` | `docs/` | ADR-0001 lsof绝对路径 / 0002 NO_PROXY铁律 / 0003 L2非侵入4铁律 |
| `docs/06-test/` | `docs/` | test-cases.md 全模块测试方案（数字真跑） |
| `docs/02-product/dsh-integration.md` | `docs/` | DSH 生态接入规划（DS1✅ / DS2·DS3 暂缓） |
| `docs/02-product/m6-action-checklist.md` | `docs/` | M6 智能路由 D4-D8 行动清单 + kimi 价基线（2026-09-16，决策1 enabled已满足 / 决策2 端到端实证通过 / 固化待老板定） |
| `docs/04-business/commercialization-decided.md` | `docs/` | 商业化决策结果 D2（20 题已定：个人开发者 + 开源+云增值 + MVP 路由/成本/桌面壳；3 项待补真实信号；2026-09-16） |
| `docs/04-business/commercialization-questions.md` | `docs/04-business/` | 商业化决策框架 D2（15 题 + 现状锚点 + 怎么逐项回答；2026-09-16） |

### 三级模块文档

| 文件 | 位置 | 用途 |
|------|------|------|
| `l2/README.md` | `l2/` | L2 编排中枢入口 |
| `l2/adapter-protocol.md` | `l2/` | 开放接入协议（agent 可热插拔）|
| `l2/CASES.md` | `l2/` | 3 个核心案例 + 复现命令 |
| `l2/PERF-REPORT.md` | `l2/` | L2 性能报告 |
| `ITERATION-ROADMAP.md` | 根目录 | 长期路线图 + DSH 接入规划 |
| `PLUGGABLE-ARCH-ASSESSMENT-2026-08-25.md` | 根目录 | 可插拔架构评估 |
| `PROJECT-STATUS.md` | 根目录 | 项目状态快照 |

### 运维 / 部署

| 文件 | 用途 |
|------|------|
| `install.sh` | 安装 / 卸载 / 开机自启 |
| `manage.sh` | 启停 / 状态 / 日志 |
| `docker-compose.yml` | 容器编排 |
| `Dockerfile.codex/hermes/cursor/manager` | 各代理 Dockerfile |
| `tools/agent-proxy-switch` | 代理切换工具（cc-switch ↔ multi-proxy） |
| `deploy-local.sh/bat` | 本地部署脚本 |

### 过程记录（历史）

| 文件 | 说明 |
|------|------|
| `MEMORY.md` | 项目记忆（agent 共享，52KB 大文件）|
| `MEMORY-2026-09-10/11/12.md` | 当日日志 |
| `HANDOVER-2026-08-24/25/26/09-10.md` | 交接文档 |
| `P0-FIXES.md` | P0 安全修复记录 |
| `review-2026-08-24/00-SUMMARY.md` | 综合评审总结 |

---

## 功能完成度摘要

详见 `docs/01-feature-matrix.md`。截至 2026-09-17（HEAD `b21ff24`，main）：

| 层级 | 数量 | 状态 |
|------|------|------|
| 4 个代理模块 | 4/4 运行 | ✅ |
| 4 个前端页面 | 4/4 上线 | ✅ |
| L2 核心模块 | 10/10 实现 | ✅ |
| L2 adapter | 3/3 实现 | ✅ |
| 总测试（全模块） | 635 jest / 63 pytest / ~182 l2 checks / 11 bats | ✅ 全绿 |
| P5 GUI 桌面壳 | 已验收（截图确认窗口正常显示，2163ca9 push） | ✅ |
| 文档缺口 | 无（INDEX / feature-matrix / AGENTS / 模板已补） | ✅ |
| DSH 生态接入 | DS1 骨架已落（2 SKILL + 规划文档）；DS2/DS3 暂缓（#1496 guardrail 未修） | ✅ |
| 商业化文档 | `docs/04-business/commercialization-decided.md`（D2 20 题全决策已定） | ✅ |

---

## 已知风险与开放项

1. **C2/B7 幽灵路径**（`forward.js` axios 15s+100MB 全缓冲 / `codex-proxy` 120s+pipeTo）：
   全局零调用方，当前**修了反坑**，不修，触发条件（manager 成为 chat 统一入口）出现时再动。

2. **hermes-proxy 测试覆盖度**：3 文件 / 63 pytest 项，覆盖基本够用（无 E2E）；
   后续 P? 考虑补 E2E 测试。

3. **codex-proxy 测试**：已补 `auth-and-admin.test.js`，3 文件 / 53 tests 全绿（2026-09-16，
   auth 401/200 + settings + providers CRUD/脱敏/409 + balances + switch/test-connection guard）；
   仅剩超时/流式断流的真实 pipeTo 路径未覆盖（需 mock upstream 流，非本次范围）。

|| 4. **P5 GUI 看板 / 编排面板**：锦上添花，非阻塞，暂不实现。 → **已验收（2163ca9）** |

5. **DSH 生态 guardrail**：社区尚在修 `dsh plugin add` 安装可靠性（#1496）；
   本次只做文档 + SKILL.md 骨架，不实际发 npm 包。

6. **方向四 D6-b（健康决定真实路由）卡 M7 sign-off**：见 `ITERATION-ROADMAP.md`。

---

## 变更日志

|| 日期 | 变更 | 负责人 |
||------|------|--------|
|| 2026-09-17 | P5 GUI 桌面壳验收通过（commit `2163ca9`,已 push）— Electron 壳 + launch-gui.sh + 端口复用 + 占用检测；截图确认 Proxy Manager - Dashboard 窗口正常显示；测试 635/635 全绿 | Hermes |
|| 2026-09-16 | 新增 `docs/04-business/commercialization-questions.md`（D2 决策框架 15 题）+ `docs/02-product/m6-action-checklist.md`（D4-D8 实核 + kimi 价基线） | Hermes |
| 2026-09-16 | 补 `codex-proxy/tests/auth-and-admin.test.js`（+17 tests，3 文件 / 53 全绿）+ 同步 INDEX/test-cases/feature-matrix（缺口#4 闭环） | Hermes |
| 2026-09-16 | 落 `.dsh/skills/`（2 SKILL，DSH 规范）+ `docs/02-product/dsh-integration.md`（DS1✅/DS2·DS3 暂缓） | Hermes |
| 2026-09-16 | 落 `docs/03-adr/`（3 ADR）+ `docs/06-test/test-cases.md`（6 模块测试方案，数字真跑） | Hermes |
| 2026-09-16 | 补建 `AGENTS.md` / `docs/INDEX.md` / `docs/01-feature-matrix.md` / `docs/_templates/` | Hermes |
| 2026-09-16 之前 | `L2-BLUEPRINT` P3 ✅ / `l2/CASES.md` / `l2/PERF-REPORT.md` / `l2/adapter-protocol.md` / `CLAUDE.md` | Hermes / WorkBuddy |

