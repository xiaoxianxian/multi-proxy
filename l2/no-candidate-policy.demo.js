// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 无候选兜底策略演示（质量工程 §四 待办②）。
//
// 背景：此前 route() 选不出 adapter 时是**隐式行为**——decision.chosen=null，
// 但调用方（_realExecutor）照样调 executor，最终 executor 拿到 adapterId=null，
// 没人报错、无从复盘。本策略把这条隐式路径变成显式、可审计、可配置的决策。
//
// 三种策略：
//   observe          保持 null，只在 decision 上补诊断字段（零行为变更；切 reject 前的观察态）
//   fallback-default 退到底座声明的 defaultAdapterId（须已注册），decision.degraded=true
//   reject          （2026-10-01 起为默认）decision.rejected=true，执行器据此硬失败，
//                   不再「无路由也执行」。切换前提：观察态真跑告警归零（见 runbook §4.2/§4.3）。
//
// 注：本 demo 不依赖"默认值是多少"——每个策略都显式传 noCandidateStrategy（或 env），
// 只有一条用例专门断言默认口径。这样底座默认值改了，策略行为用例不会跟着碎。
//
// 纪律：零依赖 node 标准库 + l2 内核；不联网、不写盘、0 副作用。

const assert = require('assert');
const { AgentRegistry } = require('./agent-registry.js');
const { RouteEngine } = require('./route-engine.js');
const rb = require('./knowledge-base/routing-base.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

// 默认注册表面：codex 承接 code/review/test（真实生产 seed 见 l2/mcp-default-seed.js），
// 这里故意不注册任何同时猜任意稀有能力的 agent，以构造「无候选」场景。
function registryWithout(/* 无参：只用 codex */) {
    const r = new AgentRegistry();
    r.create({ id: 'codex', name: 'Codex', type: 'codex', adapterId: 'codex', capabilityTags: ['code', 'review'] });
    return r;
}

const NO_CANDIDATE_TASK = { id: 't1', type: 'audio-mix', complexity: 'low', prompt: '混音' };
const CODE_TASK = { id: 't2', type: 'code', complexity: 'low', prompt: '写代码' };

console.log('--- 无候选兜底策略（routing-base.noCandidatePolicy）---\n');

// 每个 case 前把 env 与底座恢复干净，避免用例互相污染
const cleanEnv = () => { delete process.env.PROXY_L2_NOCANDIDATE; };
const basePolicy = JSON.parse(JSON.stringify(rb.ROUTING_BASE.noCandidatePolicy));
const restoreBase = () => { rb.ROUTING_BASE.noCandidatePolicy = JSON.parse(JSON.stringify(basePolicy)); };

// 0. 默认口径（生产实际）：2026-10-01 起默认 reject —— 与底座单一事实源对齐，
//    且这条断言就是"默认翻没翻"的唯一看门狗（改底座默认值时这里必须先改）。
check(`默认策略 = ${basePolicy.strategy}（底座 noCandidatePolicy，生产口径）`, () => {
    cleanEnv();
    const e = new RouteEngine({ registry: registryWithout(), shadowMode: true });
    const d = e.route(NO_CANDIDATE_TASK);
    assert.strictEqual(d.noCandidatePolicy, basePolicy.strategy);
    if (basePolicy.strategy === 'reject') {
        assert.strictEqual(d.rejected, true, '默认 reject：无候选必须标记 rejected');
        assert.strictEqual(d.chosen, null);
    } else {
        assert.strictEqual(d.rejected, undefined, '默认 observe：不得标记 rejected');
    }
});

// 1. observe（显式）—— 行为与改造前逐字一致，只多出诊断字段
check('observe（显式）：无候选 → chosen=null，行为不变，仅补诊断字段', () => {
    cleanEnv();
    const e = new RouteEngine({ registry: registryWithout(), shadowMode: true, noCandidateStrategy: 'observe' });
    const d = e.route(NO_CANDIDATE_TASK);
    assert.strictEqual(d.chosen, null, 'observe 下 chosen 应仍为 null（零行为变更）');
    assert.strictEqual(d.noCandidate, true);
    assert.strictEqual(d.noCandidatePolicy, 'observe');
    assert.ok(/audio-mix/.test(d.noCandidateReason), `reason 应点名能力，实际：${d.noCandidateReason}`);
    assert.strictEqual(d.rejected, undefined, 'observe 不得标记 rejected');
    assert.strictEqual(d.degraded, undefined, 'observe 不得标记 degraded');
});

// 2. fallback-default —— 退到底座声明的 defaultAdapterId，并明示 degraded
check('fallback-default：退到 defaultAdapterId(codex) 且标记 degraded', () => {
    cleanEnv();
    const e = new RouteEngine({ registry: registryWithout(), shadowMode: true, noCandidateStrategy: 'fallback-default' });
    const d = e.route(NO_CANDIDATE_TASK);
    assert.ok(d.chosen, 'fallback-default 下应产出兜底 adapter');
    assert.strictEqual(d.chosen.adapterId, rb.ROUTING_BASE.noCandidatePolicy.defaultAdapterId);
    assert.strictEqual(d.chosen.source, 'policy-fallback', '来源必须明示是兜底，不是能力匹配');
    assert.strictEqual(d.degraded, true, '必须明示降级');
    assert.strictEqual(d.noCandidate, true, '原始无候选事实仍要记录，不能被兜底抹掉');
});

// 3. reject —— 决策层标记拒绝（由执行器中断）
check('reject：无候选 → decision.rejected=true，chosen 仍为 null', () => {
    cleanEnv();
    const e = new RouteEngine({ registry: registryWithout(), shadowMode: true, noCandidateStrategy: 'reject' });
    const d = e.route(NO_CANDIDATE_TASK);
    assert.strictEqual(d.rejected, true);
    assert.strictEqual(d.chosen, null);
    assert.strictEqual(d.action, 'log-only', 'reject 下不得给出 execute 意图');
});

// 4. env 覆盖（PROXY_L2_NOCANDIDATE）+ 非法值 fail-fast
//    用 observe 覆盖（默认已是 reject）→ 能证明 env 真的压过默认值，而不是"恰好相同"。
check('env PROXY_L2_NOCANDIDATE 覆盖底座默认', () => {
    cleanEnv();
    process.env.PROXY_L2_NOCANDIDATE = 'observe';
    const e = new RouteEngine({ registry: registryWithout(), shadowMode: true });
    const d = e.route(NO_CANDIDATE_TASK);
    assert.strictEqual(d.noCandidatePolicy, 'observe');
    assert.strictEqual(d.rejected, undefined, 'env=observe 时不得 rejected（证明确实压过了默认）');
    cleanEnv();
});

check('非法策略值 fail-fast（不静默退回不可预期行为）', () => {
    cleanEnv();
    process.env.PROXY_L2_NOCANDIDATE = 'yolo';
    try {
        new RouteEngine({ registry: registryWithout(), shadowMode: true }).route(NO_CANDIDATE_TASK);
        throw new Error('应当抛错但没有');
    } catch (e) {
        assert.ok(/unknown strategy/.test(e.message), `错误信息应点明非法取值，实际：${e.message}`);
    } finally {
        cleanEnv();
    }
});

// 5. 有候选时策略完全不介入（不能污染正常路径）
check('有候选：不触发任何兜底字段（正常路径零污染）', () => {
    cleanEnv();
    const e = new RouteEngine({ registry: registryWithout(), shadowMode: true });
    const d = e.route(CODE_TASK);
    assert.ok(d.chosen && d.chosen.adapterId === 'codex', 'code 应正常命中 codex');
    assert.strictEqual(d.noCandidate, undefined);
    assert.strictEqual(d.degraded, undefined);
    assert.strictEqual(d.rejected, undefined);
});

// 6. 底座单一事实源：改这里，所有 engine 生效；rollback 可回
check(`底座改 strategy → 生效；rollback → 回 ${basePolicy.strategy}（单一事实源）`, () => {
    cleanEnv();
    const v0 = rb.update({ noCandidatePolicy: { strategy: 'fallback-default', defaultAdapterId: 'codex' } }, 'demo: policy');
    const e1 = new RouteEngine({ registry: registryWithout(), shadowMode: true });
    const d1 = e1.route(NO_CANDIDATE_TASK);
    assert.ok(d1.chosen && d1.chosen.source === 'policy-fallback', '底座改动应即刻生效');
    rb.rollback();
    const e2 = new RouteEngine({ registry: registryWithout(), shadowMode: true });
    const d2 = e2.route(NO_CANDIDATE_TASK);
    assert.strictEqual(d2.noCandidatePolicy, basePolicy.strategy, `rollback 后应回 ${basePolicy.strategy}`);
    assert.strictEqual(d2.chosen, null);
    restoreBase();
    assert.ok(v0 > 0);
});

console.log(`\n--- PASS ${pass} / FAIL ${fail} ---`);
process.exit(fail === 0 ? 0 : 1);
