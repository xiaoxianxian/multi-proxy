'use strict';

// 影响半径重跑（质量工程 §四）反向 + 正向用例。
// 跑法：node l2/impact.demo.js —— 全绿 exit 0。

const assert = require('assert');
const { Orchestrator } = require('./orchestrator.js');
const { downstreamClosure, computeDagImpact, runImpact } = require('./impact.js');
const { templateDecompose } = require('./decomposer.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${e.message}`); fail++; }
}
const setOf = (arr) => new Set(arr);

// 固定 DAG（值与 routing-base 模板一致，避免依赖共享底座可变性）
function fastapiDag() {
    return {
        input: '做一个 jwt 认证',
        template: 'fastapi-jwt',
        subtasks: [
            { id: 'design-api', type: 'code', complexity: 'low', prompt: '设计 API 接口', deps: [] },
            { id: 'db-model', type: 'code', complexity: 'medium', prompt: '实现数据库模型', deps: ['design-api'] },
            { id: 'auth-jwt', type: 'code', complexity: 'medium', prompt: '实现 JWT 认证', deps: ['db-model'] },
            { id: 'unit-test', type: 'test', complexity: 'low', prompt: '写单元测试', deps: ['auth-jwt'] },
        ],
    };
}
function videoDag() {
    return {
        input: '做一个短片',
        template: 'video-workflow',
        subtasks: [
            { id: 'understand', type: 'plan', complexity: 'low', prompt: '理解视频诉求', deps: [] },
            { id: 'storyboard', type: 'plan', complexity: 'medium', prompt: '分镜脚本', deps: ['understand'] },
            { id: 'gen-clip-a', type: 'video', complexity: 'high', prompt: '生成片段 A', deps: ['storyboard'] },
            { id: 'gen-clip-b', type: 'video', complexity: 'high', prompt: '生成片段 B', deps: ['storyboard'] },
            { id: 'compose', type: 'compose', complexity: 'high', prompt: '合成 + 音频', deps: ['gen-clip-a', 'gen-clip-b'] },
        ],
    };
}

console.log('== §四 影响半径：downstreamClosure ==');

check('线性链 seed 根 → 自身+全部下游', () => {
    const dag = fastapiDag();
    assert.deepStrictEqual(setOf(downstreamClosure(dag.subtasks, ['design-api'])), setOf(['design-api', 'db-model', 'auth-jwt', 'unit-test']));
});
check('线性链 seed 中段 → 不含上游', () => {
    const dag = fastapiDag();
    assert.deepStrictEqual(setOf(downstreamClosure(dag.subtasks, ['db-model'])), setOf(['db-model', 'auth-jwt', 'unit-test']));
});
check('扇入 DAG seed 单分支 → 只含该分支下游，不波及兄弟', () => {
    const dag = videoDag();
    assert.deepStrictEqual(setOf(downstreamClosure(dag.subtasks, ['gen-clip-a'])), setOf(['gen-clip-a', 'compose']));
});
check('反向：未知 seed id → 报错（不静默漏判）', () => {
    const dag = fastapiDag();
    assert.throws(() => downstreamClosure(dag.subtasks, ['nope']), /not in dag/);
});

console.log('== §四 影响半径：computeDagImpact（可解释判定）==');

check('adapter:claude（能力 code/writing）命中 fastapi DAG → code 种子+下游=全部', () => {
    const imp = computeDagImpact(fastapiDag(), { kind: 'adapter', adapterId: 'claude' });
    assert.deepStrictEqual(setOf(imp.affected), setOf(['design-api', 'db-model', 'auth-jwt', 'unit-test']));
    assert.strictEqual(imp.reused.length, 0);
    assert.ok(/claude/.test(imp.reason), 'reason 应提到 adapter id');
});
check('adapter:claude 与 video DAG（plan/video/compose）无交集 → 全部复用', () => {
    const imp = computeDagImpact(videoDag(), { kind: 'adapter', adapterId: 'claude' });
    assert.deepStrictEqual(imp.affected, []);
    assert.strictEqual(imp.reused.length, 5);
    assert.ok(/无交集/.test(imp.reason));
});
check('adapter 未知 → fail-closed 全量（不断言无关）', () => {
    const imp = computeDagImpact(videoDag(), { kind: 'adapter', adapterId: 'mystery' });
    assert.strictEqual(imp.affected.length, 5);
    assert.ok(/fail-closed/.test(imp.reason));
});
check('template 命中 → 全量重跑；不命中 → 全部复用', () => {
    const a = computeDagImpact(fastapiDag(), { kind: 'template', name: 'fastapi-jwt' });
    assert.strictEqual(a.affected.length, 4);
    const b = computeDagImpact(videoDag(), { kind: 'template', name: 'fastapi-jwt' });
    assert.deepStrictEqual(b.affected, []);
    assert.strictEqual(b.reused.length, 5);
});
check('tier / core / 未知改动 → 全量（fail-closed）', () => {
    assert.strictEqual(computeDagImpact(videoDag(), { kind: 'tier' }).affected.length, 5);
    assert.strictEqual(computeDagImpact(videoDag(), { kind: 'core' }).affected.length, 5);
    assert.strictEqual(computeDagImpact(videoDag(), { kind: 'whatever' }).affected.length, 5);
});

