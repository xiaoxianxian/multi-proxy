# Q1 无法闭环 / 待补 待办清单（2026-09-22）

> 老板②要求："尽量别搞先上这种操作，欠的作业太多时间长了就忘了，除非你记一堆待办。"
> 本表记录 **官方层面无法回源 / 需等待外部条件** 的项，逐条挂 owner + 触发条件 + 当前兜底。
> 与 `q1-pricing-routing-arch-v1.md §3.9.1` 对应。状态：⬜待办 / 🟡部分可 / ✅可闭环。

## A · 配额精确数值（老板②核心诉求）

| 项 | 现状（2026-09-22 回源实测） | 能否闭环 | 当前兜底设计 | 升级触发条件 | owner |
|---|---|---|---|---|---|
| OpenAI Codex **周上限**精确数字 | 官方只说"weekly limits may also apply"，**不公布数字** | ❌ 官方不公开 | `monthlyQuotaTokens` estimate + `quotaSource:'estimate-openai-5h-window'`，用户可改 | 官方公布 or 实测采集 /status 剩余 | 老板+实测 |
| OpenAI 绝对 token 数 | 官方只给"每5h本地消息数区间"（非 token） | ❌ 需换算假设 | 消息→token 估算（标口径） | 实测 token 计量 | 实测 |
| Claude 周上限绝对值 | 官方给"at least N 消息/5h"，周上限只说"reset weekly" | ❌ | 同上 estimate + 用户可改 | 实测 | 老板+实测 |
| Gemini 绝对 token 数 | 官方只给 4×/5–20× 倍数 | ❌ | 倍率 → 估算 | 实测 | 实测 |
| Kimi 各档固定 token 配额 | 官方口径 = agent credits + 未公开 5h/周 cap，只给"对 Andante N 倍"；社区等效 Allegretto≈35.7M(coding) | 🟡 有社区实测等效值，非官方 | 采用社区等效值 + `quotaSource:'community-estimate'`，用户可校准 | 官方公开 or 接入 Kimi Code 控制台 API（需 sk-kimi-xxx）| 老板 |

> **诚实边界：** 以上 5 项**官方层面无法回源到精确固定值**。设计采用 estimate + 用户可改 + 安全退化（§3.4/§3.6/§3.8/§3.9.1），
> **绝不产假精确值**。精确度升级依赖：(a) 官方公开，(b) 实测采集（Codex 可跑 `/status`，Kimi 需 Coding Plan 控制台 API key）。
> 在 (a)/(b) 满足前，配额预检走"**估算 + 宁可早停**"（老板③已拍）。

## D · P1 交付记录（2026-09-22 · 老板授权）

架构稿 §7 P1 全交付，**门控关逐字节不变 + 热路径 `getNextRoute` 0 改动**（汇率接入路由选择留 P5）：

| 交付物 | 现状 | 证据 |
|---|---|---|
| F1 deepseek-v4-pro `1/4/0.02 → 0.5/3/0.02` | ✅ 已修（`routeEngine.ts` L0，相对序不变 qwen/agnes=0 < deepseek < kimi） | tsc 0 + 测试 F1 |
| 价表三层 L0/L1/L2 + currency/source/_userSet 字段 | ✅ 落地（全可选，`estimateCost` 忽略 → 路由不变） | `ruleEvaluator.ts` |
| 纯函数 `resolveFxRate`/`resolvePricing`/`resolveBillingCost`/`resolveModelEnabled`/`rankByCostCny`/`approxEqual` + 3 类型 | ✅ 落地，门控 `PROXY_FX_CURRENCY`/`PROXY_BILLING_MODE`/`PROXY_FX_RATE` 默认关、逐模型 enabled 默认关 | `ruleEvaluator.ts` |
| 测试 `tests/unit/pricing-fx.test.ts` **31 条** | ✅ 全绿（架构估 15，实测写足；覆盖 F1/汇率门控/resolveFxRate 优先级+异常/resolveBillingCost/resolvePricing 三层+_userSet 短路/逐模型门控/approxEqual） | jest 31/31 |
| **验收** | ✅ `tsc --noEmit` 0 错 + 全量 jest **174/174**（原 143 不回退，新增 31）+ 门控关逐字节不变（`rankByCostCny≡rankByCost`、`cny≡estimateCost` 实证）+ 热路径 0 改动 | 实测 |

> **边界说明**：汇率接入路由选择（`getNextRoute` 调 `rankByCostCny`）= 架构稿 §3.6/§7 **P5**，P1 严守数据层未碰接线。P2-P5 待老板单独授权，不抢。

## B · 其他待外部条件项

| 项 | 现状 | 升级条件 | owner |
|---|---|---|---|
| fx 汇率自动刷新（方案 B 拉 API） | 默认走方案 C（缓存+手动刷新，§3.5.1），兜底 fx=7.2 | 老板要自动时接汇率 API，仍不入热路径（非侵入） | 老板定 |
| 配额精确回源自动采集器 | 未建；Codex `/status` / Kimi 控制台可采 | 设计采集脚本，observe 落 `quota-cache.json` | 老板授权 |
| 历史价格趋势（§3.12 P5） | 设计预留 `pricing-history.json`，本期不实现 | P5 排期 | 老板 |
| 渠道健康度权重（§3.11）依赖 M2 执行态 | M2 observe 中，观察期到 2026-10-06 | M2 接热路径后 reliability 才 <1.0 生效 | M2 cron 提醒（已建 fa098cb41ec6） |

## C · 不可闭环的"硬事实"（记录以免遗忘）

- **四家官方都不公布精确固定 token 配额**（2026-09-22 回源结论，见 §3.9.1）。这是产品差异化机会——
  我们的"配额预检 + 优雅降级"价值恰在"把各家模糊口径统一成 estimate + 用户校准"，而非拿到官方精确数。
- 任何把"消息数/倍率"当"精确 token"写入注释的做法 = 违反准确性铁律，禁止。
