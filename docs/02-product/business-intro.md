# 商业简介（business-intro）

> 自动成稿自 `docs/04-business/commercialization-decided.md`（20 题决策，主源）+ `docs/01-feature-matrix.md`（现状数字）。
> 生成日期：2026-09-17。面向外部 / 汇报，数字决策均回源，无臆造。

---

## 一句话定位

multi-proxy（Proxy Rebuild）是一个**全本地的多代理统一管理与编排中枢**：把 Codex / Hermes / Cursor 等 AI agent 当员工统一运维，按任务类型自动调度、自动选性价比，根治 agent 因 API 限速导致的任务中断。

---

## 目标用户

**个人开发者（首站）**，延伸至中小团队与企业私有化部署。形态贴合开发者 agent 运维台，零迁移成本。

---

## 产品形态

- **多代理统一管理台**：codex / hermes / cursor / manager 四代理统一启停、路由、日志、健康。
- **L2 编排中枢**：Agent Registry + 编排引擎（拆解 → 路由 → 执行 → 聚合）+ 插件运行时 + 记忆 / 技能 / 告警 / 成本服务。
- **Electron 桌面壳（P5）**：整装 / 卸，代理配置 + 日志 + 概览界面。
- **开放接入**：不锁定主流 agent，任何实现 Adapter 协议的 agent 可热插拔接入 / 卸载。

---

## 商业模式

**开源 + 云增值**（Q3 已拍）。

- 成本梯度分档：本地免费 → Agnes 免费 → DeepSeek 缓存红利 → Qwen 默认。
- 增值层：云端编排 / 配额 / 团队 / SLA。
- 护城河：DSH 生态（分发）+ 成本 / 审计数据（积累）+ 切换成本（桌面壳 + 编排绑定）。

---

## 当前进展（2026-09-17）

| 项 | 状态 |
|----|------|
| 4 代理模块 | ✅ 全绿上线 |
| L2 10 核心模块 | ✅ demo 全 PASS（插件运行时 / Registry / 编排 / 告警 / 成本等） |
| M6 智能路由 | ✅ 端到端实证（coding→deepseek HTTP 200 + 审计落盘） |
| P5 桌面壳 | ✅ 已闭环（commit `2163ca9`） |
| 全量测试 | ✅ jest 635/635（40 suites）+ l2 demo 全绿 |

---

## 路线图

阶段 0 M6 + E2E（✅ 完成）→ 阶段 1 MVP（P5 桌面壳 + 成本面板 + DSH 生态）→ 阶段 2 变现（配额 / 团队 / SLA / 云编排）→ 阶段 3 护城河（数据积累 + 切换成本）。详见 `ITERATION-ROADMAP.md` 与 `commercialization-decided.md` 三、分阶段路线。

---

## 数据源

| 项 | 来源 |
|----|------|
| 商业模式 / 20 题决策 | `docs/04-business/commercialization-decided.md` |
| 现状完成度 / 测试数字 | `docs/01-feature-matrix.md` + 2026-09-17 E2E 复验 |
| 路线图 | `ITERATION-ROADMAP.md` |