console.log('== §四 影响半径：runImpact（只重跑受影响，其余复用）==');

(async () => {
    // 计数 executor：记录实际执行的子任务 id
    function countingExecutor() {
        const calls = [];
        const fn = (st) => { calls.push(st.id); return { ok: true, via: st.id }; };
        fn.calls = calls;
        return fn;
    }

    // 混合 DAG：v1(video) → c1(code)。claude 只命中 c1 → v1 应复用。
    const mixedDag = {
        input: 'mixed',
        template: 'mixed',
        subtasks: [
            { id: 'v1', type: 'video', complexity: 'low', prompt: '生成片段', deps: [] },
            { id: 'c1', type: 'code', complexity: 'low', prompt: '写代码', deps: ['v1'] },
        ],
        edges: [['v1', 'c1']], // hasCycle 消费的 [from, to] 元组
    };

    // 首跑：全量执行
    const orch1 = new Orchestrator({ executor: countingExecutor(), shadowMode: false });
    const first = await orch1.run(mixedDag);
    check('首跑（无 seedResults）→ 全部执行，零行为变更', () => {
        assert.strictEqual(first.executor_calls === undefined ? orch1.executor.calls.length : -1, 2);
        assert.ok(Object.values(first.results).every((r) => r.status === 'done'));
    });

    // 影响半径重跑：只重跑 c1，v1 复用
    const orch2 = new Orchestrator({ executor: countingExecutor(), shadowMode: false });
    const second = await runImpact(orch2, mixedDag, first.results, { kind: 'adapter', adapterId: 'claude' });
    check('runImpact adapter:claude → 只执行 c1，v1 复用不执行', () => {
        assert.deepStrictEqual(orch2.executor.calls, ['c1']);
        assert.deepStrictEqual(second.impact.affected, ['c1']);
        assert.deepStrictEqual(second.impact.reused, ['v1']);
    });
    check('runImpact 报告：复用节点带 reused 标记且状态 done', () => {
        const byId = new Map(second.report.json.subtasks.map((s) => [s.id, s]));
        assert.strictEqual(byId.get('v1').status, 'done');
        assert.strictEqual(byId.get('v1').reused, true);
        assert.strictEqual(byId.get('c1').status, 'done');
        assert.notStrictEqual(byId.get('c1').reused, true);
    });
    check('runImpact 影响判定可解释（reason 非空、非黑盒）', () => {
        assert.ok(second.impact.reason && second.impact.reason.length > 0);
        assert.ok(/claude/.test(second.impact.reason));
    });

    // prev 缺失 → 降级重跑（不谎报复用）
    const orch3 = new Orchestrator({ executor: countingExecutor(), shadowMode: false });
    const third = await runImpact(orch3, mixedDag, null, { kind: 'adapter', adapterId: 'claude' });
    check('prevResults 缺失 → 复用降级为重跑（affected 吸收，executor 全执行）', () => {
        assert.deepStrictEqual(setOf(third.impact.affected), setOf(['v1', 'c1']));
        assert.deepStrictEqual(orch3.executor.calls.sort(), ['c1', 'v1']);
        assert.ok(/降级重跑/.test(third.impact.reason));
    });

    // shadow 模式下 runImpact 也安全（shadow 不调 executor，seed 复用逻辑一致）
    const orch4 = new Orchestrator({ executor: countingExecutor(), shadowMode: true });
    const fourth = await runImpact(orch4, mixedDag, first.results, { kind: 'adapter', adapterId: 'claude' });
    check('shadow 模式 runImpact → 受影响节点走 shadow 执行，复用逻辑一致', () => {
        assert.strictEqual(orch4.executor.calls.length, 0);
        const byId = new Map(fourth.report.json.subtasks.map((s) => [s.id, s]));
        assert.strictEqual(byId.get('v1').reused, true);
        assert.ok(byId.get('c1').value && byId.get('c1').value.shadow === true);
    });

    console.log('---');
    console.log(`PASS ${pass} / FAIL ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
