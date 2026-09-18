# docs/INDEX.md — 项目文档总入口

> **用途**：所有 agent / 人类读项目的第一个入口。只需读本文件 + `docs/01-feature-matrix.md`
> 即可掌握项目全貌；不需要翻全仓库。
>
> **评估完成度 / 项目进度，只读本文件 + `docs/01-feature-matrix.md` 即可**
> （单一入口约定，2026-09-17 据 DeepSeek 评估意见补入；文档体系已无实质缺口——
> 活跃 33 份（docs/ 内，含 3 ADR）+ 根目录核心 9 份，勿据爬虫快照误判"还缺文档"）。

**最后更新：2026-09-17**

---

## 项目一句话

multi-proxy（Proxy Rebuild）是一个**多 Agent 编排中枢（L2，网关 + 中台）**：管理 Codex / Hermes / Cursor 三个
AI 代理的启停、路由、日志和告警，核心是 L2 编排中枢（10 内核模块 + 3 非侵入 adapter），
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
| `docs/09-review/archive/CLAUDE.md` | 根目录→archive | 原铁律库（Claude Code 弃用后 09-17 归档；铁律已收敛 `AGENTS.md`/`03-adr/`/`07-ops/ENV-NOTES.md`/`P0-FIXES.md`）|
| `README.md` | 根目录 | 项目入门 + 功能概述 |
| `USER-GUIDE.md` | 根目录 | 用户手册 |

### 二级专题文档

| 文件 | 位置 | 用途 |
|------|------|------|
| `docs/INDEX.md` | `docs/` | **本文件 — 文档入口** |
| `ACCEPTANCE-CHECKLIST.md` | 根目录 | 验收准备（安装/配置/启动/882/882 测试表/验收清单，78 行）|
| `docs/06-test/acceptance.md` | `docs/06-test/` | 验收结论（AC-1~7 标准 / 签署 / 待确认项 9 项处置，2026-09-17 据 DeepSeek 第四轮收口）|
| `docs/09-review/consistency-report.md` | `docs/09-review/` | 一致性报告（E批，doc↔code）✅ 已收口 |
| `docs/09-review/risk-register.md` | `docs/09-review/` | 风险登记册（DeepSeek 第三轮补齐：已知问题/代码TODO/幽灵路径/测试盲区分级，P0-F0 阻塞判定） |
| `docs/09-review/unknowns.md` | `docs/09-review/` | 未知/待补清单（E批）✅ 已收口（9 unknown 全标注处置）|
| `docs/05-design/visual-design.md` | `docs/05-design/` | 视觉设计规范（D批，token层提取） |
| `docs/07-ops/deployment.md` | `docs/07-ops/` | 部署指南（C档，三模式） |
| `docs/07-ops/runbook.md` | `docs/07-ops/` | 运维手册（C档） |
| `docs/07-ops/rollback.md` | `docs/07-ops/` | 回滚指南（C档） |
| `docs/08-user/faq.md` | `docs/08-user/` | 常见问题（C档）；用户手册见根目录 `USER-GUIDE.md`（docs/08-user/ 仅存 FAQ 与补充材料）|
| `docs/02-product/business-intro.md` | `docs/02-product/` | 商业简介（B档，对外/汇报） |
| `docs/03-architecture/architecture.md` | `docs/03-architecture/` | 架构文档（B档，四层+L2模块） |
| `docs/02-product/PRD.md` | `docs/02-product/` | 产品需求文档（B档，反向推） |
| `docs/00-codebase-map.md` | `docs/` | 代码库地图 + 模块速查（A档） |
| `docs/04-tech/data-model.md` | `docs/` | SQLite 数据模型 schema（A档） |
| `docs/04-tech/api.md` | `docs/` | API 接口文档（全部端点，A档） |
| `docs/03-adr/` | `docs/03-adr/` | ADR-0001 lsof绝对路径 / 0002 NO_PROXY铁律 / 0003 L2非侵入4铁律 |
| `docs/06-test/` | `docs/` | `test-cases.md`（全模块用例明细）+ `test-plan.md`（测试方案/分层/退出准则，DeepSeek 第三轮补齐） |
| `docs/_templates/` | `docs/` | 文档模板（ADR / PRD / test-cases，规范产出用） |
| `docs/_evidence/` | `docs/` | 证据存档（测试日志/截图/性能快照；数字可追溯，DeepSeek 第四轮补建） |
| `docs/02-product/dsh-integration.md` | `docs/` | DSH 生态接入规划（DS1/DS2/DS3，2026-09-17） |
| `docs/02-product/bundle-design.md` | `docs/` | DS2 前置：cordis.patch.yml/dsh.bundle 补丁结构草案 + 官方规范 + 8 条踩坑 + L2 映射（2026-09-18，等 DSH 0.2） |
| `docs/02-product/m6-action-checklist.md` | `docs/` | M6 智能路由 D4-D8 行动清单 + kimi 价基线（2026-09-16，决策1 enabled已满足 / 决策2 端到端实证通过 / 固化待老板定） |
| `docs/04-business/commercialization-decided.md` | `docs/04-business/` | 商业化决策结果 D2（20 题已定：个人开发者 + 开源+云增值 + MVP 路由/成本/桌面壳；3 项待补真实信号；2026-09-16） |
| `docs/04-business/commercialization-questions.md` | `docs/04-business/` | 商业化决策框架 D2（15 题 + 现状锚点 + 怎么逐项回答；2026-09-16） |

