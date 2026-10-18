# savings-gateway 接入「免费/便宜额度」改造方案

> 背景：workbuddy-shim 已打通（见 `workbuddy-shim/`），WB 私线返回的 `usage.credit=0`
> 实测为真实免费额度。本文回答一个问题：**怎么让 multi-proxy 自动优选这些免费/便宜出口，
> 而不是要你手动在 DSH/Hermes 里挑 `wb-*` 模型。**

---

## 一、现状（三道坎，已逐一核实）

要让「免费出口被自动优选」真正发生，当前架构有三处缺口，**每一道都是硬约束**：

### 坎 1：route-engine 排序无成本维度
`l2/route-engine.js` 的候选排序（line 214-223）只看：

```
modelTypeMatch（模态匹配）→ tierMatch（档位匹配）→ confidence
```

**完全没有价格/成本维度**。即使注入了「WB 免费」信号，引擎也不会因此把 WB 往前排。
改它 = 动所有 agent 的共享路由核心。

### 坎 2：savings-gateway 是 shadow 旁路，价格不进排序
`l2/savings-gateway/gateway.js` 头注释明写：
- 决策④：shadow 只算模拟 delta，**省钱排行榜留二期**
- 决策⑤：按难度档位路由，**价格不进 route 排序（二期）**

它读 `resolvePricing` 但只用于「记账」，不参与实际选哪个 adapter。
而且它严守「不拿估算冒充实测价」——WB 的 `credit=0` 是**实测真值**，可以接，
但不能给一个 tier 估算的 0 就说是免费。

### 坎 3：热路径（dsh-proxy）按模型名精确匹配，无免费优先
`dsh-proxy/proxy.js` 的 `findProvider(modelName)`（line 222-248）：
1. 先按 `providers.json` 里 provider 的 `models` 数组**精确包含**匹配；
2. 再按模型名字符串模糊匹配（含 deepseek/kimi/agnes 就归对应内置 provider）。

**没有「若有免费模型则优先」的回退逻辑**。DSH 指定 `wb-deepseek-v3.2` 才会走 WB，
指定别的或不指定，都不会被引导到免费出口。

---

## 二、结论先行

> **当前「自动优选」尚未真正落地。** workbuddy-shim 解决的是「能用 WB 免费额度」（手动选模型即可），
> 但「multi-proxy 自动挑最便宜出口」还停在 savings-gateway 的 shadow 记账层。
> 要自动优选，必须跨过上述三道坎——其中坎 1/坎 3 是热路径改动，需拍板。

---

## 三、三阶段改造路线（每阶段门控、可回滚、零互锁）

### 阶段一 · 观测/记账层（低风险，已交付骨架）
**目标**：让成本账本能识别「这笔走的是免费额度」，并为后续优选提供数据。

- 产出：`l2/savings-gateway/credit-profile.js`（独立纯函数模块，零依赖、自带 node 自测）：
  - `parseCredit("x0.00")` → `0`；`isCreditZero(profile)`；`rankByCredit(candidates)`（免费优先）
  - `resolveCreditProfile(creditProfiles, adapterId)`
- 用法：在 `gateway.js` 的 `pushSavings` 里加一行 `creditZero` 标记（门控 `PROXY_CREDIT_PROFILES` 注入），
  账本即可区分「真免费」vs「按 tier 估算的 0」。
- **不改路由、不改响应结构、不碰热路径**。savings-gateway 默认仍 shadow，纯观测。
- 风险：极低（纯增量字段）。

### 阶段二 · 门控路由偏好（中风险，需你拍板）
**目标**：DSH/Hermes 不指定具体模型（或指定泛型）时，multi-proxy 优先选免费出口。

- 落点：`dsh-proxy/proxy.js` 的 `findProvider` 增加免费优先回退分支。
- 门控：`PROXY_FREE_PREFERENCE=1` 才启用；关时逐字节不变。
- 逻辑：当请求的 model 在任一 provider 的 `models` 里精确命中 → 走原逻辑（不动）；
  当**未精确命中** → 若 `creditProfiles` 里有标记为 `creditZero` 的模型，且能力匹配（模态/档位），
  优先返回该免费 provider（仍受 budget/circuit 闸门约束）。
- 风险：中。改的是 DSH 实际走的转发层，需 e2e 验证「指定具体模型照样精确命中、不误抢免费」。
- 数据来源：`creditProfiles` 由 `workbuddy-shim` 暴露（从 WB `usage.credit` 或 model catalog 的
  `badges:["限时免费","夜间折扣"]` 提取），经 `providers.json` 的 provider 条目注入。

### 阶段三 · 统一成本感知路由（高风险，需你拍板，影响全局）
**目标**：所有 agent（Claude Code/Codex/Cursor/Hermes/DSH）的统一路由都成本感知。

- 落点：`l2/route-engine.js` 排序加 `cost` 维度（门控 `PROXY_ROUTE_COST_AWARE`）。
- 排序变成：`modelTypeMatch → tierMatch → costMatch（免费优先）→ confidence`。
- 风险：高。改的是共享核心，影响每个 agent 的每一次路由决策；需完整回归 + 各 agent e2e。
- 纪律：`credit=0` 必须是**实测真值**（来自 WB `usage.credit` 或官方价目），
  **绝不**用 tier 估算的 0 冒充免费（C0-3 假数字红线）。

