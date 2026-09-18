# CAPABILITY MODE — 模型类型与能力标签路由设计

> 状态：设计阶段（待实施）
> 关联：`l2/route-engine.js` / `l2/agent-registry.js` / `l2/plugin-runtime.js`
> 背景：上轮 Block 2 监控三件套（CB/RL/HM）已落地 `b947f9e`，但路由层仍仅按 `capabilityTags` 匹配，无 `modelType`（文本/多模态）维度，导致图像/视频任务可能误路由到纯文本代理。

---

## 一、现状问题

### 1.1 route-engine.js 当前逻辑（120 行）

```js
_calcConfidence(tags, targetType) {
    if (!Array.isArray(tags)) return 0;
    return tags.includes(targetType) ? 1 : 0;  // 仅 tag 精确匹配
}

route(task) {
    const registryProfiles = this.registry.byCapability(task.type);  // 纯标签匹配
    // ... 合并 pluginCaps ...
    decision.candidates = [...candidateMap.values()].sort((a, b) => b.confidence - a.confidence);
    decision.chosen = decision.candidates[0] || null;
}
```

**问题**：
- `task.type = 'vision'` → 返回所有 `capabilityTags` 含 `'vision'` 的 profile
- 但若 profile-A 是 `modelType: 'text-only'`（如 Codex CLI），profile-B 是 `modelType: 'multimodal'`（如 Hermes），两者都可能命中，无区分
- 无 fallback 链：精确 modelType 匹配 → 降级为任意 modelType

### 1.2 agent-registry.js 当前 schema（155 行）

```js
const REQUIRED = ['id', 'name', 'type', 'capabilityTags', 'specVersion'];
// type 枚举：['codex', 'hermes', 'cursor', 'custom']
// 无 modelType 字段
```

**缺失**：`modelType` 字段（'text' | 'multimodal' | 'audio'）

---

## 二、设计方案

### 2.1 modelType 枚举

```js
const MODEL_TYPES = new Set(['text', 'multimodal', 'audio']);
// 'text' = 纯文本（Codex, Cursor text mode）
// 'multimodal' = 文本+图像（Hermes, H3Web）
// 'audio' = 文本+音频（TTS/STT）
```

### 2.2 agent-registry.js 变更

1. **schema 扩展**：`modelType` 为可选字段（YAGNI：不强制必填，默认 `'text'`）
2. **新增查询方法**：`byModelType(modelType)` 返回该 modelType 的所有 profile
3. **`byCapability` 保持向后兼容**：现有调用方不受影响

### 2.3 route-engine.js 变更

**核心修改**：`route(task)` 增加 modelType 过滤链

```js
route(task) {
    // 1. 解析任务期望的 modelType（从 task.modelType 或推导）
    const expectedModelType = task.modelType || this._inferModelType(task.type);
    
    // 2. 先按 modelType + capabilityTags 精确匹配
    let candidates = this._matchByModelTypeAndTags(expectedModelType, task.type);
    
    // 3. 若为空，降级为仅 capabilityTags（兼容旧数据）
    if (candidates.length === 0) {
        candidates = this.registry.byCapability(task.type);
    }
    
    // 4. 计算 confidence（保留原有逻辑 + 新增 modelType 加分）
    //    modelType 匹配 +1, capabilityTags 匹配 +1
    decision.candidates = candidates.map(profile => ({
        adapterId: profile.adapterId,
        source: 'registry',
        confidence: this._calcConfidence(
            profile.capabilityTags, 
            task.type,
            profile.modelType,
            expectedModelType
        ),
    })).sort((a, b) => b.confidence - a.confidence);
}

_inferModelType(taskType) {
    // 启发式：vision/video/audio → 'multimodal'/'audio'，否则 'text'
    if (['vision', 'image', 'video'].includes(taskType)) return 'multimodal';
    if (['audio', 'tts', 'stt'].includes(taskType)) return 'audio';
    return 'text';
}

_calcConfidence(tags, targetType, profileModelType, expectedModelType) {
    let score = 0;
    if (tags.includes(targetType)) score += 1;
    if (profileModelType === expectedModelType) score += 1;  // modelType 匹配加分
    return score;
}
```

### 2.4 向后兼容策略

- `modelType` 为**可选字段**，未设置时默认 `'text'`
- 旧 profile 无 `modelType` → 视为 `'text'`，不影响现有路由
- `byCapability` 方法签名不变，仅内部实现可能优化

---

## 三、实施步骤

### Phase 1：registry 扩展（最小改动）

1. `agent-registry.js`：
   - 添加 `MODEL_TYPES` 常量
   - `validate()` 增加 `modelType` 可选校验
   - `create()` / `update()` 透传 `modelType`
   - 新增 `byModelType(modelType)` 查询方法

2. `agent-registry.demo.js`：加 2 个 demo case（modelType 过滤）

3. `tests/unit/agent-registry.test.js`：加 3 tests（创建带 modelType / byModelType 查询 / 默认值 fallback）

### Phase 2：route-engine 路由升级

1. `route-engine.js`：
   - 添加 `_inferModelType(taskType)` 启发式
   - 修改 `route(task)` 增加 modelType 过滤链
   - 修改 `_calcConfidence()` 增加 modelType 匹配分

2. `route-engine.demo.js`：加 2 个 demo case（multimodal 任务优先匹配 multimodal 代理）

3. `tests/unit/route-engine.test.js`：加 4 tests（modelType 精确匹配优先 / fallback 到 text-only / 无 modelType 字段兼容）

### Phase 3：端到端验证

1. 全量 jest：`npx jest` 确认 mpm 644/644 零回归
2. l2 demo：`node l2/route-engine.demo.js` 运行确认新逻辑
3. 更新 `l2/CASES.md` 路由案例

---

## 四、边界与决策

| 问题 | 决策 |
|------|------|
| modelType 必填还是可选？ | **可选**（YAGNI：旧数据无此字段，默认 'text'） |
| 任务无 modelType 时如何推导？ | 启发式：`vision/image/video` → `'multimodal'`，`audio/tts/stt` → `'audio'`，其余 `'text'` |
| modelType 与 capabilityTags 冲突？ | **tag 优先**（tag 是显式声明，modelType 是隐式属性） |
| 是否支持自定义 modelType？ | **不支持**（仅 `text/multimodal/audio` 三态，符合项目实际） |

---

## 五、验收标准

1. `agent-registry.test.js` +5 tests（全绿）
2. `route-engine.test.js` +4 tests（全绿）
3. `route-engine.demo.js` 运行输出含 modelType 匹配示例
4. 全量 jest **839/839**（基线 830 + 新 9）
5. l2 demo **16 demo / 202 checks**（基线 196 + 新 6）

---

_设计日期：2026-09-18 | 作者：Hermes Agent | 关联 commit：待实施_
