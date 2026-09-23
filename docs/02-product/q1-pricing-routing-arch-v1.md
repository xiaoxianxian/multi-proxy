# Q1+Q2 · 计费模块 + 路由模块架构设计 v1（评审稿，非实现）

> 日期 2026-09-22 · 状态：**设计评审中，不开发**（老板 2026-09-22 明确"先设计架构…开发完后再跑代码"）
> 负责人：贾维斯 · 评审：老板
> 关联：`docs/02-product/m6-action-checklist.md`（现状 D1-D8 已落）· `AGENTS.md`（非侵入铁律）· `MEMORY.md §13.1/§13.10/§13.24`

---

## 0 · 老板 5 点 → 设计落点（先对齐再展开）

| # | 老板原意 | 一句话设计结论 | 是否定死 |
|---|---|---|---|
| Q1 | 价格会变，OpenRouter 会波动，系统别替我做价格决策 | **漂移 = 哨兵，绝不自动覆盖**；用户主权 > 官价 | ✅ 已拍定 |
| Q2 | 价格常变，要机制及时更新 | **显式刷新 + TTL 缓存 + 漂移阈值告警**（默认 observe 只提醒） | 设计中，待 3 点拍 |
| Q3 | 默认全员可比价（能剔除）+ 路由关设 default custom + 路由开设最终兜底 + 无兜底报错 | **三级兜底 + 全员默认 + 显式剔除** | 设计中，待 4 点拍 |
| Q4 | 原币保留 + 换算 CNY 参与路由(老板纠错:USD 需能路由,如 gpt6) | **汇率参与路由 + 原币保留 + 前端并列(§3.5)** | **老板纠错,已改** |
| Q5 | 想想还有什么 | 见 §6（8 点定论 + 5 点新开放项） | 待老板定 |

---

## 1 · 现状（从代码实核，非凭印象）

| 模块 | 现状 | 关键约束 |
|---|---|---|
| `routeEngine.ts:198-226` | 价表 4 家（qwen/agnes 免费、deepseek `1/4/0.02`、kimi `0.6/2.5/0.1` 占位） | **deepseek 非官方**（OpenRouter 0.5/3），kimi **占位未校准** |
| `ruleEvaluator.ts` | `Pricing { input, output, cacheHit }`；`estimateCost` 纯函数；`rankByCost` 健康优先+花费升序 | 门控逐字节向后兼容 |
| `chatHandler.ts:370-437` | `findProviderConfig` 按 model 名查 → 引擎建议==原 model 时跳过 override → B1 塌缩 | 路由热路径**不发网络**（非侵入铁律） |
| `provider-health.js` | observe 态，绝不 `flip enabled` | M2 执行层门控默认关 |
| 路由开关 | `PROXY_ROUTE_OVERRIDE`（默认关）+ shadow 观测 | 翻 1 属老板决策 |

**现状痛点（这轮要解的）：**
1. 价格单一键 `(model)`，无渠道维度 → 同模型多渠道同价（不合理）
2. 无更新机制 → 价格变静默，路由顺序悄悄漂
3. 路由关无 default custom；路由开无最终兜底
4. 币种混（¥/$）无字段，比价混算

---

## 2 · 目标 + 约束

### 2.1 目标
- 价格三层：官方价（多源）+ 渠道价 + 用户覆盖
- 价格会漂 → 系统当哨兵，**不替用户决定**
- 订阅 / API 两维度分开算
- 路由：全员默认可比价 + 可剔除 + 三级兜底 + 无兜底报错

### 2.2 铁律约束（不可破）
- **非侵入**：热路径（proxy 入口/路由决策）**零网络**；价格刷新是独立脚本，非请求内拉取
- **绝不 flip enabled**（`provider-health.js` 观察态不动）
- **绝不改全局 env / plist**（ADR-0001/0003）
- **门控默认关**：所有新能力 observe-only，翻属老板决策
- **向后兼容**：门控关时逐字节等同现状
- **不写 DB**（价格走文件层，DB 只存 provider/model 元数据）
- **价格主权归老板**：系统不替老板做价格决策

---

## 3 · 计费模块设计（Q1/Q2）

### 3.1 价表三层结构（优先级 L1 > L2 > L0）

```
Pricing 条目结构：
{
  input, output, cacheHit,           // 单价（每百万 tokens）
  currency: 'CNY' | 'USD' | ...      // 原生币种（Q4：不换算）
  billingMode: 'token' | 'subscription',
  monthlyCny?, monthlyQuotaTokens?,  // 订阅维度
  source?: string,                   // 'official-openai' | 'openrouter' | 'user' | ...
  channel?: 'official' | 'openrouter' | ...,  // 渠道（Q1：同模型多渠道）
  _userSet?: boolean,                // 用户手动标记（Q1：漂移是否覆盖的分水岭）
  updatedAt?: string
}
```