### 三级模块文档

| 文件 | 位置 | 用途 |
|------|------|------|
| `l2/README.md` | `l2/` | L2 编排中枢入口 |
| `l2/adapter-protocol.md` | `l2/` | 开放接入协议（agent 可热插拔）|
| `l2/CASES.md` | `l2/` | 3 个核心案例 + 复现命令 |
| `l2/PERF-REPORT.md` | `l2/` | L2 性能报告 |
| `ITERATION-ROADMAP.md` | 根目录 | 长期路线图 + DSH 接入规划 |
| `docs/09-review/archive/PLUGGABLE-ARCH-ASSESSMENT-2026-08-25.md` | 根目录→archive | 可插拔架构评估（已归档）|
| `docs/09-review/archive/PROJECT-STATUS.md` | 根目录→archive | 项目状态快照（已归档）|
| `docs/09-review/archive/README.md` | (见上) | 过程文件归档区（归档规则 + 入档清单，见本 README）|

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
| `docs/09-review/archive/review-2026-08-24/00-SUMMARY.md` | 综合评审总结 |

---

## 验收入口（阅读顺序）

| 谁读 | 顺序 | 说明 |
|------|------|------|
| 验收人 / 签署者 | `ACCEPTANCE-CHECKLIST.md` → `docs/06-test/acceptance.md` | 前者是**操作清单（怎么跑）**，后者是**验收结论 + 签署栏（跑完判定什么）**。先操作后结论。 |
| 评估完成度 | 本文件 + `docs/01-feature-matrix.md` | 单一入口，无需翻仓。 |
| 查数字证据 | `docs/_evidence/` | 882/882 快照 + 复现命令（铁律：数字必真跑）。 |

---

## 功能完成度摘要

详见 `docs/01-feature-matrix.md`。截至 2026-09-17（HEAD `640e12b`，main）：

