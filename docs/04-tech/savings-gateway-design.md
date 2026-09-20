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

## 四、形态三选（待老板拍板，明早定）

| 方案 | 描述 | 优点 | 风险 |
|---|---|---|---|
| **A 复用 codex-proxy** | 在 `codex-proxy/proxy.js` 加 OpenAI 兼容路由层 + 接 route-engine | 复用已有代理、端口 18790 | **codex-proxy/proxy.js 是热路径**（铁律非授权不动）→ 需老板授权 |
| **B 新起 thin gateway 模块** | 新模块 `l2/savings-gateway/`，复用 route-engine/cost.js，独立端口 | 不碰热路径、隔离、可单测 | 多一个进程/端口 |
| **C 在 manager 加路由** | `multi-proxy-manager` 加 `/v1/chat/completions` 路由 | 复用 manager 安全/JWT | manager 变胖、职责混 |

> 推荐 **B**（不碰热路径、隔离、符合"门控默认关/shadow 默认开"非侵入铁律），**A 因热路径需单独授权**。

---

## 五、明早待老板拍板的 5 个决策点（攒齐，统一回应）

| # | 决策点 | 选项 | 倾向（待老板定） |
|---|---|---|---|
| 1 | **形态** | A 复用 codex-proxy / B 新起 thin gateway / C 在 manager | **B**（不碰热路径） |
| 2 | **端口** | 18795 / 18796 / 18770（均空闲，避开 18790-18794） | **18795**（顺延 18794 后） |
| 3 | **dummy token 机制** | DSH 用 dummy OpenAI key 指向网关；网关校验 dummy→映射到真 provider key（从 manager `.env`/注入） | 待定（dummy key 怎么发/校验/映射） |
| 4 | **省钱口径** | shadow 阶段算"模拟 delta" vs 切换后算"真省"；是否出"省钱排行榜"+接 `alert.js` cost 信号 | 待定 |
| 5 | **成本是否进 route** | 仅按难度档位选（不依赖价格）vs 把价格信号接进 route 排序（需动 route-engine，扩 §五缺口） | 倾向先"按档位"，价格信号留二期 |

> 全部是**文档/形态决策，非热路径代码**。老板拍板后我才按 B 形态 + 18795 端口开工写 `l2/savings-gateway/`。

---

## 六、开工边界（拍板后）

- 新模块 `l2/savings-gateway/`，门控默认关 / shadow 默认开（非侵入铁律④）。
- 热路径 `forward.js` / `codex-proxy/proxy.js` **0 触碰**（除非老板授权走方案 A）。
- 每步 E2E 真跑（demo 实测），不抄数字。
- 复用 `route-engine` / `cost.js` / 3 个 seed profile，不新造路由/成本内核。

_落盘：2026-09-21 · 作者：贾维斯（Hermes Agent）· 设计草案，未写码 · grounded 到已读代码行 · 缺口诚实标注_
