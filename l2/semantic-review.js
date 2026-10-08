// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// semantic-review.js — L2 语义审阅层（质量工程规范 2.2）。
// 职责（与 l2/contract.js 及既有内核同构：零依赖 / 非侵入 / 可注入）：
//   在编排真正派发 adapter 之前，对「拆解产物」与「路由决策」做语义核验，
//   挡住"事实绑定（2.1 形状契约）过了但语义错"的情况——
//   典型：把图像/视频任务派给纯文本 adapter（模态不匹配）、或某 type 当前无任何可路由 adapter。
//
// 与 2.1 的边界（重要，避免与开放接入设计矛盾）：
//   2.1（contract.js）只验形状：type 是非空字符串即可，因为 type 是开放 capability tag，不收口枚举；
//   2.2（本文件）验语义：type 是否真能被某 adapter 接（capability tag 命中）、选中的 adapter 模态/档位是否匹配。
//
// 不变量：本层默认不抛错，只产出 issues（与 shadow 零副作用一致）。
//   调用方需要"硬拒"时显式调 assertSemantic(issues)（仅当存在 level==='error' 才抛）。
//   翻热路径前，orchestrator / route-engine 可开 semanticThrow 把 error 级语义问题挡在派发前。

// 模态推断（与 route-engine._inferModelType 对齐；本地复制以避免跨模块耦合）。
function inferModelType(taskType) {
    if (['vision', 'image', 'video', 'text2video'].includes(taskType)) return 'multimodal';
    if (['audio', 'tts', 'stt'].includes(taskType)) return 'audio';
    return 'text';
}

// 候选能力集合：从 registry（agent profile）与 pluginRuntime（插件能力）合并出"能接某 type 的 adapter 列表"。
// 与 route-engine.route() 的候选合并逻辑同构（只取"capability 能否接该 type"，不计入 confidence/排序）。
function routeableAdaptersFor(type, { registry, pluginRuntime } = {}) {
    const found = [];
    const profiles = (registry && typeof registry.list === 'function') ? registry.list() : [];
    for (const p of profiles) {
        if (p && p.adapterId && Array.isArray(p.capabilityTags) && p.capabilityTags.includes(type)) {
            found.push({ adapterId: p.adapterId, source: 'registry' });
        }
    }
    const caps = (pluginRuntime && typeof pluginRuntime.listCapabilities === 'function') ? pluginRuntime.listCapabilities() : [];
    for (const c of caps) {
        if (c && c.plugin && Array.isArray(c.capability) && c.capability.includes(type) && !found.some((f) => f.adapterId === c.plugin)) {
            found.push({ adapterId: c.plugin, source: 'plugin' });
        }
    }
    return found;
}

// 2.2a 拆解产物语义审阅：每个子任务的 type 是否至少有 1 个可路由 adapter。
//   未命中 → level 'warn'（诊断：当前未注册对应能力的 adapter；shadow 下非阻塞，适配器可后续热插拔补上）。
//   不产出 'error'（拆解产物本身不决定派发，是否真派发归 route 决策审阅）。
// 返回 { ok, issues }。ok 恒为 true（拆解审阅只诊断），结构与其余层一致。
function reviewDecomposition(dag, opts = {}) {
    const issues = [];
    if (!dag || !Array.isArray(dag.subtasks)) {
        issues.push({ level: 'error', subtaskId: null, message: 'reviewDecomposition: dag.subtasks required (array)' });
        return { ok: false, issues };
    }
    for (const st of dag.subtasks) {
        const type = st && st.type;
        const candidates = routeableAdaptersFor(type, opts);
        if (candidates.length === 0) {
            issues.push({
                level: 'warn',
                subtaskId: st ? st.id : null,
                message: `no routeable adapter for capability "${type}" — subtask ${st ? st.id : '?'} will have no candidate at route time (adapters may be hot-plugged later)`,
            });
        }
    }
    return { ok: issues.every((i) => i.level !== 'error'), issues };
}

// 2.2b 路由决策语义审阅：选中的 adapter 是否真能接这活。
//   - chosen 为 null（无候选）→ 'error'（根本派不出去）。
//   - 任务需 multimodal（vision/image/video）但 chosen.modelTypeMatch===false → 'error'（会把图像任务派给纯文本 adapter）。
//   - 高复杂度（expectedTier==='large'）但 chosen.tierMatch===false → 'warn'（无档位匹配 adapter，质量可能降级，非硬错）。
// 返回 { ok, issues }。ok = 无 error 级。
function reviewRouteDecision(decision, task) {
    const issues = [];
    if (!decision) {
        issues.push({ level: 'error', subtaskId: task && task.id || null, message: 'reviewRouteDecision: decision missing' });
        return { ok: false, issues };
    }
    const chosen = decision.chosen;
    if (!chosen) {
        const mt = inferModelType(task && task.type);
        issues.push({
            level: 'error',
            subtaskId: task && task.id || null,
            message: `no candidate adapter for task.type="${task && task.type}" (modality=${mt}) — refusing to dispatch`,
        });
        return { ok: false, issues };
    }
    const needModality = inferModelType(task && task.type);
    if (needModality === 'multimodal' && chosen.modelTypeMatch === false) {
        issues.push({
            level: 'error',
            subtaskId: task && task.id || null,
            message: `modality mismatch: task.type="${task && task.type}" needs multimodal but chosen adapter "${chosen.adapterId}" is text-only (modelTypeMatch=false)`,
        });
    }
    if (decision.expectedTier === 'large' && chosen.tierMatch === false) {
        issues.push({
            level: 'warn',
            subtaskId: task && task.id || null,
            message: `tier gap: high-complexity task expected tier 'large' but chosen adapter "${chosen.adapterId}" has no matching modelTier — quality may degrade`,
        });
    }
    return { ok: issues.every((i) => i.level !== 'error'), issues };
}

// 硬拒：存在 error 级 issue 即抛。warn 级不抛（诊断用）。
function assertSemantic(issues) {
    const errs = (issues || []).filter((i) => i.level === 'error');
    if (errs.length) {
        throw new Error('semantic-review: ' + errs.map((e) => e.message).join('; '));
    }
    return true;
}

module.exports = { reviewDecomposition, reviewRouteDecision, assertSemantic, inferModelType, routeableAdaptersFor };
