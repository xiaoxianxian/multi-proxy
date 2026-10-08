// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// Impact — L2 影响半径重跑（质量工程 §四 / DESIGN-MEMO 落点 3：原则 4「按影响半径重跑」）。
//
// 职责：L2 编排逻辑 / 路由定义改动后，判定「本次改动影响哪些子任务 / 用例」，
//   只重跑受影响范围，其余复用既有结果，控制返修代价。
//
// 判定依据（可解释，不是黑盒）：
//   - DAG 内：deps 反向闭包（orchestrator 依赖传播的同构图论）——改动节点影响它自己和全部下游。
//   - 跨模块：adapter 改动经 routing-base.adapterDefaults 的 capabilities 映射到子任务 type；
//     template 改动按 dag.template.name 命中；未知 / core 改动 fail-closed 全量（不漏判）。
//
// 设计原则（与 l2 内核同构）：零依赖（routing-base 是纯数据模块，无循环）；无副作用（纯计算 + 复用 seed）。

const { adapterDefaults } = require('./knowledge-base/routing-base.js');

// ---- DAG 内影响：seed（含自身）+ 全部传递下游（deps 反向闭包）----

function downstreamClosure(subtasks, seedIds) {
    const seeds = new Set(seedIds);
    for (const id of seeds) {
        if (!subtasks.some((s) => s.id === id)) throw new Error(`impact: seed id "${id}" not in dag`);
    }
    // 反向邻接：dep -> 直接依赖它的子任务
    const dependents = new Map();
    for (const s of subtasks) {
        for (const d of s.deps || []) {
            if (!dependents.has(d)) dependents.set(d, []);
            dependents.get(d).push(s.id);
        }
    }
    // BFS 下游闭包
    const affected = new Set(seeds);
    const queue = [...seeds];
    while (queue.length) {
        const cur = queue.shift();
        for (const next of dependents.get(cur) || []) {
            if (!affected.has(next)) { affected.add(next); queue.push(next); }
        }
    }
    return [...affected];
}

// ---- 改动 → 受影响子任务（可解释判定）----

// change 形态：
//   { kind: 'subtask', ids: ['a','b'] }        —— 直接改了某些子任务定义
//   { kind: 'adapter', adapterId: 'claude' }   —— 改了某 adapter（能力/模型/failover）
//   { kind: 'template', name: 'fastapi-jwt' }  —— 改了某拆解模板
//   { kind: 'tier' }                           —— 改了 complexity→tier 映射（所有路由决策可能变）
//   { kind: 'core' }                           —— 改了编排内核本身（fail-closed 全量）
// 返回 { affected, reused, reason }：affected/reused 为子任务 id 数组，reason 为人读解释。
function computeDagImpact(dag, change) {
    const subtasks = dag.subtasks;
    const allIds = subtasks.map((s) => s.id);

    const seedByType = (types) => subtasks.filter((s) => types.includes(s.type)).map((s) => s.id);

    switch (change && change.kind) {
        case 'subtask': {
            if (!Array.isArray(change.ids) || !change.ids.length) {
                return { affected: allIds, reused: [], reason: 'change.kind=subtask 但 ids 为空 → fail-closed 全量' };
            }
            const affected = downstreamClosure(subtasks, change.ids);
            return { affected, reused: allIds.filter((id) => !affected.includes(id)), reason: `子任务 [${change.ids.join(',')}] 及其下游` };
        }
        case 'adapter': {
            const def = adapterDefaults(change.adapterId);
            if (!def) {
                // 未知 adapter（registry 注册态不明）→ 不能断言无关，fail-closed
                return { affected: allIds, reused: [], reason: `adapter "${change.adapterId}" 不在 routing-base.adapterDefaults → fail-closed 全量` };
            }
            const seeds = seedByType(def.capabilities);
            if (!seeds.length) {
                return { affected: [], reused: allIds, reason: `adapter "${change.adapterId}" 能力 [${def.capabilities.join(',')}] 与本 DAG 无交集 → 全部复用` };
            }
            const affected = downstreamClosure(subtasks, seeds);
            return { affected, reused: allIds.filter((id) => !affected.includes(id)), reason: `adapter "${change.adapterId}" 能力 [${def.capabilities.join(',')}] 命中 type [${[...new Set(seeds.map((id) => subtasks.find((s) => s.id === id).type))].join(',')}]，含下游` };
        }
        case 'template': {
            if (dag.template === change.name) {
                return { affected: allIds, reused: [], reason: `本 DAG 由模板 "${change.name}" 生成 → 全量重跑` };
            }
            return { affected: [], reused: allIds, reason: `本 DAG 模板为 "${dag.template || '(fallback)'}" ≠ "${change.name}" → 全部复用` };
        }
        case 'tier':
            return { affected: allIds, reused: [], reason: 'complexity→tier 映射变更影响所有子任务的路由决策 → 全量重跑' };
        case 'core':
            return { affected: allIds, reused: [], reason: '编排内核变更 → fail-closed 全量重跑' };
        default:
            return { affected: allIds, reused: [], reason: `未知改动 ${JSON.stringify(change)} → fail-closed 全量重跑` };
    }
}

// ---- 影响半径重跑：未受影响的复用 prevResults（seedResults 预置），只执行受影响 ----

async function runImpact(orchestrator, dag, prevResults, change, opts = {}) {
    const impact = computeDagImpact(dag, change);
    const seedResults = {};
    for (const id of impact.reused) {
        const prev = prevResults && prevResults[id];
        if (prev && prev.status === 'done') seedResults[id] = { ...prev, reused: true };
        else {
            // prev 缺失或非 done → 该节点实际上无法复用，降级为重跑（并入 affected）
            impact.affected.push(id);
            impact.reason += `；${id} 无可复用结果 → 降级重跑`;
        }
    }
    const { results, report } = await orchestrator.run(dag, { ...opts, seedResults });
    return { results, report, impact };
}

module.exports = { downstreamClosure, computeDagImpact, runImpact };
