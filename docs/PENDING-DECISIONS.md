# docs/PENDING-DECISIONS.md — 待决策 / 待评估事项

> 创建：2026-09-26，由 WorkBuddy(搭档) 会话落盘。
> 用途：作为「hermes 评估」的统一入口。hermes 读完整 `docs/` 后，重点处理本文件列的两件事。
> 状态：**两项均未拍板，等 hermes 评估后给建议，再由 sifa 决策。**

---

## 背景（已锁死的战略，勿再发散）

- **项目定位**：AI 时代基础设施中枢 = 多 Agent 网关 + 中台 + 治理层（非纯模型代理，非自用）。
- **v1 定义**：架构完整、链路通、大部分模块齐，发布即卡位；后续版本只细化/完善/添砖加瓦。
- **v1 边界**：已量化写在 [`docs/02-product/V1-SCOPE-BOUNDARY.md`](./02-product/V1-SCOPE-BOUNDARY.md)（5 条可验收判据 + 7 类明确划进 v2 的发散项）。
- **协议分析**：已完成对比，写在 [`docs/04-business/LICENSE-STRATEGY.md`](./04-business/LICENSE-STRATEGY.md)（结论：主推 AGPL-3.0，防大厂白嫖；可选 + 商业双许可保留收费权）。

---

## 待办 1 — 开源协议选型（用户暂不拍板，需评估）

现状：`LICENSE-STRATEGY.md` 给出两个候选，sifa 未决：

| 候选 | 含义 | 适用场景 |
|------|------|----------|
| **A. AGPL-3.0 单许可** | 强 copyleft，连 SaaS 部署都得开源 | 纯开源推广、最大化防白嫖、开源即卡位 |
| **B. AGPL-3.0 + 商业双许可** | 开源版 AGPL + 额外商业授权合同 | 想保留未来向企业收费的权利 |

**需 hermes 评估并回答**：
1. 结合项目已存在的商业化文档（`04-business/open-core-boundary.md`、`commercialization-decided.md`、`vetarai-competitive-analysis.md`），判断当前阶段该选 A 还是 B？
2. 单许可 AGPL 是否会与现有任何依赖/协议冲突？（见 LICENSE-STRATEGY.md 的「依赖合规」段）
3. 给一句明确的推荐结论 + 理由（≤ 5 行）。

---

## 待办 2 — v1 收口就绪度评估（对照边界清单）

现状：`V1-SCOPE-BOUNDARY.md` 已定义 v1 必含的 5 条判据，但**尚未有人正式核对"代码现状是否真的满足"**。

**需 hermes 评估并回答**（只读文档 + 必要代码核查，不擅自改代码）：
1. 对照 5 条判据，逐条给出：**已满足 / 部分满足 / 缺口** + 缺口说明。
2. 重点核对测试基线真值：manager 770 · codex 62 · cursor 193 · hermes 77 是否仍全绿（参照 `docs/01-feature-matrix.md` 与 `docs/06-test/`）。
3. 列出 v1 发布前**必须**补的缺口（若有），与"可延后到 v2"的项，明确分开。
4. 给出一句话结论：v1 是否已可进入"冻结 + 发布"状态？

---

## 给 hermes 的评估指引（建议阅读顺序）

```
1. docs/INDEX.md                         # 项目全貌入口
2. docs/01-feature-matrix.md             # 功能完成度矩阵（测试数字来源）
3. docs/02-product/V1-SCOPE-BOUNDARY.md  # v1 边界（本评估的对照基准）
4. docs/04-business/LICENSE-STRATEGY.md  # 协议分析（待办 1 依据）
5. docs/04-business/open-core-boundary.md + commercialization-*.md  # 商业化上下文
6. 根目录 README.md / AGENTS.md          # 定位与开发铁律
7. 按需核查代码（l2/、*-proxy/、multi-proxy-manager/）
```

**约束**：
- 本次任务 = **评估 + 给建议**，不是改代码。任何代码改动需 sifa 在决策后另行指令。
- 严格对照边界清单收敛，不要借评估之名引入 v2 发散项（会话存档 / AGENTGIT / DAG 健康图深化 / 动态重规划 等已在边界文档划为 v2）。
- 产出：把评估结论回写本文件对应待办下，或另开 `docs/09-review/` 评估纪要，供 sifa 决策。
