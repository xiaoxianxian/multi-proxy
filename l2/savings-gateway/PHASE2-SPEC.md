# 省钱网关 v2（二期）· scope + 设计 · 成本预警阈值 + 自动降级

> 2026-09-21 · 非侵入 · 门控默认关（observe）· 零第三方依赖 · 不碰热路径

## 一、一期现状（复用，不改）
`gateway.js` 已实现：OpenAI 兼容省钱路由（难度档位 small/medium/large）+ 模拟 delta 记账
（`x_savings`）+ `produceCostSignal()` 喂 `alert.js` 的 `cost-budget-exceeded` 单阈值规则。
一期止于「按难度路由最便宜够强 + 算省了多少钱 + 把累计成本喂给告警」。

## 二、二期候选（scope，本批只做 1 个做透）
| 子项 | 价值 | 风险/侵入 | 本批 |
|---|---|---|---|
| **成本预警阈值 + 自动降级（cost-watchdog）** | 把「算省了」升级为「超预算就主动降级」，闭环 | 纯内存累计 + 复用 alert.js 契约，零热路径 | ✅ 做透 |
| 模型降级（按成本选 cheaper fallback） | 与 route-engine complexity→tier 重叠 | 中（需接 route 排序） | 留（watchdog 已含降级推荐） |
| 热迁移（运行中切 provider 不中断） | 高但需 executor 真执行缝 | 高（需 shadow off + 真实 dispatch） | 留二期+ |
| agent 适配层（不同 agent 协议） | 高但属独立模块 | 中 | 留独立增量 |

**本批选「成本预警阈值 + 自动降级」**：它是任务标注的「最稳」项，且把「预警」与「降级」两候选合一，
直接闭合一期的告警缺口（一期只 *喂* 单阈值信号、无状态、无自动动作）。价值/风险比最好。

## 三、为什么这 1 个最稳
- **零热路径**：纯内存累计 + 复用 `alert.js` 既有契约，不碰 `forward.js` / `codex-proxy/proxy.js`。
- **信号源无关**：内核消费抽象的「省账条目」（`{ts, actualCost, actualTier}`，即一期 `getSavingsLog()` 的产出），
  不 `require` manager 热路径（与 `cost.js`/`alert.js` 同构铁律）；`alert.js` 仍是单阈值，watchdog 是其上的多档 + 动作层。
- **门控默认关 / 非侵入**：`PROXY_COST_WATCH` 默认关 = observe（只算进内存、绝不落盘、不真发）；
  开 = 可 best-effort 落盘 `cost-watch-alarm.jsonl`（目录可注入、默认不写 home 以外）。内核不往 `process.env` 注入任何键。

## 四、设计（`cost-watchdog.js`，工厂范式 `createCostWatchdog(opts)`，与 alert.js/cost.js 同构）
- **两档阈值**：`warnBudget` / `criticalBudget`（CNY）。累计（滑动窗口 `windowMs`，0=全时）≥ 阈值即越级。
- **自动降级推荐**：越级时 `downgradeTo = cheaperTier(actualTier)`（成本梯度 `small<medium<large`，floor=small）；
  并给「若按推荐档位打」的单请求省钱额 `perReqSaving = cost(from) − cost(to)`。
- **防告警风暴**：同 `level` 在 `cooldownMs` 内只 fire 一次（`deduped` 标记，镜像 `alert.js` 去重），仍登记进 `alarms[]`。
- **喂 alert.js**：`produceAlertSignal()` → `{source:'cost', providerId, cost, budget}`（`budget` 取越级档阈值），
  形状与一期 `produceCostSignal` / `cost.js` 完全一致 → `alert.js` `cost-budget-exceeded` 直接接管。
- **降级可落地**：watchdog 只给 *推荐*；demo 演示「操作员应用推荐」= 把下一请求按 `downgradeTo` 对应
  complexity 重发（`large→high` / `medium→medium` / `small→low`），证明推荐 actionable（仍走一期 gateway，纯内存）。

## 五、边界（YAGNI 诚实标注）
- `alert.js` 仅 `cost-budget-exceeded` 单档 severity=warning；watchdog 的多档（warn/critical）+ 降级动作为其上层，
  不要求 `alert.js` 改（非侵入边界）。
- 热迁移 / agent 适配层 / 价格进 route 排序 / 排行榜落盘 全部留后续（一期 README 已列）。
- 本批不改 `gateway.js` / `server.js`（基线 24/24 + 18 例 jest 零回退）；watchdog 经 `getSavingsLog()` 纯消费集成。