| 层 | 位置 | 内容 | 写入方 |
|---|---|---|---|
| L0 官方种子 | 代码内嵌 `pricing.ts` | 全 8 家官方价（带 source/currency/billingMode） | 我们（开发期） |
| L1 用户覆盖 | 文件 `pricing-overrides.json` | 用户手动价 + `_userSet:true` | **用户**（最高优先） |
| L2 渠道价 | 文件 `pricing-cache.json`（TTL 缓存） | 多渠道抓取结果（official / openrouter / ...） | `refresh-pricing.cjs` 脚本 |

**优先级解析 `resolvePricing(model, channel)`:**
- L1 覆盖存在 → 用 L1（`_userSet:true`，用户主权）
- L1 无 → L2 有匹配 (model,channel) → 用 L2 渠道价
- L2 无 → L0 官方种子
- 都没有 → `0`（免费，绝不编造；`estimateCost` 返 0 不参与"最贵"排末）

### 3.2 漂移处理：只提醒、绝不自动覆盖（老板 Q1 拍定）

**信任边界铁律：价格更新是哨兵，不是执行器。** 渠道会漂移、OpenRouter 会波动——
系统**绝不自动用新官价覆盖用户当前在用的价**，只当哨兵通知。

- **用户手动覆盖的价（`_userSet:true`）：永远不动，即使官价变。** 用户价格主权 > 一切。
- **跟随官价的价（`_userSet:false`）：** 刷新后新价与现价偏差 > 阈值（默认 `10%`，`PROXY_PRICE_DRIFT_PCT` 可配）
   → **写告警 + 通知，但不覆盖**。用户自己决定要不要跟新价、要不要切渠道。
- **为什么"不自动覆盖"对：** 价格变可能改路由顺序。系统自动灌官价进路由 → 一次波动静默改路由 → 不可预测。
  老板要"知道了，我自己决定"，不是"系统替我决定"。
- **告警载荷：** `{model, channel, old, new, source, updatedAt, orderChanged: [旧排序 vs 新排序 diff]}`
  —— `orderChanged` 是关键：一眼看出"这次价差是否让某模型从第 3 名跳到第 1 名"。
- **刷新仍只产数据、不动路由：** L2 刷新写 L1 的 `official`（带 source/updatedAt）；路由读 L3（用户覆盖或当前生效价）；
  刷新不改 L3，除非用户显式操作。
- **告警去重：** 同模型同偏差方向 24h 内只告一次（避免 OpenRouter 波动刷屏）。

### 3.3 更新机制（Q2）

| 触发 | 行为 | 门控 |
|---|---|---|
| 手动 `node scripts/refresh-pricing.cjs` | 拉多渠道官方价 → 写 `pricing-cache.json`（TTL） | 默认 |
| `manage start_cursor` 前（可选） | 缓存过期（>TTL）则刷新 | `PROXY_PRICE_AUTOREFRESH`（默认关） |
| 定时（cron/launchd，可选） | 同手动 | 默认关 |

- **TTL 默认 24h**；刷新缓存到 `pricing-cache.json`（带 updatedAt + source）。
- **刷新产数据，不触路由**（热路径零网络依赖，非侵入铁律）。
- **刷新即漂移探测**：拉新价 vs 现生效价 → 偏差 > 阈值 → 写告警（只提醒不覆盖，§3.2）。
- **刷新失败不阻塞启动**（网络挂 → 用旧缓存/种子，不阻塞，写 warning）。

### 3.4 订阅 vs API 双维度（分开算）

| 维度 | 触发 | 边际成本计算 |
|---|---|---|
| API 按 token（默认） | `billingMode:'token'` | `input×inTks/1M + output×outTks/1M + cacheHit 折扣`（现状） |
| 订阅 coding plan | `billingMode:'subscription'` 且门控开 | `monthlyCny / monthlyQuotaTokens × (in+out)`（接近 0） |

- 门控 `PROXY_BILLING_MODE`（默认关）：关时全走 token 计价，逐字节=现状。
- 订阅分母缺失/非正 → 退化 token 计价（绝不产假成本 / NaN / 负）。
- 配额重置：各家口径不同（weekly / 5h / monthly）；`monthlyQuotaTokens` 字段诚实标 estimate + 用户可改
  （各家官方多无原生 token 数，§3.5）。

### 3.5 currency（Q4 更新 · 老板 2026-09-22 纠错：汇率参与路由）

**老板纠错（重要）：** "USD 不参予路由"是错的——用户有 gpt6 额度（外币），做复杂任务
（如大游戏）可能只有 gpt 能做，必须允许 gpt 被路由命中。

**新设计（原始币种保留 + 换算 CNY 参与路由）：**
- **保留原始币种：** `Pricing.currency: 'CNY' | 'USD' | ...`，价按厂商原始币种存
   （gpt=USD, kimi/glm=¥CNY）。**绝不丢失原始币种**（老板：充值按厂商币种，不能强换让用户懵）。
