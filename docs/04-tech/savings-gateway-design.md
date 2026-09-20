# 省钱网关设计草案 — task1（OpenAI 兼容 + 省钱看板）· 2026-09-21

> 来源：`deepseek-strategy-review-2026-09-21.md §四.1` 最高杠杆项。
> 定位：**今晚只出设计 + 列决策点，不盲写码**。形态/端口/dummy token 等需老板拍板，攒到明早。
> 核心论点：把已有的 route-engine(难度路由) + cost.js(成本账) 暴露成一个 **OpenAI 兼容网关**，
> 让 DSH/Codex 等 agent 用 dummy key 指过来就能"难活贵模型、易活便宜模型"省钱——**抢占 DSH 生态、不卡 0.2**。
> 竞品参照：`agentgateway`（OpenAI 兼容 + Route/Log/Cost 一页, :4002）；`dsh-cost-meter`（峰谷计价/余额）。
> 本草案 grounded 到已读代码行；未实现的部分如实标 [缺口]。

---

## 一、它是什么（一句话）

一个 **OpenAI 兼容 endpoint**（`/v1/chat/completions` 等）：agent 把 base_url 指到它、用 dummy key，
网关按 **route-engine 的难度路由 + cost.js 的成本账** 把请求打到**最便宜够强**的 provider；
并产出一张 **省钱看板**：每次请求"本可派大模型花 ¥X，实际派小/中模型，省了 ¥Y"。

为什么现在能开（不卡 DSH 0.2）：DSH 生态天然吃 "任何 OpenAI 兼容 endpoint"（README 原话）。
这是 **agentgateway 形态**，与"发 DSH plugin 包"（DS2/DS3 卡在 0.2/#1496）是两回事。

---

## 二、能复用的现成内核（grounded，不新造）

| 能力 | 现成模块 | 证据 |
|---|---|---|
| 难度路由（复杂度→档位→选最便宜够强） | `l2/route-engine.js` | `_mapTier` low→small/medium/high→large（`:156-160`）；3 信号打分 + 三级排序（`:103-111,168-174`）；shadow 默认 |
| 档位→provider 成本梯度 | `l2/mcp-default-seed.js` 3 个 seed | `agnes`(small,免费) / `deepseek`(medium) / `qwen`(large)（§13.18；jest 14/14） |
| 成本账（单价/累计） | `l2/cost.js` + `cost-track.js` | 已喂 `alert.js` 的 `cost-budget-exceeded`（`server.js:119-124`）；`PROXY_PRICING_<proxy>` 注入单价 |
| 安全头/JWT | `multi-proxy-manager` | CSP 三件套 + JWT + bcrypt（`security-whitepaper.md`） |

> 缺口：成本信号**未进 route 排序**（`route-engine-spec.md §五`）——省钱看板若要"按价格选"，需接；
> 仅按难度档位选则不依赖价格。这是下面决策点⑤。

---

## 三、省钱看板怎么算（核心，仿 dsh-cost-meter 但 grounded 到自己 cost.js）

每请求一条 shadow log 记录（已有 ring，`route-engine.js:37-46`），扩展算 delta：

```
原计划成本 = 单价(该档位默认 large=qwen) × 本次 tokens
实际成本   = 单价(实际选中档位) × 本次 tokens
本次省钱   = 原计划成本 − 实际成本   （shadow 不真花，是"若照大模型打会花多少 vs 实际路由省多少"）
累计省钱   = Σ 本次省钱（按日/按 provider 聚合，对标 dsh-cost-meter 贡献图）
```

- **真花钱**只在 shadow→真实路由切换后（`setShadowMode(false)`）；shadow 阶段是"模拟省钱账"。
- 数据落点：复用 `cost.js` 的 state（`PROXY_PRICING_*` 注入），不新造存储。
- [缺口] 现有 shadow log 只记路由建议、**不算钱**（`route-engine-spec.md §五`）——需新增一行 delta 计算。

---

## 四、形态三选（✅ 已拍板 2026-09-21 老板授权"赞同你的判断，执行"）

| 方案 | 描述 | 优点 | 风险 |
|---|---|---|---|
| A 复用 codex-proxy | 在 `codex-proxy/proxy.js` 加 OpenAI 兼容路由层 + 接 route-engine | 复用已有代理、端口 18790 | **codex-proxy/proxy.js 是热路径**（铁律非授权不动）→ 需老板授权 |
| **B 新起 thin gateway 模块 ✅** | 新模块 `l2/savings-gateway/`，复用 route-engine/cost.js，独立端口 | 不碰热路径、隔离、可单测 | 多一个进程/端口 |
| C 在 manager 加路由 | `multi-proxy-manager` 加 `/v1/chat/completions` 路由 | 复用 manager 安全/JWT | manager 变胖、职责混 |

> **✅ 定 B**（老板 2026-09-21 授权）：不碰热路径、隔离、可单测、符合"门控默认关/shadow 默认开"非侵入铁律。A 因热路径维持不授权、C manager 变胖否决。

---

## 五、5 个决策点（✅ 已拍板 2026-09-21 老板授权"赞同你的判断，执行"）

