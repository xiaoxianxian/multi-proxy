---
title: "ADR-0005: 路由扩展「工作类型轴」+ 高价值路由成本豁免"
status: proposed
doc_type: ADR
confidence: medium
last_updated: 2026-09-27
related_code:
   - l2/route-engine.js
   - l2/agent-registry.js
   - l2/cost.js
related_docs:
   - docs/04-tech/route-engine-spec.md
   - docs/10-initiatives/33-layered-routing-wechat-reference-2026-09-27.md
---

# [ADR-0005] 路由扩展「工作类型轴」+ 高价值路由成本豁免

## 状态

**proposed**（待评审，未落码）。

## 背景

外部一篇分享（《来看看AI老鸟是怎么使用AI的》，分析见 `docs/10-initiatives/33-layered-routing-wechat-reference-2026-09-27.md`）把日常 AI 使用切成三层：设计 / 实现 / 杂活，且设计层"从不省钱、直上最强模型"。这与本项目的成本纪律同源，但点出一个 route-engine 当前**缺的旋钮**：**高价值任务应豁免成本优化**。

对照 `docs/04-tech/route-engine-spec.md §五` 已登记的真实缺口：

- 硬规则覆盖（`force_provider` / `exclude_providers` / 按 task_type 锁强模型）❌ 未实现
- 成本未进路由决策 ❌ 未实现

本 ADR 把"设计层直上强模型、不参与省钱"落为路由层的显式能力，同时补上 §五 的两条缺口。

## 现状事实（实读代码，非臆测）

- route-engine 已是**双轴决策**：`modelType`（模态，`route-engine.js:56,163-167`）+ `complexity→modelTier`（难度，`route-engine.js:59,172-176`）。
- 排序三级字典序：`modelTypeMatch → tierMatch → confidence`（`route-engine.js:109-118`），`chosen = 排序第一`（`route-engine.js:119`）。
- 档位已 seed 三 profile：`agnes`(small/免费) · `deepseek`(medium) · `qwen`(large)（`route-engine-spec.md §3.4`）。
- **没有"工作类型"维度**，也**没有"某类任务强制锁强模型 / 豁免成本优化"的开关**——这是本文要补的。

## 决策

在现有双轴之上，**新增第三根轴 `workType`**，并提供 `premiumExempt` 策略，使"设计层直上最强、不参与成本优化"成为路由层的显式能力，而非靠人肉配 profile。

### 轴优先级（排序扩展为四级）

`workType(premium flag) → modelTypeMatch → tierMatch → confidence`

### 具体改动（按依赖排序）

1. **task 增加 `workType` 字段**：取值 `design | implement | chore`，默认 `implement`（向后兼容：旧 task 无此字段一律按 `implement`，零行为变更）。
2. **`premiumExempt` 策略**：`workType=design` 时自动置位，route() 表现为：
   - 强制 `expectedTier = large`（不看 complexity，质量优先，呼应 `route-engine.js:172` 的 high 不降级原则）；
   - **硬规则覆盖**：`exclude_providers` 排除 `agnes`/`deepseek` 等廉价 provider（补 §五 缺口①）；
   - **成本信号不进入排序权重**（补 §五 缺口②：cost 仅作观测，不压低 design 任务选路）。
3. **`implement` / `chore` 维持现状**：继续走 complexity→tier 成本梯度，savings-gateway 正常优化。
4. **非侵入对齐**：`premiumExempt` 默认 false、`workType` 默认 `implement` → 默认零路由变化，符合铁律④（门控默认关 / shadow 默认开）。上线前先 shadow 观察决策日志。

### 排序落地（route-engine.js）

在现有 `:109-118` 比较函数前插入一级：

```js
if (a.premiumExempt !== b.premiumExempt) return a.premiumExempt ? -1 : 1;
```

## 备选方案

### 方案 A：只靠用户手配 profile（不引入 workType 轴）

可行，但回到"人肉路由"，无法表达"某类任务结构性豁免成本"；且每次新增 design 类 task.type 都要改 seed。否决。

### 方案 B：本方案（workType 轴 + premiumExempt）

表达力强、默认零变更、复用现有 tier/profile 体系。采纳。

## 原因

文章的用户侧观察印证了"贵活直上强模型"是真实需求；而 §五 缺口本就登记了硬规则覆盖与成本进路由。本 ADR 用一根轴同时关掉两个缺口，且不与"模型跟随任务"的既有 thesis 冲突。

## 后果

### 正面

- design 层任务结构性豁免成本优化，避免"为省而省把架构级活降配"。
- 补齐 §五 两条真实缺口（硬规则覆盖 + 成本进路由观测）。
- 对外叙事多一个可演示支点：路由不仅按难度，还按"任务性质"做策略。

### 负面

- route() 排序多一级，复杂度微增；需在 `route-engine-spec.md` 同步披露新轴（透明化要求）。
- `premiumExempt` 若误开，会把本该省钱的活也锁强模型——需 shadow 验证。

### 后续工作

- [ ] 在 `agent-registry` 评估是否给 profile 加 `workType` 声明（细粒度可控）。
- [ ] `route-engine-spec.md` 增补"工作类型轴"一节 + grounded 行号。
- [ ] shadow 日志新增 `workType` / `premiumExempt` 字段，便于审计"哪些任务被豁免"。
- [ ] 接 `cost.js` 信号做观测（不压路），先 shadow 展示"design 任务本可省 ¥X 但主动豁免"。