- **换算 CNY 参与路由决策：** `estimateCost` 路由比价时，先按汇率把各模型价**统一到 CNY** 再比较。
    ```
    costCNY = estimateCost(...) × fxRate[currency→CNY]
    ```
   汇率 CNY=1。汇率缓存在 `pricing-cache.json`（TTL 7d），与价格缓存同生命周期。
- **汇率源（开放设计，老板定）：** 默认不拉网络（非侵入），用 `PROXY_FX_RATE`（env 手填默认 7.2）
    或 `pricing-cache.json.fx`。可选拉汇率 API（候选，老板定源）。
- **汇率缺失/为 0/非正：** 退化 `fx=1.0`（不混算、不产假），标 `fxSource:'fallback'`。
- **前端换算显示（老板 Q5：UX 需交互设计师把关）：** 路由/计费结果展示时，**原始币种 + 换算 CNY 并列**
   （如 `$15/M ≈ ¥108/M`），不只显示换算值——老板要"原始币种不被混淆"。
   **本设计稿不实现前端 UI，仅定数据契约；UI 样式交交互设计师子 agent 把关（老板 Q5 明确）。**

### 3.5.1 汇率源选项（开放问题，等老板定）
| 方案 | 来源 | 优劣 |
|---|---|---|
| A · env 手填 | `PROXY_FX_RATE=7.2` | 零网络、可控，但需手动更新 |
| B · 拉汇率 API | 如 exchangerate/huangjin 等 | 自动但需网络+API key，违反非侵入若接热路径 |
| C · 缓存 + 手动刷新 | 价格缓存带 fx，`refresh-pricing.cjs` 一并刷新 | 折中，推荐 |
| **建议默认 C**（与价格刷新共用机制，热路径零网络） |

> **汇率精度不影响路由安全**：汇率小波动（7.1-7.3）不改变模型相对优劣序；汇率异常（拉不到→fx=1）
> 时 gpt 类 USD 模型价会显得"极贵"（被降权），老板定默认 fx 兜底值避免误判。

### 3.6 monthlyQuotaTokens 诚实处理

各家 coding plan 配额多为"每周 / 每 5h 上限"，非原生 token 数，精确值无公开。诚实做法：
- 字段加进 `Pricing`；kimi 订阅给 **estimate 50M/月**，注释标`estimate·非官方·请用户按真实用量调整`。
- 缺配额 → 退化 token 模式（不产假）。
- 绝不把 estimate 当官方值写进注释。

### 3.7 全 8 家官方价（回源，2026-09）

| 模型 | input | output | cacheHit | 币种 | billingMode | 订阅 | 源/日期 | 路由角色 |
|---|---|---|---|---|---|---|---|---|
| qwen3.8:27b-mlx | 0 | 0 | 0 | (本地免费) | token | — | ollama | 路由内·最省 |
| agnes-2.5-flash | 0 | 0 | 0 | CNY | token | — | agnes-ai(免费) | 路由内·最省 |
| deepseek-v4-pro | **0.5** | **3** | 0.02 | CNY | token | — | OpenRouter/官方 2025-11 | 路由内·主（**改！现 1/4/0.02**） |
| kimi-k2.6 | 6.5 | 27 | 1.3 | CNY | token | — | kimi-k2 2026-09 | 路由内·天花板 |
| kimi-k2.7-code | 6.5 | 27 | 1.3 | CNY | **sub** | 199（Allegretto） | kimi-coding-api | 参考·订阅示例 |
| kimi-k2.7-code-hs | 13 | 54 | 2.6 | CNY | **sub** | 199 | 同源 | 参考·高速 |
| glm-4.6 | 1 | 3 | — | CNY | token | — | Z.ai 2026-09 | 参考 |
| glm-coding-plan | — | — | — | CNY | **sub** | 118起（Lite） | bigmodel | 参考·订阅 |
| codex/gpt-5.4 | 2.5 | 15 | — | **USD** | token | — | OpenAI 2026-09 | 参考 |
| codex-plan | — | — | — | USD | **sub** | 20/月（Plus） | OpenAI | 参考·订阅 |
| claude-opus-4.8 | 5 | 25 | — | USD | token | — | Anthropic 2026-05 | 参考 |
| claude-plan | — | — | — | USD | **sub** | 20/月（Pro） | Anthropic | 参考·订阅 |
| gemini-2.5-pro | 1.25 | 10 | 0.125 | USD | token | — | Google 2026-03 | 参考 |
| gemini-plan | — | — | — | USD | **sub** | 19.99/月（Pro） | Google | 参考·订阅 |

> **deepseek `1/4/0.02 → 0.5/3/0.02`** 回官方（带源+日期注释）—— 这是本轮要修的真实偏差（影响路由比价）。

### 3.8 配额耗尽优雅降级（项目差异化优势 · 类比 hermes agent 上下文压缩）

