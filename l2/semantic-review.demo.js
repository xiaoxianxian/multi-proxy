'use strict';

// semantic-review.demo.js — L2 质量工程 2.2 真跑验证（与 l2/contract.demo.js 同风格）。
// 反向用例（错配/无候选）+ 正向用例（可路由），node l2/semantic-review.demo.js 全 PASS。
// 同时验证"默认 semanticReview=false 零行为变更"与"开启后把 error 挂到 decision.semanticIssues"。

const assert = require('assert');
const { reviewDecomposition, reviewRouteDecision, assertSemantic } = require('./semantic-review.js');
const { templateDecompose } = require('./decomposer.js');
const { RouteEngine } = require('./route-engine.js');

let n = 0;
function check(name, fn) {
    try { fn(); n++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

// 假 registry：纯文本 adapter（capabilityTags: code/writing，modelType text，modelTier small）
function textRegistry() {
    return { list: () => [{ adapterId: 'text-a', capabilityTags: ['code', 'writing'], modelType: 'text', modelTier: 'small' }] };
}
// 假 registry：覆盖 code + test（用于 jwt 拆解 happy-path，两种 type 都有候选）
function codeTestRegistry() {
    return { list: () => [{ adapterId: 'text-a', capabilityTags: ['code', 'writing', 'test'], modelType: 'text', modelTier: 'small' }] };
}
// 假 registry：标 vision 但 modelType 仍是 text（用于模态不匹配用例）
function visionMismatchRegistry() {
    return { list: () => [{ adapterId: 'mismatch-a', capabilityTags: ['vision'], modelType: 'text', modelTier: 'small' }] };
}
// 假 registry：text + 真 multimodal（vision/image/video, modelTier large）
function goodRegistry() {
    return {
        list: () => [
            { adapterId: 'text-a', capabilityTags: ['code', 'writing'], modelType: 'text', modelTier: 'small' },
            { adapterId: 'mm-a', capabilityTags: ['vision', 'image', 'video'], modelType: 'multimodal', modelTier: 'large' },
        ],
    };
}

console.log('semantic-review demo:');

// ---- 2.2a 拆解产物审阅 ----
check('decompose "jwt" → code/test 子任务均有可路由 adapter（无 warn）', () => {
    const dag = templateDecompose('做一个 jwt 认证');
    const rev = reviewDecomposition(dag, { registry: codeTestRegistry() });
    assert.ok(rev.ok, '分解审阅应 ok');
    assert.strictEqual(rev.issues.length, 0, 'code/test 都应有候选，不应有 warn');
});

check('decompose "视频" → video 子任务无 registered adapter → warn（非阻塞、不破坏 ok）', () => {
    const dag = templateDecompose('做一个视频短片');
    const rev = reviewDecomposition(dag, { registry: textRegistry() });
    assert.ok(rev.ok, 'warn 不破坏 ok');
    const warn = rev.issues.find((i) => i.subtaskId === 'gen-clip-a' && i.level === 'warn');
    assert.ok(warn, '应产生 video 能力无候选的 warn');
    assert.ok(/no routeable adapter for capability "video"/.test(warn.message), 'warn 文案应点名 video 能力');
});

// ---- 2.2b 路由决策审阅 ----
check('route vision 任务（仅 text adapter）→ chosen=null → error + assertSemantic 抛', () => {
    const re = new RouteEngine({ registry: textRegistry() });
    const decision = re.route({ id: 'v1', type: 'vision', prompt: 'p', complexity: 'high' });
    const rev = reviewRouteDecision(decision, { id: 'v1', type: 'vision' });
    assert.strictEqual(rev.ok, false, '无候选应 ok=false');
    assert.strictEqual(rev.issues[0].level, 'error', '应 error 级');
    assert.ok(/no candidate adapter/.test(rev.issues[0].message));
    assert.throws(() => assertSemantic(rev.issues), /no candidate adapter/);
});

check('route vision 任务（adapter 标 vision 但 modelType=text）→ 模态不匹配 error', () => {
    const re = new RouteEngine({ registry: visionMismatchRegistry() });
    const decision = re.route({ id: 'v2', type: 'vision', prompt: 'p', complexity: 'high' });
    assert.ok(decision.chosen, '应有 chosen（tagMatch 命中）');
    const rev = reviewRouteDecision(decision, { id: 'v2', type: 'vision' });
    assert.strictEqual(rev.ok, false, '模态不匹配应 ok=false');
    const err = rev.issues.find((i) => i.level === 'error');
    assert.ok(err && /modality mismatch/.test(err.message), '应报模态不匹配');
    assert.throws(() => assertSemantic(rev.issues), /modality mismatch/);
});

check('route code 任务（text adapter）→ 无 error', () => {
    const re = new RouteEngine({ registry: goodRegistry() });
    const decision = re.route({ id: 'c1', type: 'code', prompt: 'p', complexity: 'low' });
    const rev = reviewRouteDecision(decision, { id: 'c1', type: 'code' });
    assert.ok(rev.ok, 'code 任务应有可路由 adapter 且无 error');
    assert.strictEqual(rev.issues.length, 0, '不应有 issue');
});

check('route vision 任务（真 multimodal adapter）→ 无 error', () => {
    const re = new RouteEngine({ registry: goodRegistry() });
    const decision = re.route({ id: 'v3', type: 'vision', prompt: 'p', complexity: 'high' });
    const rev = reviewRouteDecision(decision, { id: 'v3', type: 'vision' });
    assert.ok(rev.ok, '多模态 adapter 应接住 vision 任务');
    assert.strictEqual(rev.issues.length, 0, '不该有 issue');
});

// ---- 端到端：route-engine 开启 semanticReview=true 时把 error 挂到 decision.semanticIssues ----
check('RouteEngine(semanticReview=true) 在 route 决策上挂 semanticIssues', () => {
    const re = new RouteEngine({ registry: textRegistry(), semanticReview: true });
    const decision = re.route({ id: 'v4', type: 'vision', prompt: 'p', complexity: 'high' });
    assert.ok(Array.isArray(decision.semanticIssues), '应挂 semanticIssues');
    assert.strictEqual(decision.semanticIssues[0].level, 'error', '应挂 error 级');
});

// ---- 零行为变更：默认 semanticReview=false 时 route 不挂 semanticIssues、不抛 ----
check('RouteEngine 默认 semanticReview=false → decision 无 semanticIssues、不抛', () => {
    const re = new RouteEngine({ registry: textRegistry() });
    const decision = re.route({ id: 'v5', type: 'vision', prompt: 'p', complexity: 'high' });
    assert.strictEqual(decision.semanticIssues, undefined, '默认应无 semanticIssues 字段');
});

// ---- orchestrator.run 开启 semanticReview 时记录拆解产物审阅 issues（诊断、非阻塞） ----
check('Orchestrator(semanticReview=true) 对无候选 type 记录 warn 级 _semanticIssues', () => {
    const re = new RouteEngine({ registry: textRegistry() });
    const { Orchestrator } = require('./orchestrator.js');
    const orch = new Orchestrator({ routeEngine: re, semanticReview: true, shadowMode: true });
    const dag = templateDecompose('做一个视频短片');
    orch.run(dag);
    assert.ok(Array.isArray(orch._semanticIssues), '应记录 _semanticIssues');
    const warn = orch._semanticIssues.find((i) => i.subtaskId === 'gen-clip-a' && i.level === 'warn');
    assert.ok(warn, '应记录 video 无候选的 warn（不阻断 shadow 调度）');
});

console.log(`\nsemantic-review demo: ${n} checks PASS`);
