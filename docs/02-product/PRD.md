# 产品需求文档（PRD）

> 反向推自 `docs/04-business/commercialization-decided.md`（20 题决策，主源）、`docs/01-feature-matrix.md`（现状）、`docs/02-product/m6-action-checklist.md`、`docs/02-product/dsh-integration.md`。
> 生成日期：2026-09-17（HEAD `d5e554a`，main）。需求点全部映射回既有决策，无新增臆造项。

---

## 一、产品定位与目标用户

- **定位**：多代理统一管理系统 + L2 编排中枢。把 Codex / Hermes / Cursor 等 agent 当员工统一运维，按任务类型自动调度。
- **目标用户**：**个人开发者（首站）**（Q2 已拍）→ 中小团队 → 企业私有化。
- **核心痛点**：多 agent 混用时，API 限速 / 中断导致任务断（WorkBuddy 等 agent 跑不动大任务）。全本地 Harness 形态贴合个人开发者自部署 + 企业内部私有化。

---

## 二、核心价值与差异化

| 维度 | 说明（引 decided 1.2 / 1.3 / 1.4） |
|------|------|
| 直接竞品 | OpenAI Harness（托管）/ AutoGPT·LangGraph·CrewAI（编排框架）/ CC-Switch（15721 多代理切换） |
| 差异化 | 全本地（隐私 / 可控）+ M6 自动选性价比 + 本地 judge；不锁定 provider |
| 时机窗口 | 本地大模型（Qwen3.8-27B / MLX）已能扛 judge / decompose，「全本地」卖点前提成立 |

壁垒非单一能力（`findProviderByType` 是工程细节），而是「全本地 + 生态 + 成本/审计数据 + 切换成本」的组合（decided 5.1 / 5.2）。

---

## 三、MVP 范围（Q4 已拍）

**智能路由（M6）+ 成本面板（cost）+ 桌面壳（P5）**。

- M6 已端到端实证（coding→deepseek-v4-pro HTTP 200 + 审计落盘，commit `0049e36`）；override 常驻**暂不固化**（维持 shadow / 隔离稳态），固化命令已备。
- 成本面板基于 `l2/cost.js`（B 路余额趋势 + A 路 token×单价）。
- 桌面壳 P5 已闭环（Electron，commit `2163ca9`）。

**非目标（一期不做）**：告警 / 记忆二期，团队 / 配额 / SLA 增值层（decided 3.3）。

---

## 四、现状 vs 目标

| 项 | 现状（`01-feature-matrix.md`） | 目标 |
|----|------|------|
| 4 代理模块 | ✅ 全绿上线 | 稳定运维 |
| L2 10 核心模块 | ✅ demo 全 PASS | 生产接线（门控默认关，逐步开） |
| 3 adapter | ✅ demo 全 PASS | h3web 真实接入列 P1 |
| M6 智能路由 | D1-D3 落地，D4/D5 待老板拍 | 固化 override + enable ollama |
| P5 桌面壳 | ✅ 已闭环 | 接 DSH 生态分发 |
| 全量测试 | 635/635 | 维持全绿 |

---

## 五、商业模式（引 decided Q3 / 4.x）

- **开源内核 + 云增值**：本地模型成本≈0，`cost.js` 已能算花费；增值在云端编排 / 配额 / 团队 / SLA。
- **成本梯度分档**（4.2）：本地免费 → Agnes 免费 → DeepSeek 缓存红利 → Qwen 默认；增值层按任务量 / 团队席位。
- **分阶段路线**（decided 三）：阶段 0 M6 + E2E（✅ 完成）→ 阶段 1 MVP（P5 + 成本面板 + DSH）→ 阶段 2 变现（配额 / 团队 / SLA / 云编排）→ 阶段 3 护城河（数据积累 + 切换成本）。

---

## 六、开放问题（待补真实信号，不臆造，引 decided 四）

1. **市场大小 & 付费意愿**（1.5 / 2.3）：未做客户访谈不下结论，建议先用开源 + DSH 验证需求。
2. **P5 工时预期**：桌面壳已落地，需老板定后续投入。
3. **DSH 生态时间线**：能否拿到 0.2 / 收录流程，决定 2.4 获客落地。

---

## 数据源

| 项 | 来源 |
|----|------|
| 决策 Q2/Q3/Q4 + 20 题 | `docs/04-business/commercialization-decided.md` |
| 现状完成度 | `docs/01-feature-matrix.md` |
| M6 路由 / 价基线 | `docs/02-product/m6-action-checklist.md` |
| DSH 接入 | `docs/02-product/dsh-integration.md` |