**老板 2026-09-22 明确（Q3）：** 先确保当前任务执行完 + 告警；类比 hermes agent 上下文压缩——**执行前快速评估余额是否够用，不够则先提示。** 这是项目**差异化优势**，需严谨设计。

**设计（与 hermes agent 上下文压缩类比）：**
- **执行前预检（pre-flight check，热路径零网络）：** 任务启动前，按当前订阅的 `monthlyQuotaTokens`
   + 本任务预估 token 消耗，估算"剩余配额是否够本任务"。
     - **够** → 直接执行
     - **不够** → **先告警提示**（不静默执行、不假死），用户选择：(a) 继续（明知超额）/
        (b) 降档（切更省模型）/ (c) 暂停
- **执行中监测（quota-watchdog，observe）：** 执行过程中持续监测配额消耗，**接近用尽（默认 80%）**
    时**先保存项目进展 + 汇报用户 + 优雅停**（类比上下文压缩"先 checkpoint 再压缩"），
    **绝不假死**（老板："而不是直接假死"）。
- **诚实边界：** 配额/token 精确值依赖各家 API（部分无公开精确接口），估算可能偏差——
   偏差时**宁可早停**（误判"不够"而停，胜于"假死"）；预检失败（拿不到配额）时**不阻塞**，
   带 warning 执行（不假死）。
- **与 hermes agent 上下文压缩的关系：** 同一设计哲学——"宁可提前处理，绝不中途假死/丢失进展"。
   hermes agent 压缩上下文 = 上下文用尽前 checkpoint；本项目配额降级 = 配额用尽前 checkpoint。
- **门控：** `PROXY_QUOTA_GUARD`（默认 observe 关，仅预警不阻塞）；翻为执行态属老板决策。

> **定位：** 本能力是本项目相对其他厂商的**差异化优势**（老板原话），值得做严谨、做成招牌能力。
> 但配额精确性受限于各家 API，先 observe，数据准了再决定执行态。

### 3.9 共享订阅配额（调研先行 · 待老板定，不拍脑门）

**老板 2026-09-22 明确（Q2）：** "多模型共享一个订阅"——需**先调研供应商怎么定**，不拍脑门。

**调研结论（行业通用 + 部分官方确认，精确值待网络恢复/官方确认）：**
- **OpenAI Codex/ChatGPT：** Plus(≈$20) / Team($25-30) / Pro($200) —— 同订阅下多模型**共享月度额度**。
- **Claude (Anthropic)：** Pro($20) / Max($100) —— 同一订阅**共享 credit 池**，多模型共用。
- **Google Gemini：** AI Pro($19.99) / Ultra($99.99) —— 订阅共享额度。
- **Kimi（Moonshot）：** Coding plan 各档 —— **共享额度**（精确数值待官方确认）。
- **结论：行业主流是【单订阅 = 共享 credit 池】。** 即 kimi Allegretto ¥199/月，
  该订阅下所有 kimi 模型共享同一配额。

#### 3.9.1 官方文档回源实测（2026-09-22 · 老板 ② 要求"专门跑一轮")

> **老板 ② 原话：** 先跑官方文档回源取"精确 quota 各档"，"尽量别搞先上"，除非记待办。
> **回源结果（web_search，2026-09，含官方源）：** 4 家官方**均未公布"精确固定 token 配额各档"**——
> 全部以"消息数(区间)"或"N× 倍率"或"社区实测等效值"表述，无固定 token 天花板。

| 厂商 | 官方口径（回源实测） | 能确证 | 不能确证 | 源 |
|---|---|---|---|---|
| **OpenAI Codex/ChatGPT** | 5h 滚动窗口 + 可能叠加周上限；按模型给**每 5h 本地消息数区间**：GPT-5.6 Sol `10–100`(Plus)、Terra `25–200`、Luna `250–2000`、Astra `5–45`；Pro 5x ≈ Plus×5、Pro 20x ≈ Plus×20；5–8× 跨度 | 相对倍数(5×/20×)、消息区间 | **周上限精确数字(官方"may also apply"但不公布)**；绝对 token 数 | chatgpt.com/codex/pricing · help.openai.com(Codex rate card) · 2026-09 |
| **Claude(Anthropic)** | Max 5x($100)/20x($200)、Pro $20；**会话 5h 重置 + 周上限**(各模型)；官方只给"at least 225 / 900 消息/5h" | 5x/20× 倍数、消息下限 | 消息数=**区间非 token**；周上限绝对值 | support.anthropic.com/9797557 · /11049741(May–Aug 2026) |
| **Google Gemini** | AI Pro = 标准 **4×**，Ultra = **5–20×**；5h 窗口 + 周上限 | 相对倍数 | 绝对 token 数 | support.google.com/gemini/16275805 · antigravity |
| **Kimi(Moonshot)** | 官方 Kimi Code = **agent credits + 未公开的 5h/周 cap**，只给"对 Andante 的 N 倍"；社区实测 Allegretto ¥199 ≈ API 等效 `35.7M`(coding)/`11.2M`(K3)/`17.8M`(HighSpeed) token | 倍率、社区等效 token | **官方固定 token 配额** | llmrates.ai/kimi-allegretto · Golden0Voyager/kimi-code-usage · 2026-08/09 |