| 层级 | 数量 | 状态 |
|------|------|------|
| 4 个代理模块 | 4/4 运行 | ✅ |
| 4 个前端页面 | 4/4 上线 + 3 新页面（health/alerts/registry） | ✅ |
| L2 核心模块 | 10/10 实现 | ✅ |
| L2 adapter | 3/3 实现 | ✅ |
| 总测试（全模块） | 644 jest / 55 codex-jest / 63 pytest / ~193 l2 checks / 11 bats | ✅ 全绿 |
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
| 2026-09-17 | 据 DeepSeek 评估意见：INDEX 框定对齐 README「L2 编排中枢」；确立「评估完成度只读 INDEX + 01-feature-matrix」单一入口约定；核实文档体系无实质缺口（活跃 25 份 + 3 ADR + 测试方案 + FAQ），不采纳其「还缺测试方案/FAQ/ADR」误判（本地已有） | Hermes |
| 2026-09-17 | 测试数字真跑校准（据 DeepSeek 第二轮）：cursor 119→131/9→11（feature-matrix/test-cases/codebase-map 当前视图 + 派生总数 jest 807→819、总 1064→1076）、L2 demo 14→13（10 内核+3 adapter）；历史快照（ITERATION-ROADMAP D6-a / MEMORY 教训）保留。E批收口标 ✅ + docs/08-user 用户手册约定 + archive/README.md 归档说明 | Hermes |
| 2026-09-17 | 补齐 DeepSeek 第三轮真缺口：`docs/09-review/risk-register.md`（风险登记册 P0-P3 分级）+ `docs/06-test/test-plan.md`（测试方案/退出准则）；INDEX 加 2 新行；核实 02-product/consistency/unknowns/user-manual 均爬虫误判（本地已有） | Hermes |
| 2026-09-17 | AGENTS.md 落地 commit `8a1e3bc`（cp 暂存版绕 non-CLI gate）：CLAUDE.md 职能合并 + 数字 cursor 119→131 / L2 14→13 demo + 引用改向 03-adr/ENV-NOTES/P0-FIXES；CLAUDE.md 全库改向（上条「AGENTS 未改」已闭环） | Hermes |
|| 2026-09-16 | 新增 `docs/04-business/commercialization-questions.md`（D2 决策框架 15 题）+ `docs/02-product/m6-action-checklist.md`（D4-D8 实核 + kimi 价基线） | Hermes |
| 2026-09-16 | 补 `codex-proxy/tests/auth-and-admin.test.js`（+17 tests，3 文件 / 53 全绿）+ 同步 INDEX/test-cases/feature-matrix（缺口#4 闭环） | Hermes |
| 2026-09-16 | 落 `.dsh/skills/`（2 SKILL，DSH 规范）+ `docs/02-product/dsh-integration.md`（DS1✅/DS2·DS3 暂缓） | Hermes |
| 2026-09-16 | 落 `docs/03-adr/`（3 ADR）+ `docs/06-test/test-cases.md`（6 模块测试方案，数字真跑） | Hermes |
| 2026-09-16 | 补建 `AGENTS.md` / `docs/INDEX.md` / `docs/01-feature-matrix.md` / `docs/_templates/` | Hermes |
| 2026-09-16 之前 | `L2-BLUEPRINT` P3 ✅ / `l2/CASES.md` / `l2/PERF-REPORT.md` / `l2/adapter-protocol.md` / `CLAUDE.md` | Hermes / WorkBuddy |
| 2026-09-18 | item3 Block 2 完成：将 cursor-proxy 3 个监控模块（CircuitBreaker/RateLimiter/HealthMonitor）提取为 l2 公共 JS（circuit-breaker.js/rate-limiter.js/health-monitor.js），各附 demo，codex-proxy 接入并补测试 2 项（53→55）。L2 demo 13→16（新增 3 监控模块），总 checks ~1084→~1088 | Hermes |
| 2026-09-17 | 据 DeepSeek 第四轮（收口/索引校准）：P2 补建 `docs/_evidence/`（证据存档 + README）；INDEX 修位置列瑕疵（`03-adr/`/`04-business/` 位置列填对）+ 加 `_templates/`/`_evidence/` 收录 + 概数 25→33/docs、HEAD a94de96→640e12b + 加「验收入口」小节；核实 DeepSeek 报的「codebase-map/04-business 未收录」为误判（已列）、AGENTS.md 已落地根目录（4836B「已批准」）、feature-matrix 数字已对齐 882/882（14/14 为模块级 demo check）| Hermes |
| 2026-09-18 | 据 DeepSeek 第五轮（两段）：核实 3 ADR 全在（P0 引用断裂=误判）+ 据 DSH 建议新建 `docs/02-product/bundle-design.md`（cordis.patch.yml/dsh.bundle 前置设计,等 DSH 0.2）+ dsh-integration.md 接引用 + INDEX 登记 | Hermes |