| # | 决策点 | 选项 | 拍板结论 |
|---|---|---|---|
| 1 | **形态** | A 复用 codex-proxy / B 新起 thin gateway / C 在 manager | **✅ B**（不碰热路径，`l2/savings-gateway/`） |
| 2 | **端口** | 18795 / 18796 / 18770（均空闲，避开 18790-18794） | **✅ 18795**（顺延 18794 后） |
| 3 | **dummy token 机制** | "dummy key 怎么发/校验/映射" | **✅ 贾维斯默认（可回改）**：dummy key 形 `sk-dsh-savings-*`（网关签发/校验），命中即映射到 manager `.env`/注入的真 provider key（非暴露真 key 给 agent）。对标 agentgateway/dsh-proxy 通用做法 |
| 4 | **省钱口径** | shadow 算"模拟 delta" vs 切换后算"真省"；是否出排行 | **✅ 贾维斯默认（可回改）**：一期 shadow 算"模拟 delta"（若照大模型打 vs 实际路由省），接 `alert.js` cost 信号；"省钱排行榜"留二期 |
| 5 | **成本是否进 route** | 仅按难度档位 vs 价格信号进 route 排序 | **✅ 先按难度档位**（不依赖价格），价格信号接 route 留二期 |

> 决策 1/2/5 = 老板确认贾维斯倾向；决策 3/4 = 老板授权贾维斯按倾向定默认、**可回改**。新会话接 `l2/savings-gateway/` 开工即按此五拍。
> 全部是**文档/形态决策，非热路径代码**：新模块隔离、不碰 `forward.js`/`codex-proxy/proxy.js`。

---

## 六、开工边界（拍板后）

- 新模块 `l2/savings-gateway/`，门控默认关 / shadow 默认开（非侵入铁律④）。
- 热路径 `forward.js` / `codex-proxy/proxy.js` **0 触碰**（除非老板授权走方案 A）。
- 每步 E2E 真跑（demo 实测），不抄数字。
- 复用 `route-engine` / `cost.js` / 3 个 seed profile，不新造路由/成本内核。

---

## 七、一期落地验收记录（2026-09-21 · 已开工完成）

> 按 §六 开工边界落地。本段只记**本轮真跑**结果（不抄历史数字）；热路径 `forward.js`/`codex-proxy/proxy.js` **0 触碰**（`git status` 未列）。

**产物**：
- `l2/savings-gateway/gateway.js`（~300 行，零 manager 依赖，工厂范式 `createSavingsGateway()`，与 `alert.js`/`cost.js` 同构）。
- `l2/savings-gateway/server.js`（thin HTTP，node 内置 http，零依赖，绑 `127.0.0.1:18795`，`SAVE_GATEWAY_BIND_HOST` 可覆盖）。
- `l2/savings-gateway/savings-gateway.demo.js`（确定性 demo，全网络隔离）。
- `multi-proxy-manager/tests/unit/savings-gateway.test.js`（内核 + live HTTP，18 例）。

**决策③落地说明（诚实标注）**：内核 dummy key 前缀定为 `gw_`（gateway 前缀），默认签发 `gw_default-large` → 映射「large 档位意图」；决策③写的是脱敏占位 `sk-…`，**实际落地前缀 = `gw_`**（语义更清晰、区分「网关签发的省钱 key」与 provider 真 key，仍满足「不暴露真 key」核心约束）。**可回改**（`opts.dummyKeys` 可注入任意 key 表）。

**五决策对照**：
| 决策 | 落地 | 实证 |
|---|---|---|
| ① 形态 B | 新起 `l2/savings-gateway/`，热路径 0 触碰 | `git status` 无 `forward.js`/`codex-proxy/proxy.js` |
| ② 端口 18795 | `server.js` `DEFAULT_PORT=18795` + live 冒烟真起 | `/usr/sbin/lsof` 起停后 `PORT-18795-CLEAN` |
| ③ dummy key `gw_` | `resolveKey` 校验前缀 + 签发表，内核不持真 key | demo 401×2（invalid/unknown key）+ jest 401 |
| ④ shadow 模拟 delta + alert.js | `x_savings.planned/actual/saved` + `produceCostSignal` 喂 `cost-budget-exceeded` | demo 端到端触发/不触发/无预算不告警 + jest live `/savings/signal` |
| ⑤ 先按难度档位 | 复用 `route-engine` complexity→tier（low→small/medium→medium/high→large） | demo 3 档路由落点 + jest 断言 |

**真跑数字（本轮，非引用）**：
- demo `node l2/savings-gateway/savings-gateway.demo.js` → **24/24 PASS**（鉴权 401×2 / 难度路由 3 档 / 模拟 delta 记账 / token 启发式估算 `estimated` / 省钱报告分档 / cost 信号端到端喂 alert.js / 非侵入断言）。
- jest `tests/unit/savings-gateway.test.js` → **18/18**（内核 12 + live HTTP 6：门控关 403 / 门控开 200 难度路由 + 401 + 400 / 看板/signal 只读 / 404）。
- 全量 `multi-proxy-manager` jest → **719/719（45 suites / 0 fail）**，相对 701 基线 **+18 零回归**。
- live 冒烟：真起 `127.0.0.1:18795` —— 门控关 `health 200` + `POST 403 gate-closed`；门控开 `POST 200 low→agnes saved=0.096 shadow=true` + bad key `401 invalid_api_key` + `/savings/report`·`/savings/signal` `200`。

**二期/后续增量（YAGNI，未接）**：真执行（`setShadowMode(false)` + 注入 executor 真打上游、拿真 key）/ 价格信号进 route 排序 / 省钱排行榜·落盘 / A 路 token×单价 埋点接 `forward.js` 热路径。门控 `PROXY_SAVINGS_GATEWAY` 开 + `PROXY_SAVINGS_SHADOW=0` + 注入 `executor` 即二期切换缝，内核一期不动。

_落盘：2026-09-21 · 作者：贾维斯（Hermes Agent）· 设计稿 · 五决策已拍板 2026-09-21（老板"赞同判断执行"）· 一期已落地（gateway.js + server.js + demo 24/24 + jest 18 + 719/719 零回归 + live 18795 冒烟）· grounded 到已读代码行 · 缺口/二期诚实标注_