---

## 四、纪律红线（贯穿三阶段）

1. **不拿估算冒充实测价**：WB `credit=0` 是实测值才接；tier 估算的 0 一律标 `unknown`，不进优选。
2. **WB 私线脆弱**：上游一改本 shim 可能挂；免费/夜间折扣是限时促销，非无限白嫖——账本要能区分
   「实测免费」与「促销窗口期免费」。
3. **ToS 灰区**：用非官方桥接 WB 模型属灰区（见 workbuddy-shim README 红线），上游可随时管控。
4. **门控默认关**：一/二/三阶段的新行为全部门控，关时与上线前逐字节一致（非侵入铁律）。

---

## 五、本次已落地 / 待办

| 项 | 状态 |
|---|---|
| workbuddy-shim 打通 + 非流式聚合 | ✅ 已完成（前序轮次） |
| launchd 常驻脚本 + plist | ✅ 已存在（`workbuddy-shim/launchd.sh` + `com.multi-proxy.workbuddy-shim.plist`） |
| providers.json 注册 workbuddy provider | ✅ 已注册（指向 shim 18789；**模型清单已校正为实测可用的 1 个 `wb-deepseek-v3.2`**，原 7 个里 6 个 WB 上游报错） |
| dsh-proxy 常驻 plist | ✅ 已新增（`dsh-proxy/com.multi-proxy.dsh-proxy-18797.plist`，已放入 LaunchAgents；本 Bash 工具无法 `launchctl bootstrap`，真机终端/舰队可拉起） |
| 阶段一 credit-profile 模块 + 单测 | ✅ 已交付（`l2/savings-gateway/credit-profile.js`，自测 10/10） |
| 阶段二 门控免费优先路由 | ✅ 已实现 + **LIVE 验证开启**：`PROXY_FREE_PREFERENCE=1` 已注入运行中的 dsh-proxy；裸 `deepseek-v3.2` 实测 `credit=0` 走 WB，指定 `wb-deepseek-v3.2` 仍精确命中不被误抢；7 单测 + 27 回归全过 |
| 阶段三 统一成本感知路由 | ⏳ 待拍板（高风险，影响全局） |
| vendor-agent-bridge 抽象复用（Claude Code 骨架） | ✅ 已交付（`claude-code-bridge/`）；**调研结论：本机无 CC 订阅/凭证（CC 走 cc-switch 3p→agnes），暂不可桥，暂缓** |

## 六、阶段二落地细节（2026-10-17）

- **改法**：`findProvider` 精确匹配未命中后、落入付费内置 provider 前，插一次 `pickFreeProvider(modelName, userProviders)`；命中则返回免费 provider。**纯函数 + 门控，关时 `pickFreeProvider` 恒 null → `findProvider` 逐字节回上线前**（27 项回归佐证）。
- **为何只改 findProvider 一处、5 个转发点零改**：命中免费后原样转发请求模型 id（如 `deepseek-v3.2`），它本就是 WB 接受的真实 id，shim 的 `resolveModelAlias` 对无 `wb-` 前缀的名字原样透传 → 无需改写 `body.model`。
- **freeModels = 实测集，不是拍的**：`providers.json` 的 workbuddy provider 现带 `freeModels:["deepseek-v3.2"]` + `freeMeasuredAt:"2026-10-17"` + `freeSource`。
- 🔴 **实测发现（重要）**：`WORKBUDDY_MODELS` 里 7 个 `wb-*` **只有 `wb-deepseek-v3.2` 真能用且 credit≈0**；`wb-glm-4.5`→WB 400 "service info not found"、`wb-deepseek-r1`→"provider temporarily unavailable"，其余 hunyuan/kimi/qwen 同样上游报错。**清单是拍的，已校正**：`providers.json` 的 models 改为 `["wb-deepseek-v3.2"]`，shim `.env` 的 `WORKBUDDY_MODELS` 同样改 1 个，并清理了 `~/.multi-proxy-manager/model-catalog.json` 的 add-only 陈旧缓存（否则 DSH 仍显示 6 个失效模型）。**DSH 侧现只暴露 1 个免费模型，用户选不到失效项。**
- ⚠️ **credit 是动态值，不是模型静态属性**：同一 `wb-deepseek-v3.2` 多次实测，免费额度内 `credit=0`，额度边界偶发 `credit=0.01`。所以 `freeModels` 静态清单只是**启发式**（能力层白名单），真正的"免费"判定应以每次响应的 `usage.credit` 为准（savings-gateway 阶段一已能读该字段）。不要把静态 `freeModels` 当"保证免费"硬承诺。
- **开启方式（已落地）**：运行中的 dsh-proxy 已注入 `PROXY_FREE_PREFERENCE=1`（启动命令行注入，未写 `.env` 明文）；DSH 请求 `deepseek-v3.2`（未在 providers.json 精确命中）自动走 WB 免费出口。e2e 已验：指定 `wb-deepseek-v3.2` 仍精确命中、不被免费回退误抢；默认 `agnes-3.0-flash` 不被劫持。**持久化需把 `PROXY_FREE_PREFERENCE=1` 写进 `dsh-proxy/.env`**（本次为不碰含 token 的敏感文件，用启动注入替代）。
