# DeepSeek 文档缺口清单评估（2026-09-16）

> 来源：`chat.deepseek.com/share/6phvit41x6blxpxaik`（右侧 preview pane 读取，未开用户浏览器）。
> 核实方式：按本地 `find docs` + 根目录 `ls` 实测。DeepSeek 凭 GitHub 远观，可能滞后——
> 本仓已 push 的部分文档它没看到，下面逐条按**项目实际**重排，不 100% 照搬它的 7 步。

---

## 一、DeepSeek 清单 vs 本地真实

它列的 10 项「缺失」——**本地全部确认是缺失**（真缺口）：

| 项 | 本地 |
|---|---|
| docs/00-codebase-map.md | ❌ 缺 |
| docs/02-product/PRD.md | ❌ 缺 |
| docs/02-product/business-intro.md | ❌ 缺 |
| docs/03-architecture/architecture.md | ❌ 缺（只有 architecture.html/v2 可视化，无可检索 md）|
| docs/04-tech/api.md | ❌ 缺 |
| docs/04-tech/data-model.md | ❌ 缺 |
| docs/05-design/visual-design.md | ❌ 缺 |
| docs/07-ops/deployment.md / runbook.md / rollback.md | ❌ 缺 |
| docs/08-user/faq.md | ❌ 缺 |
| docs/09-review/consistency-report.md / unknowns.md | ❌ 缺 |

**它远观漏掉的、我们其实已有的**（它没在 GitHub 看到 / 看了旧版）：

| 它没提 | 本地实际 |
|---|---|
| commercialization-decided.md / commercialization-questions.md | ✅ docs/04-business/，20 题全决策 |
| m6-action-checklist.md | ✅ docs/02-product/，决策 1/2 已实证 |
| deepseek-baseline.md | ✅ docs/02-product/，v4-pro 价基线 |
| L2-BLUEPRINT.md / P0-FIXES.md / ACCEPTANCE-CHECKLIST.md / FUNCTIONS.md | ✅ 根目录 |
| ADR 3 篇 | ✅ 它说 3 篇，本地确认 0001/0002/0003 |

---

## 二、它远观不准的一处（AGENTS.md 落地方式）

它建议 `mv docs/_proposed-AGENTS.md AGENTS.md`。**本仓跑不了**——本地实情：

- `AGENTS.md` **已在根目录**（4808 字，草稿态，头写「状态：待老板批准…agent 无法自行创建根目录版本」）。
- `docs/` 下**没有** `_proposed-AGENTS.md`（find 已核）。

→ 落地方式应是「老板对话中批准草稿转正」或手动确认，**不是 mv**。它没看到本地实情。

---

## 三、按项目实际重排（核心：复用现有，不重造）

DeepSeek 的 7 步里有不少和现有文档重叠。按「能复用就复用、能自动生成就自动、需老板输入的单独提」重排：

### A. 第一批 · 纯自动生成 · P0（高价值、低争议）

| 项 | 处理 | 复用 / 材料 |
|---|---|---|
| 00-codebase-map.md | 做，但**复用** 01-feature-matrix 不重造 | 01-feature-matrix + 各模块 AGENTS 速查 + L2-BLUEPRINT |
| 04-tech/data-model.md | 做（cursor-proxy SQLite 是真缺口） | cursor-proxy schema / proxy.db |
| 04-tech/api.md | 做，**必须真扫 4 模块路由**，不编 | 各 proxy 路由 + l2/README 契约 |

### B. 第二批 · 从现有材料提炼（不另起炉灶）

| 项 | 处理 | 复用 / 材料 |
|---|---|---|
| 03-architecture/architecture.md | 提炼成可检索 md | architecture.html/v2 + PLUGGABLE-ARCH-ASSESSMENT |
| 02-product/PRD.md | 反向推 | commercialization-decided + 01-feature-matrix |
| 02-product/business-intro.md | 商业决策已定，可**自动成稿**，不需人写 | commercialization-decided |

### C. 部分重叠 · 借鉴现有（manage.sh/CLAUDE 已覆盖 70%）— ✅ 2026-09-17 完成（commit a94de96 后）

| 项 | 处理 | 状态 |
|---|------|------|
| `docs/07-ops/deployment.md` | 三种部署模式（manage.sh/install.sh/Docker）+ 环境表 + 门控 | ✅ 3634B |
| `docs/07-ops/runbook.md` | 日常速查 + 故障诊断 + NO_PROXY 铁律 + 安全清单 | ✅ 4610B |
| `docs/07-ops/rollback.md` | 5 类回滚场景 + docker/配置回滚 + 检查清单 | ✅ 3400B |
| `docs/08-user/faq.md` | Q1-Q8 实跑验证问答 | ✅ 3211B |

### D. 缓 / 标 [待确认]

| 项 | 处理 |
|---|---|
| 05-design/visual-design.md | 管理面板是纯 Express 静态页，无设计系统 → 低优先，标 [待确认] |

### E. 收口

| 项 | 处理 |
|---|---|
| 09-review/consistency-report + unknowns | 放最后，真对比 doc↔code（用 project-hygiene / requesting-code-review skill），不编 |

---

## 四、待老板拍板

1. **执行范围**：先做第一批 A（codebase-map + data-model + api，纯自动）？还是 A+B 一起做？
2. **AGENTS.md 落地**：是否批准草稿转正（非 mv）？
3. **faq / visual-design**：faq 从 CLAUDE 提炼做，visual-design 标 [待确认] 缓——可否？

> 原则：不照搬 DeepSeek 7 步全做。能自动生成 + 高价值的先做；和现有文档重叠的复用而非重造；需老板输入/拍板的单独提出。
