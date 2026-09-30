'use strict';

// RoutingBase — L2 共享底座（质量工程 §三 / DESIGN-MEMO 落点 2）。
//
// 职责：把散落在 decomposer.js / route-engine.js / adapters/*.js 的「业务路由」硬编码
//   （需求→DAG 模板、complexity→tier 映射、adapter 默认能力/模型）收口到唯一可版本化数据源。
//
// 修订规则（铁律）：任何路由 / failover / 档位变更**只改这里**（或经 update()），
//   不许再改 decomposer.js / route-engine.js / adapters/*.js 的硬编码。
//
// 版本快照：每次 update() 自动把当前定义压入 history，rollback() 一键回上一版（只换一处）。
//
// 设计原则（与 l2 内核同构）：
//   - 零依赖：纯数据 + 小助手，不 require 任何项目模块（杜绝循环依赖）。
//   - 零行为变更：初始值与原各文件硬编码**逐字一致**（迁移即搬运，不改一个值）。
//   - 消费方实时读：templates/fallback 经 ROUTING_BASE 引用实时取值，update() 后即刻生效。

const ROUTING_BASE = {
    version: 1,
    updatedAt: '2026-09-30',
    note: '初始收口：从 decomposer.js / route-engine.js / claude-adapter.js / l1-agent-adapter.js 逐字迁移，零行为变更',

    // ---- 需求 → DAG 模板（原 l2/decomposer.js BUILTIN_TEMPLATES，逐字迁移）----
    templates: [
        {
            // 5.1 蓝图样例：FastAPI + JWT + 数据库 + 测试 —— 4 子任务线性依赖
            name: 'fastapi-jwt',
            match: (input) => /jwt|认证|fastapi/i.test(input),
            build: (input) => [
                { id: 'design-api', type: 'code', complexity: 'low', prompt: `设计 API 接口（${input.slice(0, 40)}）`, deps: [] },
                { id: 'db-model', type: 'code', complexity: 'medium', prompt: '实现数据库模型', deps: ['design-api'] },
                { id: 'auth-jwt', type: 'code', complexity: 'medium', prompt: '实现 JWT 认证', deps: ['db-model'] },
                { id: 'unit-test', type: 'test', complexity: 'low', prompt: '写单元测试', deps: ['auth-jwt'] },
            ],
        },
        {
            // 视频创作工作流（蓝图 4.8 指定 case）：理解诉求 → 拆镜 → 生成 → 合成
            name: 'video-workflow',
            match: (input) => /视频|短片|视频创作|video/i.test(input),
            build: (input) => [
                { id: 'understand', type: 'plan', complexity: 'low', prompt: `理解视频诉求（${input.slice(0, 40)}）`, deps: [] },
                { id: 'storyboard', type: 'plan', complexity: 'medium', prompt: '分镜脚本', deps: ['understand'] },
                { id: 'gen-clip-a', type: 'video', complexity: 'high', prompt: '生成片段 A', deps: ['storyboard'] },
                { id: 'gen-clip-b', type: 'video', complexity: 'high', prompt: '生成片段 B', deps: ['storyboard'] },
                { id: 'compose', type: 'compose', complexity: 'high', prompt: '合成 + 音频', deps: ['gen-clip-a', 'gen-clip-b'] },
            ],
        },
    ],

    // ---- 兜底模板（原 l2/decomposer.js FALLBACK_TEMPLATE，逐字迁移）----
    fallback: {
        name: 'single',
        match: () => true,
        build: (input) => [{ id: 'main', type: 'code', complexity: 'medium', prompt: String(input).slice(0, 80), deps: [] }],
    },

    // ---- complexity → modelTier（原 l2/route-engine.js _mapTier，逐字迁移）----
    complexityTierMap: { low: 'small', medium: 'medium', high: 'large' },

    // ---- adapter 默认能力/模型（原 claude-adapter.js:87/:213、l1-agent-adapter.js:78/:183，逐字迁移）----
    adapterDefaults: {
        claude: { capabilities: ['code', 'writing'], defaultModel: 'claude-3-5-sonnet-latest' },
        'l1-agent': { capabilities: ['code', 'writing'], defaultModel: 'default' },
    },
};

// 快照历史（仅内存；单进程语义，与 agent-registry 默认内存同构）
const _history = [];

function _snapshotCurrent() {
    return {
        version: ROUTING_BASE.version,
        updatedAt: ROUTING_BASE.updatedAt,
        note: ROUTING_BASE.note,
        templates: ROUTING_BASE.templates,
        fallback: ROUTING_BASE.fallback,
        complexityTierMap: ROUTING_BASE.complexityTierMap,
        adapterDefaults: ROUTING_BASE.adapterDefaults,
    };
}

// 复杂度 → 档位（消费方：route-engine._mapTier 委托到此；未知 complexity 归 medium）
function mapTier(complexity) {
    const m = ROUTING_BASE.complexityTierMap || {};
    return m[complexity] || 'medium';
}

// adapter 默认声明（消费方：claude-adapter / l1-agent-adapter 构造与 invoke 默认值）
function adapterDefaults(adapterId) {
    return (ROUTING_BASE.adapterDefaults && ROUTING_BASE.adapterDefaults[adapterId]) || null;
}

// 修订：浅合并 patch → version+1，旧版自动进快照历史。返回新 version。
function update(patch, note) {
    if (!patch || typeof patch !== 'object') throw new Error('routing-base.update: patch object required');
    _history.push(_snapshotCurrent());
    for (const k of ['templates', 'fallback', 'complexityTierMap', 'adapterDefaults']) {
        if (patch[k] !== undefined) ROUTING_BASE[k] = patch[k];
    }
    ROUTING_BASE.version += 1;
    ROUTING_BASE.updatedAt = new Date().toISOString().slice(0, 10);
    ROUTING_BASE.note = note || ROUTING_BASE.note;
    return ROUTING_BASE.version;
}

// 回滚：恢复到最近一次 update 前的定义。无历史返回 null。
function rollback() {
    if (!_history.length) return null;
    const prev = _history.pop();
    ROUTING_BASE.templates = prev.templates;
    ROUTING_BASE.fallback = prev.fallback;
    ROUTING_BASE.complexityTierMap = prev.complexityTierMap;
    ROUTING_BASE.adapterDefaults = prev.adapterDefaults;
    ROUTING_BASE.version = prev.version;
    ROUTING_BASE.updatedAt = prev.updatedAt;
    ROUTING_BASE.note = prev.note;
    return ROUTING_BASE.version;
}

// 历史概览（版本/日期/备注，不含全量数据）
function history() {
    return _history.map((h) => ({ version: h.version, updatedAt: h.updatedAt, note: h.note }));
}

module.exports = { ROUTING_BASE, mapTier, adapterDefaults, update, rollback, history };
