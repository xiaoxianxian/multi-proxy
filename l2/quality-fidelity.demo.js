'use strict';

// 质量工程 2.3 执行保真层 · 反向 + 正向用例
// 真跑：node l2/quality-fidelity.demo.js
//
// 覆盖：
//   纯函数：snapshotSubtask 深拷贝不联动 / diffFidelity 检出改样 / assertFidelity 硬拒
//   编排集成：fidelityCheck 开启 + 良性 executor → 无 _fidelityIssues、subtask done
//            fidelityCheck 开启 + 恶性 executor（改 prompt）→ 记 _fidelityIssues；fidelityThrow 时 subtask failed
//            fidelityCheck 关闭 + 恶性 executor → 零行为变更（不记录、不阻断）

const assert = require('assert');
const { snapshotSubtask, diffFidelity, assertFidelity } = require('./quality-fidelity.js');
const { Orchestrator } = require('./orchestrator.js');
const { templateDecompose } = require('./decomposer.js');

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

// ---- 纯函数 ----
console.log('纯函数：');
check('snapshotSubtask 深拷贝，改快照不影响原 subtask', () => {
    const st = { id: 'a', type: 'code', prompt: 'write', complexity: 'low', deps: [], params: { x: 1 } };
    const snap = snapshotSubtask(st);
    snap.params.x = 99; // 改快照
    assert.strictEqual(st.params.x, 1, '原 subtask 不应被联动改');
});

check('diffFidelity 检出 prompt 被改样', () => {
    const st = { id: 'a', type: 'code', prompt: 'write', complexity: 'low', deps: [], params: {} };
    const snap = snapshotSubtask(st);
    st.prompt = 'write [MUTATED]';
    const { ok, mutations } = diffFidelity(snap, st);
    assert.strictEqual(ok, false);
    assert.ok(mutations.some((m) => m.field === 'prompt'));
});

check('diffFidelity 良性透传 → ok', () => {
    const st = { id: 'a', type: 'code', prompt: 'write', complexity: 'low', deps: [], params: {} };
    const snap = snapshotSubtask(st);
    st.status = 'done'; // 附加字段，不算透传改样
    const { ok } = diffFidelity(snap, st);
    assert.strictEqual(ok, true, '附加字段不应触发 fidelity 告警');
});

check('assertFidelity 改样即抛', () => {
    const st = { id: 'a', type: 'code', prompt: 'write', complexity: 'low', deps: [], params: {} };
    const snap = snapshotSubtask(st);
    st.prompt = 'write [MUTATED]';
    assert.throws(() => assertFidelity(snap, st), /透传字段被改样/);
});

check('assertFidelity 良性不抛', () => {
    const st = { id: 'a', type: 'code', prompt: 'write', complexity: 'low', deps: [], params: {} };
    const snap = snapshotSubtask(st);
    assert.doesNotThrow(() => assertFidelity(snap, st));
});

// ---- 编排集成 ----
console.log('编排集成：');

function goodExecutor(st) { return { ok: true, got: st.prompt }; }
function badExecutor(st) { st.prompt = st.prompt + ' [MUTATED]'; return { ok: true, got: st.prompt }; }

function buildDag() {
    // 用 templateDecompose 产出一个合法 DAG（含 type/prompt/complexity/deps 形状）
    const dag = templateDecompose('写一个 jwt 认证');
    dag.subtasks.forEach((s) => { s.deps = s.deps || []; });
    return dag;
}

// 上面纯函数用例用同步 check()；编排集成涉及 await，统一在下方 async IIFE 覆盖。
(async () => {
    console.log('编排集成（async）：');

    await (async () => {
        const dag = buildDag();
        const orch = new Orchestrator({ executor: goodExecutor, shadowMode: false, fidelityCheck: true });
        const { report } = await orch.run(dag);
        try {
            assert.strictEqual(orch._fidelityIssues.length, 0, '良性 executor 不应产生保真告警');
            assert.ok(report.json.subtasks.every((s) => s.status === 'done'), '所有 subtask 应 done');
            console.log('  ✓ fidelityCheck 开启 + 良性 executor → 无 _fidelityIssues、subtask done');
            pass++;
        } catch (e) { console.log(`  ✗ ${e.message}`); fail++; }
    })();

    await (async () => {
        const dag = buildDag();
        const orch = new Orchestrator({ executor: badExecutor, shadowMode: false, fidelityCheck: true, fidelityThrow: false });
        const { report } = await orch.run(dag);
        try {
            assert.ok(orch._fidelityIssues.length >= 1, '恶性 executor 应记录保真告警');
            assert.ok(report.json.subtasks.every((s) => s.status === 'done'), 'fidelityThrow=false 时不阻断，subtask 仍 done');
            console.log('  ✓ fidelityCheck 开启 + 恶性 executor（fidelityThrow=false）→ 记 _fidelityIssues 但不阻断');
            pass++;
        } catch (e) { console.log(`  ✗ ${e.message}`); fail++; }
    })();

    await (async () => {
        const dag = buildDag();
        const orch = new Orchestrator({ executor: badExecutor, shadowMode: false, fidelityCheck: true, fidelityThrow: true });
        const { report } = await orch.run(dag);
        try {
            assert.ok(orch._fidelityIssues.length >= 1, '恶性 executor 应记录保真告警');
            // 正确语义：被改样的子任务 failed（error 即保真改样信息），其下游因依赖失败传播 skipped（2.1 机制）。
            const byId = Object.fromEntries(report.json.subtasks.map((s) => [s.id, s]));
            const failed = report.json.subtasks.filter((s) => s.status === 'failed');
            assert.ok(failed.length >= 1, '至少一个被改样的子任务应 failed');
            assert.ok(failed.every((s) => /透传字段被改样/.test(s.error || '')), 'failed 的 error 应为保真改样信息');
            assert.ok(report.json.subtasks.every((s) => s.status === 'failed' || s.status === 'skipped'), '改样链路不得谎报 done');
            assert.ok(report.json.subtasks.some((s) => s.status === 'skipped'), '下游依赖应被阻断为 skipped');
            console.log('  ✓ fidelityCheck 开启 + 恶性 executor（fidelityThrow=true）→ 改样子任务 failed、下游 skipped');
            pass++;
        } catch (e) { console.log(`  ✗ ${e.message}`); fail++; }
    })();

    await (async () => {
        const dag = buildDag();
        const orch = new Orchestrator({ executor: badExecutor, shadowMode: false, fidelityCheck: false });
        const { report } = await orch.run(dag);
        try {
            assert.strictEqual(orch._fidelityIssues.length, 0, 'fidelityCheck=false 时应零行为变更（不记录）');
            assert.ok(report.json.subtasks.every((s) => s.status === 'done'), 'fidelityCheck=false 时应零行为变更（不阻断）');
            console.log('  ✓ fidelityCheck 关闭 + 恶性 executor → 零行为变更（不记录、不阻断）');
            pass++;
        } catch (e) { console.log(`  ✗ ${e.message}`); fail++; }
    })();

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
})();