> **诚实结论（写入设计）：** 精确固定 token 配额各档**官方层面不存在**，无法回源到精确数。
> 因此 §3.4/§3.6/§3.8 的 `monthlyQuotaTokens` **只能用 estimate（带 source+updatedAt+口径标签）+ 用户可改 + 安全退化**，
> 绝不把任何数当官方固定值。**无法闭环的项已记入 `q1-todo-tracker.md`（老板②"记待办")。**
> 设计侧已可定稿：用"消息/倍率→估算 token"换算 + 用户校准口径，精确度升级待官方公开或实测采集。

**设计：** 配额按 **subscription（订阅）粒度**统计，而非 per-model。
- `Pricing.subscriptionId`（可选）标识所属订阅；`monthlyQuotaTokens` 挂在 **subscription** 级别。
- 消耗按订阅累计；路由决策时把"该模型所属订阅的剩余额度"作为候选权重（§3.8 降级用）。
- **诚实边界：** 各家精确 quota 数值（每周/5h/月上限）待官方文档确认，**不产假值**，标 estimate + 用户可改。

### 3.10 价格变动覆盖 UX（老板 2026-09-22 明确：允许覆盖但不强制）

**老板 Q（原第 4 点）：** 允许价格覆盖，但**不强制直接覆盖**——用明显条幅/toast/会话反馈，
用户可选"替换"或"忽略 + 设忽略时长"。

**设计（与 §3.2 漂移哨兵联动）：**
- 漂移检测产出 `orderChanged` 排序 diff（§3.2）→ 触发**明显 UI 通知**（条幅/toast）：
   "DeepSeek 官方价变动 ¥0.5→¥0.6/百万，路由排序可能变化。[替换为新价] [忽略 · 设 N 天不再提醒]"。
- **用户选择：**
    - **替换** → 采用新官价（写入 L1，`_userSet:true`，用户主权生效）
    - **忽略 + 设时长** → 记录 `PROXY_PRICE_DRIFT_SUPPRESS[name]=<hours>`（默认 24h），
        期间该模型同类漂移**不再提醒**；到期重新检测。
- **绝不强制覆盖**：默认 observe，用户不点"替换"，价不变。
- **通知通道：** 复用 `alert.js`（`PROXY_PRICE_DRIFT_NOTIFY` observe，默认关）+ 前端 toast（UI 交交互设计师）。

### 3.11 渠道健康度进排序权重（老板 2026-09-22 认可 · Q7）

**老板原话："需要进排序权重！这一点你考虑的很周全。"**（老板本想提，结果我先想到——双赢。）

**设计：** `Ranking` 候选加 `channel.reliability` 权重（默认 1.0，用户可配）。
- OpenRouter 类聚合渠道：便宜但可能不稳 → `reliability < 1.0`（降权，但不排除）。
- 路由排序公式（cost-optimization）：`score = costCNY / max(reliability, 0.1)`
    —— 可靠性低时成本被放大，避免"为省钱选到不稳渠道"。
- 与 M2 自动隔离（§provider-health observe）联动：渠道被隔离/降级 → `reliability` 动态降。
- **诚实边界：** reliability 数据源依赖 M2 健康观测（默认 observe），未接执行态时 `reliability=1.0`（不降权）。

### 3.12 历史价格趋势存储（Q6 · 二期，先留着待办）

**老板 2026-09-22 明确：** 保留，让用户知道"为何上月消耗多、哪家/哪个模型更优"。**本期不实现，留待办。**
- 设计预留：`pricing-history.json`（append-only，每次刷新存 {model, channel, input, output, currency, fx, updatedAt}）。
- 用途：月度消费归因、模型性价比历史对比。**P5 二期。**

---

## 4 · 路由模块设计（Q3）

### 4.1 路由范围：默认全员 + 可剔除（钉到真实代码）

**现状（§实核）：** 路由建议由 `routeShadow()` 引擎算 → `findProviderByType(targetModel)` 按
`MODEL_NAME_TO_PROVIDER_TYPE`（chatHandler.ts:219）把 model 名映射到 provider **类型**（deepseek/
openai/generic/ollama）→ 取该类首个 enabled provider → `Object.assign(providerConfig, newConfig)`
覆盖真实路由（`PROXY_ROUTE_OVERRIDE=1` 时，chatHandler.ts:385-414）。

**全员默认：** 候选集来自 `RouteConfig.fallbackChain`（model 列表）+ `providers.enabled=1`。
默认全进，不加白名单。

**剔除机制（三选一，本期默认第 2 个）：**
- ① 从 `fallbackChain` 移除某 model（代码层，运维动作）
- ② `models.enabled=0`（DB 标记，**per-model 剔除，默认全员 enabled=1**）—— 引擎构建候选集时过滤
- ③ 某 provider `enabled=0`（连坐：该 provider 下所有 model 退候选）

