'use strict';

// Route Engine — L2 编排引擎核心（P1 增量 1）
// 职责：按能力标签 + 模型类型 + 模型档位路由任务到候选 adapter，支持 shadow 模式。
//
// 设计原则（与 Agent Registry + Plugin Runtime 同构）：
//    - 非侵入④：只读 Registry + Plugin Runtime，不修改 agent 任何文件。
//    - Shadow 模式先行：默认不执行真实任务，只记录路由决策日志。
//    - 可注入：registry/pluginRuntime 可注入，便于测试。
//    - 模型类型优先：multimodal 任务优先匹配 multimodal 代理（避免文本代理误接图像任务）。
//    - 复杂度档位（complexity→modelTier）：按任务难度选最合适的模型档位。
//      decomposer 已在子任务打上 complexity（low/medium/high），route() 消费它映射到
//      档位（small/medium/large）。见 l2/COMPLEXITY-MODE.md。
//      关键：tierMatch 只对**显式声明了 modelTier** 的 profile 生效——
//      未设 modelTier 的 profile 不参与档位加分，行为完全不变（向后兼容旧 profile）。

const { MODEL_TIERS, DEFAULT_TIER } = require('./agent-registry');

const DEFAULT_LOG_CAPACITY = 100;

class RouteEngine {
    constructor({ registry, pluginRuntime, shadowMode = true, logCapacity = DEFAULT_LOG_CAPACITY } = {}) {
        this.registry = registry;
        this.pluginRuntime = pluginRuntime || { listCapabilities: () => [] };
        this.shadowMode = shadowMode;
        this.log = []; // 路由决策日志，最多 logCapacity 条
        this.logCapacity = logCapacity;
     }

     // 按任务类型路由：返回候选 adapter 列表 + 路由决策日志
    route(task) {
        if (!task || !task.type) throw new Error('task.type required');

        const decision = {
            timestamp: new Date().toISOString(),
            taskId: task.id || null,
            taskType: task.type,
            taskPrompt: task.prompt ? (typeof task.prompt === 'string' ? task.prompt.slice(0, 50) : '...') : null,
            candidates: [],
            chosen: null,
            shadowMode: this.shadowMode,
            action: 'log-only', // log-only | execute
         };

         // 解析期望的模型类型（模态维度）
        const expectedModelType = task.modelType || this._inferModelType(task.type);

         // 解析期望的模型档位（复杂度维度，complexity 路由的落点）
         const expectedTier = this._mapTier(task.complexity);
         decision.expectedTier = expectedTier; // 记录期望档位，供消费者/日志/审计

         // 查询 Registry 中具备该能力的 agent profile
        const allProfiles = this.registry ? this.registry.list() : [];

         // 查询 Plugin Runtime 中已启动的插件能力
        const pluginCaps = this.pluginRuntime.listCapabilities();

         // 合并候选：从 Registry 和 Plugin Runtime 中提取 adapter 信息
        const candidateMap = new Map();

        for (const profile of allProfiles) {
            if (profile.adapterId) {
                 // 精确匹配：modelType + capabilityTags + modelTier
                const modelMatch = profile.modelType === expectedModelType;
                const tagMatch = Array.isArray(profile.capabilityTags) && profile.capabilityTags.includes(task.type);
                // tierMatch：仅当 profile 显式声明了 modelTier 且匹配期望档位时为 true。
                // 未设 modelTier 的 profile 不参与档位加分（向后兼容旧 profile 行为不变）。
                const tierMatch = profile.modelTier !== undefined && profile.modelTier === expectedTier;

                if (tagMatch) {
                    candidateMap.set(profile.adapterId, {
                        adapterId: profile.adapterId,
                        source: 'registry',
                        confidence: this._calcConfidence(profile.capabilityTags, task.type, profile.modelType, expectedModelType, tierMatch),
                        modelTypeMatch: modelMatch,
                        tierMatch,
                        modelTier: profile.modelTier !== undefined ? profile.modelTier : null,
                        expectedTier,
                     });
                 }
             }
         }

        for (const cap of pluginCaps) {
            if (!candidateMap.has(cap.plugin)) {
                // plugin 无 modelTier 概念，tierMatch=false（不参与档位加分）
                candidateMap.set(cap.plugin, {
                    adapterId: cap.plugin,
                    source: 'plugin',
                    confidence: this._calcConfidence([cap.capability], task.type, null, expectedModelType, false),
                    modelTypeMatch: false,
                    tierMatch: false,
                    modelTier: null,
                    expectedTier,
                 });
             }
         }

         // 排序：modelTypeMatch（真 > 假）→ tierMatch（真 > 假）→ confidence
        decision.candidates = [...candidateMap.values()].sort((a, b) => {
            if (a.modelTypeMatch !== b.modelTypeMatch) {
                return a.modelTypeMatch ? -1 : 1;
             }
            if (a.tierMatch !== b.tierMatch) {
                return a.tierMatch ? -1 : 1;
             }
            return b.confidence - a.confidence;
         });
        decision.chosen = decision.candidates[0] || null;

         // Shadow 模式：只记录，不执行
        if (!this.shadowMode && decision.chosen) {
            decision.action = 'execute';
            decision.execution = this._execute(decision.chosen.adapterId, task);
         }

        this._pushLog(decision);
        return decision;
     }

     // 批量路由：对任务列表依次路由
    batchRoute(tasks) {
        return tasks.map(task => this.route(task));
     }

     // 启用/禁用 shadow 模式
    setShadowMode(on) {
        this.shadowMode = on;
     }

     // 获取路由日志（最近 N 条）
    getLogs(limit = 20) {
        return this.log.slice(-limit);
     }

     // 清空调用
    clearLogs() {
        this.log = [];
     }

     // ---- 私有方法 ----

     // 启发式推导任务期望的模型类型（模态维度）
    _inferModelType(taskType) {
        if (['vision', 'image', 'video', 'text2video'].includes(taskType)) return 'multimodal';
        if (['audio', 'tts', 'stt'].includes(taskType)) return 'audio';
        return 'text';
     }

     // 复杂度 → 档位映射（complexity 路由，见 l2/COMPLEXITY-MODE.md §2.2）
     // high 不降级（质量优先），默认/未知 → medium（保守）。
     // 本期静态（decomposer 标签）；二期 LLM judge 动态复判，接口预留于此。
    _mapTier(complexity) {
        if (complexity === 'low') return 'small';
        if (complexity === 'high') return 'large';
        return DEFAULT_TIER; // 'medium'（默认 / 未知 → 不降级）
     }

     // 校验档位合法性（二期 LLM judge 复判后、或外部传入 tier 时校验用）
     isValidTier(tier) {
        return MODEL_TIERS.has(tier);
     }

     // confidence 计算：capabilityTags 命中 +1 / modelType 命中 +1 / modelTier 命中 +1
     _calcConfidence(tags, targetType, profileModelType, expectedModelType, tierMatch = false) {
        let score = 0;
        if (tags.includes(targetType)) score += 1;
        if (profileModelType === expectedModelType) score += 1;
        if (tierMatch) score += 1;
        return score;
     }

     _pushLog(decision) {
        this.log.push(decision);
        if (this.log.length > this.logCapacity) {
            this.log = this.log.slice(-this.logCapacity);
         }
     }

    async _execute(adapterId, task) {
         // 预留：真实执行逻辑（未来接入 Adapter Runner）
        return { adapterId, status: 'queued' };
     }
}

module.exports = { RouteEngine };
