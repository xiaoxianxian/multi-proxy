# COMPLEXITY MODE — 按复杂度选模型档位路由设计（草案）

> 状态：**设计草案 · 待老板讨论定稿（2026-09-18）**
> 背景：WorkBuddy 评估 option1——"把 complexity→模型档位接进 route-engine"。
> `l2/decomposer.js` 子任务节点已产 `{complexity: 'low'|'medium'|'high'}`，
> 但 `l2/route-engine.js` 仅消费 `modelType`（text/multimodal/audio 模态），
> **从未消费 complexity（难度维度）**。模态≠难度，两者是不同轴，见下。
> 关联：`l2/route-engine.js` / `l2/agent-registry.js` / `l2/decomposer.js` / `l2/orchestrator.js`

---

## 一、两个轴（先讲清，否则设计跑偏）

| 轴 | 问题 | 现状 |
|----|------|------|
| **modelType（模态）** | 任务什么载体（文本/图/音） | ✅ 已接（Block 2，2026-09-18） |
| **complexity（难度）** | 任务多难 → 选什么**档位**的模型 | ❌ 未接（本设计） |

- decomposer 产出 complexity：`{id, type, complexity:'low'/'medium'/'high', prompt, deps}`（`decomposer.js:13` 注释 + 各模板）
- route-engine 当前 route：`expectedModelType = task.modelType || _inferModelType(task.type)` → 只按模态 + 能力标签
- **缺口**：复杂度标签从产出后就没进路由，"按难度选最便宜的够强模型"没闭环。
- 这是项目相对 Octop/WorkBuddy 的真正差异化筹码（"按需求选最合适模型"的最后一块）

---

## 二、核心设计

### 2.1 agent-registry 新增 `modelTier` 字段

```js
const MODEL_TIERS = new Set(['small', 'medium', 'large']);
// 可选字段，未设置 = 'medium'（YAGNI，向后兼容，同 Block 2 的 modelType 策略）
```

映射到现有 provider（**不是新造**，对齐现有成本梯度，见 `commercialization-decided.md §4.2`）：

| modelTier | 定位 | 典型模型（示例，老板定） | 成本档 |
|-----------|------|--------------------------|--------|
| small | 简单任务 / 高频 | Agnes（免费）/ 本地 Qwen 小档 | 免费 → 低 |
| medium | 常规 | DeepSeek（缓存红利） | 中 |
| large | 复杂 / 高要求 | Qwen3.8-27B（默认）/ 远端强模型 | 高 |

### 2.2 route() 消费 complexity

子任务经 orchestrator→route 时，task 携带 `complexity`（decomposer 已产）：

```js
// route() 内
const expectedModelType = task.modelType || this._inferModelType(task.type);
const expectedTier = this._mapTier(task.complexity);  // 'low'→small, 'medium'→medium, 'high'→large
// 候选过滤 + confidence：
//   +1 capabilityTags 命中
//   +1 modelType 命中（保留 Block 2）
//   +1 modelTier 命中（新增）
// 排序：modelTypeMatch desc → confidence desc
```

```js
_mapTier(complexity) {
    if (complexity === 'low') return 'small';
    if (complexity === 'high') return 'large';
    return 'medium';   // 默认 / 未知复杂度 → medium（保守，不降级）
}
```

### 2.3 消费入口（关键：在 executor，不碰热路径）

- `orchestrator.js`：`route` 已注入但 shadow 下不真调（`orchestrator.js:128`）；executor `(st, ctx)` 内部调 `routeEngine.route(st)`，按 `chosen.modelTier` + 成本梯度选 adapter。
- **热路径 forward.js / codex-proxy/proxy.js 不动**（option 是 L2 内核 + 测试，零网关改动）。

### 2.4 向后兼容

- 旧 profile 无 `modelTier` → 视为 `'medium'`
- 旧 task 无 `complexity` → `_mapTier` 返 `'medium'`
- `byCapability` / `byModelType` 签名不变；新增 `byTier(tier)` 查询（对称 Block 2 的 `byModelType`）

---

## 三、改动范围（预估）

| 文件 | 改动 | 风险 |
|------|------|------|
| `l2/agent-registry.js` | +`MODEL_TIERS` 常量 + `modelTier` 可选校验 + `byTier()` | 低（同 Block 2 模式） |
| `l2/route-engine.js` | +`_mapTier()` + route() 消费 complexity + confidence +1 | 低（扩展现有维度） |
| `l2/agent-registry.demo.js` | +3 case：byTier / 默认 tier / 校验 | 低 |
| `l2/route-engine.demo.js` | +1 case：complexity 路由（low→small, high→large） | 低 |
| `tests/unit/agent-registry.test.js` | +3 test | 低 |
| `tests/unit/route-engine.test.js` | +4 test | 低 |

> 预计 ~10 测试，与 Block 2 同量级；热路径零改动。

---

## 四、决策点（已定稿 · 2026-09-18 老板确认）

| # | 决策 | 结论 |
|---|------|------|
| 1 | **tier 命名** | ✅ **small/medium/large（抽象档位）**——好换 provider，映射到现有成本梯度 |
| 2 | **high complexity 是否降级** | ✅ **不降级，质量优先**：high→large，low→small |
| 3 | **静态 vs 动态 complexity** | **分两期**：①本期=decomposer 静态标签（零成本，过渡）；②二期=route 时 LLM judge 动态复判难度（**更准**）。原则=质量优先，静态是过渡、动态是终态 |
| 4 | **文档组织** | ✅ 本文件 `COMPLEXITY-MODE.md` 独立（modelType/complexity 两轴分开） |

> **文件粒度通用约定（老板 2026-09-18）**：文档/文件拆分=不拆太碎、不塞成一坨在一个文件里；按「一个主题一份」判断。已记入项目 MEMORY。

---

## 五、验收标准（定稿后）

1. `agent-registry.test.js` +3 绿
2. `route-engine.test.js` +4 绿
3. `route-engine.demo.js` 输出含 complexity 路由示例
4. 全量 `npx jest` 零回归（基线 837，预期 847）
5. l2 demo 全绿（基线 16/202，预期 +1）

---

_草案日期：2026-09-18 | 作者：贾维斯（Hermes Agent）| 关联外部评估：WorkBuddy option1_
