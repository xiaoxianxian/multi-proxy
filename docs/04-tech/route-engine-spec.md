# 路由策略透明化 — route-engine 决策逻辑披露（2026-09-21）

> 来源：老板转 DeepSeek 会话 `chat.deepseek.com/share/26aeslhzz19kxgw3go`（批评③"调度/成本策略黑盒"）。
> 本文把 `l2/route-engine.js` / `l2/cost.js` / `l2/agent-registry.js` 的**真实**路由逻辑披露出来，
> 让用户敢依赖它做关键任务。每节末尾标注 grounded 到代码行，**未实现的能力如实标 [缺口]**。
> 关联：`l2/route-engine.js` / `l2/cost.js` / `l2/agent-registry.js` / `l2/COMPLEXITY-MODE.md` / `l2/mcp-default-seed.js`

---

## 一、它怎么决策（一句话）

给定一个任务，route-engine 从"已注册 agent profile + 已启动插件能力"里挑候选，
按 **模态优先 → 难度档优先 → 匹配度** 三级排序，选第一个；默认 **shadow 模式只记日志不真执行**。

---

## 二、两个决策轴（不是单一"难度"，是两根独立的轴）

| 轴 | 回答什么 | 取值 | 代码 |
|---|---|---|---|
| **modelType（模态）** | 任务什么载体 | `text` / `multimodal` / `audio` | `route-engine.js:147-151` `_inferModelType` |
| **complexity→modelTier（难度）** | 任务多难 → 用什么档 | `small` / `medium` / `large` | `route-engine.js:156-160` `_mapTier` |

- 模态推断：`vision/image/video/text2video` → `multimodal`；`audio/tts/stt` → `audio`；其余 → `text`。
- 难度映射：`complexity='low'` → `small`；`'high'` → `large`；其余/未知 → `medium`（**保守，不降级**）。
- **向后兼容**：profile 未设 `modelTier`、task 未带 `complexity` → 一律按 `medium`，旧行为不变。

---

## 三、打分与排序（真实权重，无黑盒）

### 3.1 候选过滤
只有 **capabilityTags 命中** task.type 的 profile/plugin 才进候选（`route-engine.js:73` `if (tagMatch)`）。
不命中能力标签的 profile 直接排除。

### 3.2 匹配度打分 `_calcConfidence`（`route-engine.js:168-174`，满分 3）
| 信号 | 命中 +1 | grounded |
|---|---|---|
| `capabilityTags` 含 task.type | +1 | `:170` |
| `modelType` === 期望模态 | +1 | `:171` |
| `modelTier` === 期望档位 | +1 | `:172`（仅显式设了 modelTier 的 profile 参与，插件无 tier） |

### 3.3 排序（`route-engine.js:103-111`，三级字典序）
1. **modelTypeMatch**（模态对 > 模态不对）
2. **tierMatch**（难度档对 > 不对）
3. **confidence**（高 > 低）

`chosen = 排序后第一个`（`:112`）。

### 3.4 档位 → 实际 provider（成本梯度，`COMPLEXITY-MODE.md §2.1`，已 seed）
| modelTier | 典型 provider | 成本档 | seed profile（`mcp-default-seed.js`） |
|---|---|---|---|
| small | Agnes（免费）/ 本地 Qwen 小档 | 免费→低 | `agnes` |
| medium | DeepSeek（缓存红利 ¥0.02/1M） | 中 | `deepseek` |
| large | Qwen3.8-27B / 远端强模型 | 高 | `qwen` |

> 三 profile seed 已落地（jest 14/14）。档位是**抽象命名**（small/medium/large），方便换 provider 而不动路由。

---

## 四、shadow 模式（默认开，"先观察再切换"）

- `shadowMode = true`（`route-engine.js:22` 默认）：决策照常算，但 `action='log-only'`、**不真执行**（`:45,114-118`）。
- `shadowMode = false` 且选中候选：`action='execute'`，调 `_execute` 真执行（`:285` 注入 executor 时）；
  无注入 executor 时退化 `status:'queued'`（stub，零副作用，`:183-194`）。
