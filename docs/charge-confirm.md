# 收费确认闸门（Charge-Confirm Gate）

把 MoneyPrinterTurbo `SKILL.md` 的「`*_CHARGE_CONFIRMATION_REQUIRED` 协议」落成 savings-gateway 的**执行层强制确认**：agent 绝不能静默加确认旗标，只有用户显式批准（请求带 `X-Charge-Confirm`）才放行付费路由。

## 与 savings-gateway 的关系

| 层 | 职责 | 文件 |
|---|---|---|
| 统计层 | 记账「省了多少」（`x_savings.saved`） | `gateway.js` |
| 执行层（本闸门） | 未确认就真打付费上游前直接 402 挡下 | `charge-confirm.js` |

两层互补：统计层让你**看到**省了多少，执行层让你**不敢**在没确认的情况下真花钱。

## 判定逻辑（`charge-confirm.js`）

`evaluate({ adapterId, estimatedCost, confirmed, shadow })` → `{ required, confirmed, reason }`：

| 条件 | 结果 | reason |
|---|---|---|
| `shadow`（模拟，不真花钱） | `required=false`，放行 | `shadow-sim-no-charge` |
| 免费路由（`agnes` / 名单外且价=0） | `required=false`，放行 | `free-route` |
| 付费 + `shadow=false` + **未确认** | `required=true` → 网关抛 **402** | `charge-confirmation-required` |
| 付费 + **已确认** | 放行 | `approved` |

- 默认付费名单：`deepseek` / `qwen`（模拟基线价 >0）；`agnes`（small 免费）永远不进名单。
- 保守语义：`estimatedCost=null`（单价 unknown）时，只要 `adapterId` 在付费名单里**仍拦**（operator 对未知价不冒充实测免费）。

## 启用

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `PROXY_SAVINGS_CHARGE_CONFIRM` | 关 | 设 `1/true/on` 才构造闸门并注入 gateway（关 = 不注入 = 零行为变更） |
| `PROXY_SAVINGS_PAID_ADAPTERS` | `[deepseek,qwen]` | 逗号分隔，覆盖默认付费名单 |
| `X-Charge-Confirm`（请求头） | 不带 | 客户端显式带 `1/true/on` 才放行付费路由 |

**关键**：`shadow=true`（模拟）时本闸门**永远放行**——模拟不真花钱，不需要确认（与 MPT「模拟=免费」一致）。要拦截的是 `shadow=false`（真实执行）下的付费路由。

## 402 回包结构

```json
{
  "error": {
    "message": "paid route requires explicit charge confirmation; add X-Charge-Confirm: true header only after user approval",
    "type": "charge_confirmation_required",
    "code": "charge_confirmation_required"
  },
  "chargeConfirm": {
    "required": true,
    "confirmed": false,
    "adapterId": "qwen",
    "estimatedCost": 0.096,
    "reason": "charge-confirmation-required"
  }
}
```

`chargeConfirm` 字段让调用方**知道缺哪个确认**（付费路由 = 哪个 adapter、预估成本多少），不需要反向猜。

## 拦截时点（非侵入铁律）

- 拦截发生在**记账 / 执行前**——未确认的请求**不产生省账、也打不到上游**。
- 默认关（`PROXY_SAVINGS_CHARGE_CONFIRM` 未设）→ 整段跳过，gateway 零行为变更。

## 测试

```bash
node l2/savings-gateway/charge-confirm.demo.js        # 18 例（判定层）
node l2/savings-gateway/charge-confirm.e2e.test.js    # 7 例（真起假上游 E2E）
node l2/run-demos.js                                  # 全量 53 demo 回归
```

## 设计来源

MoneyPrinterTurbo（`harry0703/MoneyPrinterTurbo`，MIT，130k+ star）`docs/skill/SKILL.md`：
把「agent 该怎么干活」写成**机器可读的 agent 契约**——退出码协议、收费确认旗标、凭据卫生三条硬机制。
本闸门是其中「收费确认」那条落到开源网关执行层的实现。
