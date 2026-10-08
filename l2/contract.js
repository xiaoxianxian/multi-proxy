// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// contract.js — L2 事实绑定层（质量工程规范 2.1）的子任务契约校验。
// 职责（与 l2/ 既有内核同构：零依赖 / 非侵入 / 可注入）：
//   在编排进入执行（_executeSubtask / run）之前，对子任务做「形状契约」核验，
//   挡住引用错 / 参数错（type/prompt/complexity/deps 形参非法），先于一切下游 adapter 调用。
//
// 边界（重要，避免与开放接入设计矛盾）：
//   本层只做「事实绑定（形状契约）」，不判断「type 是否可被某 adapter 路由」——
//   那是 2.2 语义审阅层的职责。type 本质是 capability tag，开放接入设计下不收口为枚举，
//   故这里只校验 type 是「非空字符串」，不拒绝未知 capability（未知能否路由归语义层）。

const SUBTASK_COMPLEXITY = ['low', 'medium', 'high'];

// 校验单个子任务形状契约；非法直接 throw（错误信息指明字段）。合法返回 st 本身。
function validateSubtask(st) {
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
        throw new Error('subtask must be a plain object');
    }
    if (typeof st.id !== 'string' || !st.id.trim()) {
        throw new Error('subtask.id required (non-empty string)');
    }
    if (typeof st.type !== 'string' || !st.type.trim()) {
        throw new Error('subtask.type required (non-empty string)');
    }
    // prompt 必须存在且为字符串；允许空串（空 prompt「是否该派发」归 2.2 语义审阅层）。
    if (st.prompt === undefined || st.prompt === null || typeof st.prompt !== 'string') {
        throw new Error('subtask.prompt required (string)');
    }
    if (st.complexity !== undefined && !SUBTASK_COMPLEXITY.includes(st.complexity)) {
        throw new Error(`subtask.complexity must be one of ${SUBTASK_COMPLEXITY.join('/')}`);
    }
    if (!Array.isArray(st.deps)) {
        throw new Error('subtask.deps must be an array');
    }
    for (const d of st.deps) {
        if (typeof d !== 'string') throw new Error('subtask.deps entries must be strings');
    }
    return st;
}

// 校验整图：每个子任务形状 + 依赖 id 必须存在 + id 不重复。
function validateDag(dag) {
    if (!dag || !Array.isArray(dag.subtasks)) {
        throw new Error('dag.subtasks required (array)');
    }
    const ids = new Set();
    for (const st of dag.subtasks) {
        validateSubtask(st);
        if (ids.has(st.id)) throw new Error(`duplicate subtask id: ${st.id}`);
        ids.add(st.id);
    }
    for (const st of dag.subtasks) {
        for (const dep of st.deps) {
            if (!ids.has(dep)) throw new Error(`subtask ${st.id} deps on unknown id ${dep}`);
        }
    }
    return dag;
}

module.exports = { validateSubtask, validateDag, SUBTASK_COMPLEXITY };