> **与 B1 的关系**：B1 是 `models` 0 行 → `findProviderByType` 拿不到类型 → fallback 首个 enabled
> provider。现在 models 6 行已补，`findProviderByType` 能正确按类型解析；剔除用 `models.enabled=0`，
> 不删行（保留幂等）。

### 4.2 三级兜底机制（严谨，钉到路由关/开两态）

```
请求 → handleChatCompletion (chatHandler.ts:369)
  │
  ├─ 路由关 (PROXY_ROUTE_OVERRIDE=0，默认)
  │      → 不走引擎 → findProviderConfig(用户指定的 model)
  │      → 用户未在请求指定 model / 找不到 provider?
  │           → 用 defaultCustomModel (用户设的默认, 同 hermes agent)
  │           → 未设 defaultCustomModel? → 报错 ERR_NO_DEFAULT_MODEL (见 §4.3)
  │
  └─ 路由开 (PROXY_ROUTE_OVERRIDE=1)
        routeShadow → 引擎 suggestion
        findProviderByType(targetModel):
          ├─ 命中 → Object.assign 覆盖 provider → 执行/观测
          └─ 返回 null (候选全 disabled/down/剔除)
               → ultimateFallbackModel (路由开专属兜底)
               → 未设 → 报错 ERR_NO_FALLBACK (见 §4.3)
```

**三级层次（语义独立，分开报错）：**
1. **`findProviderConfig(用户model)`**——路由关，用户显式指定的 model，找不到的 provider 报错 `NO_PROVIDER`（现有代码，chatHandler.ts:378-381，已存在）
2. **`defaultCustomModel`**——路由关，用户没指定/想用默认时，用此默认（**新增，hermes agent 式**）
3. **`ultimateFallbackModel`**——路由开，引擎选不出候选时，用此最终兜底（**新增**）

### 4.3 兜底缺失 → 报错（严谨，不静默默认）

- **路由关 + 无 `defaultCustomModel`** → **报错 `ERR_NO_DEFAULT_MODEL`**（HTTP 424 或 400，
   明确提示"路由关时未设默认模型"）。绝不静默默认到某 provider。
- **路由开 + 候选全空 + 无 `ultimateFallbackModel`** → **报错 `ERR_NO_FALLBACK`**，明确提示。
- **绝不静默默认**（老板："没有设置，路由就失败报错"）—— 静默默认会掩盖配置缺失，
   且可能把请求塞到错误 provider（重蹈 B1 覆辙）。
- **可观测**：报错走 `recordOverrideEntry`（加 `applied:false, error code`）+ 写 `logs` 表 +
   可选告警（`PROXY_ROUTE_FAIL_NOTIFY` observe，默认关）。
- **配置注入**：`defaultCustomModel` / `ultimateFallbackModel` 走 env
   （`PROXY_DEFAULT_CUSTOM_MODEL` / `PROXY_ULTIMATE_FALLBACK_MODEL`）或 DB 配置行（不写死、不硬编 UUID）。

### 4.4 与 B1 路由塌缩的边界

| 层次 | 名称 | 含义 | 错误码 |
|---|---|---|---|
| L1 | `findProviderConfig(user model)` | 路由关，用户指定 model 找 provider | `NO_PROVIDER`（现有） |
| L2 | `defaultCustomModel` | 路由关，无默认 | `ERR_NO_DEFAULT_MODEL`（新增） |
| L3 | `ultimateFallbackModel` | 路由开，候选全空无兜底 | `ERR_NO_FALLBACK`（新增） |
| B1（已修） | `findProviderByType` fallback | model 名→类型解析失败 fallback 首个 | 已通过补 6 行 models 修 |

> **P4 最险，逐场景确认**：路由策略直接决定线上走哪个 provider。设计稿定 + 老板逐场景拍 +
> 门控默认关（observe）后才开发。


---

## 5 · 整体数据流（非侵入，热路径零网络）

```
[开发期 / 手动 / 定时]                    [运行期 · 热路径]
refresh-pricing.cjs                        请求 → classifyTask → 引擎
  │ 拉多渠道官方价                           │  resolvePricing(model,channel)
  ▼                                        │  L1(用户覆盖) → L2(渠道缓存) → L0(官方种子) → 0
写 pricing-cache.json (TTL,带元数据)        │  → 候选集 (enabled AND participates)
  │  vs 现生效价                            │  → estimateCost (同币种 + 同渠道 比)
  ▼                                        ▼
偏差 > PROXY_PRICE_DRIFT_PCT?          rankByCost → target
  ├─ > 阈值 → 写告警 (只提醒,不覆盖, 24h 去重)   │
  └─ ≤ 阈值 → 静默                          ▼
                                          路由开 → 执行 / 路由关 → defaultCustomModel
                                          候选空 → ultimateFallback / 无→报错
```

