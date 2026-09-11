'use strict';

// Route Engine — L2 编排引擎核心（P1 增量 1）
// 职责：按能力标签路由任务到候选 adapter，支持 shadow 模式。
//
// 设计原则（与 Agent Registry + Plugin Runtime 同构）：
//   - 非侵入④：只读 Registry + Plugin Runtime，不修改 agent 任何文件。
//   - Shadow 模式先行：默认不执行真实任务，只记录路由决策日志。
//   - 可注入：registry/pluginRuntime 可注入，便于测试。
//   - 能力优先级：按 capabilities 数组顺序排序候选（更具体的 tag 排前）。

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

        // 查询 Registry 中具备该能力的 agent profile
        const registryProfiles = this.registry ? this.registry.byCapability(task.type) : [];

        // 查询 Plugin Runtime 中已启动的插件能力
        const pluginCaps = this.pluginRuntime.listCapabilities();

        // 合并候选：从 Registry 和 Plugin Runtime 中提取 adapter 信息
        const candidateMap = new Map();

        for (const profile of registryProfiles) {
            if (profile.adapterId) {
                candidateMap.set(profile.adapterId, {
                    adapterId: profile.adapterId,
                    source: 'registry',
                    confidence: this._calcConfidence(profile.capabilityTags, task.type),
                });
            }
        }

        for (const cap of pluginCaps) {
            if (!candidateMap.has(cap.plugin)) {
                candidateMap.set(cap.plugin, {
                    adapterId: cap.plugin,
                    source: 'plugin',
                    confidence: this._calcConfidence([cap.capability], task.type),
                });
            }
        }

        decision.candidates = [...candidateMap.values()].sort((a, b) => b.confidence - a.confidence);
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

    _calcConfidence(tags, targetType) {
        if (!Array.isArray(tags)) return 0;
        return tags.includes(targetType) ? 1 : 0;
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
