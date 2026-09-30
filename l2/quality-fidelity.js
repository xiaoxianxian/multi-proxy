'use strict';

// 质量工程 2.3 · 执行保真层（与 contract.js / semantic-review.js 同构，零依赖）。
//
// 防什么：最终下发给下游 executor 的 subtask 透传字段（prompt / type / complexity /
//          deps / params）被后处理悄悄改样——如 retry / fallback / knowledge 注入
//          或 executor 本身误改了 st.prompt，导致"交付变样"。
//
// 用法：orchestrator._invoke 在调用 executor 前 snapshotSubtask(st)，executor 返回后
//      diffFidelity(snap, st) 比对；有改动则记 this._fidelityIssues，fidelityThrow 时硬拒。
//
// 与 2.1/2.2 的边界：
//   2.1 验「形状契约」（进执行前）；2.2 验「语义路由」（进执行前）；
//   2.3 验「执行保真」（进执行后、交付前）——只比对，不阻断正常流程，除非显式开启 fidelityThrow。

// 透传字段白名单：这些是 DAG 节点的"原值"。任何后处理只能【附加】新字段（value/status/...），
// 不得改这些。knowledge 注入走独立变量（见 knowledge-base.js 变量隔离约定），不在此列。
const PASSTHROUGH_FIELDS = ['type', 'prompt', 'complexity', 'deps', 'params', 'knowledgeQuery'];

function _clone(v) {
    if (v === null || v === undefined) return v;
    if (typeof v === 'object') {
        try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
    }
    return v;
}

function _equal(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === 'object') {
        try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
    }
    return false;
}

// 对 subtask 透传字段做不可变快照（深拷贝，防止后续引用被连带改）。
function snapshotSubtask(st) {
    const snap = { id: st && st.id };
    for (const f of PASSTHROUGH_FIELDS) snap[f] = _clone(st ? st[f] : undefined);
    return snap;
}

// 比对快照与执行后的 subtask，返回 { ok, mutations: [{field, before, after}] }。
function diffFidelity(snapshot, st) {
    const mutations = [];
    for (const f of PASSTHROUGH_FIELDS) {
        const before = snapshot ? snapshot[f] : undefined;
        const after = st ? st[f] : undefined;
        if (!_equal(before, after)) mutations.push({ field: f, before, after });
    }
    return { ok: mutations.length === 0, mutations };
}

// error 级硬拒：透传字段被改样即抛。
function assertFidelity(snapshot, st) {
    const { ok, mutations } = diffFidelity(snapshot, st);
    if (!ok) {
        const detail = mutations
            .map((m) => `${m.field}: ${JSON.stringify(m.before)} → ${JSON.stringify(m.after)}`)
            .join('; ');
        throw new Error(`fidelity: subtask ${st && st.id} 透传字段被改样: ${detail}`);
    }
    return true;
}

module.exports = { PASSTHROUGH_FIELDS, snapshotSubtask, diffFidelity, assertFidelity };