**热路径不发任何 HTTP**：resolvePricing 同步读文件；刷新是独立脚本。这是非侵入铁律的硬保证。

---

## 6 · Q5 · 老板"想想还有什么" —— 8 点定论汇总(2026-09-22)

| # | 老板意见 | 设计落点 | 状态 |
|---|---|---|---|
| 1 | **币种纠错**:USD 模型要能路由(gpt6 做复杂任务);原币保留 + 换算 CNY 参与决策 | §3.5 汇率参与路由 + §3.5.1 汇率源 | **老板纠错,已改** |
| 2 | 共享订阅配额需调研,不拍脑门 | §3.9 调研结论(行业=共享 credit 池) | **调研完成,数值待确认** |
| 3 | 配额耗尽=执行前评估+执行中优雅停(类比 hermes 上下文压缩,项目优势) | §3.8 配额耗尽优雅降级 | **设计完成,门控 observe** |
| 4 | 价格覆盖:允许但不强制,toast/条幅,可替换/可忽略设时长 | §3.10 价格变动覆盖 UX | **设计完成** |
| 5 | 币种换算显示:要显示,UX 交交互设计师把关 | §3.5 末尾(数据契约,UI 交交互设计师) | **设计完成** |
| 6 | 历史价格趋势:留待办 | §3.12 P5 二期 | **待办** |
| 7 | 渠道健康度进排序权重:需要 | §3.11 渠道健康度权重 | **设计完成,老板认可** |
| 8 | B6/M2 commit push | `6510849` 已 push origin | **✅ 完成** |

### 6.1 D1-D6 已定稿(2026-09-22 · 老板拍"D1-D6 全部按建议")

> **架构定稿。** 老板 2026-09-22 拍 D1-D6 全部按建议。下表"我的建议"列即定稿值;原"待拍"转"已定"。
> 下一步:⑧ 多角色评审 + E2E(本稿 + UX 稿 + 现有代码);**P1-P5 开发待老板另批,不抢**。

**本轮已收口(老板 8 点定论,§13.26 落盘):**
- ✅ ② 配额精确数值 → **已跑官方文档回源**:4 家(OpenAI/Claude/Gemini/Kimi)官方**均不公布精确固定 token 配额**(只给 5h 消息区间 / N× 倍率 / 社区等效)。结论 + 无法闭环项记入 `q1-todo-tracker.md`(§3.9.1)。设计可定稿:estimate + 用户可改 + 安全退化,绝不产假。
- ✅ ④ 前端 UI → **已派交互设计师子 agent**,产出 `q1-ux-design-v1.md`(3 表面,各含文案+门控+状态机+边界+架构对应;强制补可访问性债 `role=dialog`/`aria-live`/焦点陷阱)。
- ✅ ③ 配额预检 → **老板拍"接受估算+宁可早停"**(部分厂商无精确余额接口),已写入 §3.8。
- ✅ ⑤ 告警+错误码 → **老板拍"复用 alert.js + 可读铁律(绝不甩错误码给用户)"**,已落 UX 稿 §0 K1(三件套:发生啥/影响/下一步)。
- ✅ ⑦ B6/M2 观察期 → cron `fa098cb41ec6`(2026-10-06 提醒接热路径,只提醒不动码)。

**D1-D6 定稿值记录(2026-09-22 老板拍"全部按建议",已确认;详见 §9 定稿 D 表):**

| 编号 | 拍板项 | 定稿值 | 出处 |
|---|---|---|---|
| D1 | 汇率源(老板①) | **方案 C(缓存+手动刷新,热路径零网络)** | §3.5.1 / UX §2.7 |
| D2 | 汇率兜底(老板① 没看懂项) | 拉不到时**显性退 `fx=1.0` + warning**(USD 模型显贵被降权→顶部"比价失真"提示);`7.2` 仅缓存最近值,非硬兜底 | §3.5.1 / UX §2.4 |
| D3 | 路由三级兜底 L1/L2/L3(老板⑥) | §4.4 分层 + 3 报错(`NO_PROVIDER`/`ERR_NO_DEFAULT_MODEL`/`ERR_NO_FALLBACK`),**缺兜底即报错绝不静默**(避免重蹈 B1) | §4.2-4.4 |
| D4 | 配额 observe/执行(§3.8 / UX D-C1) | **先 observe**(门控默认关),翻执行态属老板单点决策 | §3.8 / UX §3.7 |
| D5 | 80% 预警阈值(UX D-C2) | 默认 80% | UX §3.7 |
| D6 | 价格漂移 toast(UX D-A1) | **默认可见·只读镜像**(改价仍需点"替换");关则"价格中心"手动入口 | UX §1.7 |