- **P3 真执行门控**（`mcp-server.js` `PROXY_ADAPTER_REAL`）：门控关=恒 shadow，per-call `shadowMode=false` 不可绕过；
  门控开才真执行，且无注入 executor 退化"仅路由"（记录选中 adapter、不触下游）。

### 4.1 shadow 日志记什么（`route-engine.js:37-46,176-181`）
内存 ring buffer（默认 100 条 `logCapacity`），每条 decision 含：
`timestamp / taskId / taskType / taskPrompt(截前 50 字) / candidates[] / chosen / shadowMode / action / expectedTier`。

---

## 五、[缺口] DeepSeek 要、本项目尚未实现的（如实标注，不编造）

| DeepSeek 期望 | 项目现状 | 证据 | 处置 |
|---|---|---|---|
| **成本进路由决策** | ❌ 未进。`cost.js` 独立只喂 `alert.js` 的 `cost-budget-exceeded` 信号，**不参与 route 排序** | `cost.js` 全文；route 的 3 个 +1 信号无成本项 | task1/task2 待办：成本信号接 route |
| **余额/额度信号** | ❌ 未进。route 不看各 provider 余额 | grep 全仓 `routing_overrides`/`force_provider` 0 命中 | 待办 |
| **硬规则覆盖**（`force_provider` / `exclude_providers` / 按 task_type 锁强模型） | ❌ 未实现 | 同上 0 命中 | 待办（DeepSeek 建议的 `routing_overrides` 配置形） |
| **延迟历史 / 失败率** 进路由 | ❌ 无 latency/health 信号进 route | route 仅 3 信号 | 待办 |
| **误判代价量化** | ⚠️ 半：`high→large` 不降级（决策点②质量优先）；但 `low→small` 若把难活误判为 low 会派弱模型 | `COMPLEXITY-MODE.md §2.1/§四` | 二期 LLM judge 动态复判更准（已留路线） |
| **shadow 日志"算钱"**（DeepSeek 杀手级展示） | ❌ 未实现。日志记路由建议，**不算"可省 ¥X"** | `route-engine.js:176` 只 `_pushLog(decision)`，无 cost 计算 | task1/task2 核心待办 |

> 这些缺口是**真缺口**，不是文档没写——grep 实证 0 实现。透明化的意义就在此：把"哪些是黑盒、哪些还没做"讲清楚。

---

## 六、给用户的可控建议（当前能做的）

1. **现在就能做"观察-切换"**：开 shadow 跑真实流量看 decision 日志，确认引擎决策质量后再 `setShadowMode(false)`。
2. **现在就能配档位映射**：在 `agent-registry` 给 profile 打 `modelTier`（`small/medium/large`），按自己成本梯度映射 provider。
3. **现在就能写 capabilityTags**：让特定 task.type 只命中你信任的强模型（粗粒度可控）。
4. **尚未可做（待 task1/task2）**：成本进路由、余额选路、硬规则 `force_provider`、shadow 算钱展示——需实现，已登记待办。

---

## 七、grounded 总表（每节可回到代码行）

| 断言 | 代码位置 |
|---|---|
| 3 个 +1 信号 | `route-engine.js:168-174` |
| 三级排序 | `route-engine.js:103-111` |
| 模态推断 | `route-engine.js:147-151` |
| 难度映射 | `route-engine.js:156-160` |
| shadow 默认 / action | `route-engine.js:22,45,114-118` |
| executor 注入 / 退化 queued | `route-engine.js:285→` `:183-194` |
| cost 仅喂 alert 不进 route | `cost.js` 全文 |
| 3 profile seed | `l2/mcp-default-seed.js`（agnes/deepseek/qwen，jest 14/14） |
| 档位成本梯度 | `COMPLEXITY-MODE.md §2.1` |

_落盘：2026-09-21 · 作者：贾维斯（Hermes Agent）· 依据代码实读，未编造 · 缺口项诚实标注_