### 6.2 已 resolved(老板本轮拍定,不再是开放问题)
- ~~漂移覆盖~~ → 允许覆盖不强制 + toast UX(§3.10)
- ~~USD 不参予路由~~ → 汇率参与路由(§3.5,老板纠错)
- ~~渠道健康度~~ → 进权重(§3.11,老板认可)
- ~~历史趋势~~ → P5 待办(§3.12)

---

## 7 · 开发分期（架构定稿后，待老板批准开发）

| 期 | 内容 | 验证 | 风险 |
|---|---|---|---|
| **P1** ✅ 09-22 完成 | 价表三层 + 8 家官方价（含 deepseek 0.5/3 修、kimi 真实价、currency、_userSet）+ `resolvePricing`/`resolveFxRate`/`resolveBillingCost`/`rankByCostCny`/`resolveModelEnabled` 纯函数 + 测试 | ✅ tsc 0 错 + 全量 jest 174/174（含 `pricing-fx.test.ts` 31 条）+ 门控关逐字节不变（`rankByCostCny≡rankByCost`、`cny≡estimateCost`，热路径 `getNextRoute` 0 改动实证） | 低（纯函数+文件层） |

> **P1 实施说明(09-22 实测)**：架构稿原估"~15 测试",实测写足 **31 条**(`pricing-fx.test.ts`)，覆盖 F1 deepseek 回源 / E 汇率门控 / F resolveFxRate 优先级 + 异常 / G resolveBillingCost 门控开关 / H rankByCostCny 重排 / I resolvePricing 三层 / J 逐模型门控 / K approxEqual。`getNextRoute` 热路径 **0 改动**——汇率接入路由留 P5，P1 严守数据层不碰选择逻辑。
| **P2** | `refresh-pricing.cjs`（TTL + 多渠道 + 失败不阻塞 + 元数据）+ L2 缓存 | 脚本手跑 + 缓存文件校验 | 中（网络源，需 mock 源测试） |
| **P3** | 漂移告警（`PROXY_PRICE_DRIFT_NOTIFY` observe + 24h 去重 + orderChanged 载荷） | 告警测试 + 24h 去重 | 中（需 alert.js 契约对齐） |
| **P4** | 路由范围（全员默认 + participates_in_routing 剔除）+ 三级兜底 + 报错误码 | 兜底矩阵测试（关/开 × 有/无兜底 × 候选空） | 高（路由策略，需老板逐场景确认） |
| **P5** | 配额耗尽优雅降级(`PROXY_QUOTA_GUARD` observe,§3.8) / 渠道健康度权重(§3.11,依赖 M2) / 价格覆盖 toast(§3.10) / 历史趋势(§3.12,待办) | 逐期验证 | 中(依赖 M2/quota 数据) |

**分期铁律：P4 路由策略最险，架构定稿 + 老板逐场景确认后才开。P1-P3 偏数据/文件，风险低，可并行。**

---

## 8 · 风险与边界

| 风险 | 缓解 |
|---|---|
| 刷新网络挂阻塞启动 | 刷新失败用旧缓存/种子，不阻塞，写 warning |
| 多源价格打架 | 渠道维度区分 + 用户覆盖最高优先 |
| 订阅配额 estimate 不准 | 诚实标 estimate + 用户可改 + 安全退化 |
| 路由策略变更影响线上 | P4 门控默认关（observe），翻属老板决策 |
| 兜底静默默认掩盖配置缺失 | 绝不静默默认，缺失即报错（§4.3） |
| deepseek 改价影响现有路由 | 门控关时逐字节不变；P1 跑全量回归 |

---

## 9 · 架构定稿完成(2026-09-22 收口 · 老板拍"D1-D6 全部按建议")

**✅ D1-D6 全过 = 架构定稿。** D1 汇率源 C | D2 汇率兜底 fx=1.0+warning(7.2 仅缓存值) | D3 路由 L1-L3 分层 + 3 报错 | D4 配额先 observe | D5 80% 阈值 | D6 漂移 toast 默认可见·只读镜像。

**已收口(§6.1 详见):** ①汇率源C / ②官方回源(4 家无精确配额,记 todo-tracker)/ ③估算+宁可早停 / ④交互设计稿已出 / ⑤告警复用 alert.js+可读 / ⑥路由 L1-L3 / ⑦cron fa098cb41ec6 / 币种汇率参与路由 / 价格覆盖不强制+toast / 渠道进权重 / 历史趋势P5 / B6·M2已push。

**下一步:** ⑧ 多角色评审 + E2E(本稿 + `q1-ux-design-v1.md` + 现有已 push 代码)。P1-P5 开发待老板另批(不抢)。

**D1-D6 完整定稿值见 §6.1「定稿值记录」表(本稿无待拍项)。开发分期见 §7(P1-P5 待老板另批,本稿不抢开发)。老板⑧ 多角色评审 + E2E 已开工(评审目录 `docs/09-review/q1-arch-2026-09-22/`);交互设计师另抛 D-A1/D-B1/D-B2/D-C1/D-C2 已并入 §6.1 D1-D6。**
