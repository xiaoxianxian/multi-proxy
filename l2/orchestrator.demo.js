'use strict';

// orchestrator.demo.js — L2 P2 编排引擎真跑验证。
// 验证 5 用例（含 h3web 视频工作流）+ 条件分支 + 容错重试/降级 + 协作历史 + 非侵入落盘。
// 全程零副作用：默认 shadow（不执行真实 adapter），历史落盘写 os.tmpdir()，绝不写 home/agent 文件。
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Orchestrator } = require('./orchestrator.js');
const { decompose, templateDecompose, hasCycle } = require('./decomposer.js');

let n = 0;
const ok = (m, a) => { assert(a, m); n += 1; console.log(`PASS ${m}`); };

// 执行器：shadow 模式由内核替身；非 shadow 用一个计数 mock executor（记录实际执行，不触 adapter）
function countingExecutor() {
    const calls = [];
    return {
        calls,
        execute: async (st, ctx) => { calls.push(st.id); return `exec-${st.id}`; },
     };
}

(async () => {
    // 用例 1：纯代码任务（FastAPI/JWT 线性 4 步，shadow 调度）
    {
        const o = new Orchestrator({ shadowMode: true });
        const out = await o.runFromInput('帮我写一个 FastAPI 服务支持 JWT 认证 + 数据库');
        ok('UC1: 4 子任务全 done', Object.values(out.results).every((r) => r.status === 'done'));
        ok('UC1: shadow 不产生真值（value.shadow）', Object.values(out.results).every((r) => r.value && r.value.shadow === true));
        ok('UC1: 协作历史登记', o.getHistory().length === 1 && o.getHistory()[0].template === 'fastapi-jwt');
     console.log(JSON.stringify(out.report.json.summary));
     }

    // 用例 2：并行无依赖（视频片段 A/B 同时，shadow）
    {
        const o = new Orchestrator({ shadowMode: true });
        const dag = templateDecompose('30 秒短视频');
        const out = await o.run(dag);
        ok('UC2: 5 子任务全 done', Object.values(out.results).every((r) => r.status === 'done'));
        ok('UC2: A/B 并行的前置(片段)都 done', out.results['gen-clip-a'].status === 'done' && out.results['gen-clip-b'].status === 'done');
     }

    // 用例 3：条件分支（when 决定 skip 某支）
    {
        const dag = {
            input: 'conditional',
            subtasks: [
          { id: 'pre', type: 'code', complexity: 'low', prompt: '前置', deps: [] },
          { id: 'branch-a', type: 'code', complexity: 'low', prompt: '走 A', deps: ['pre'], when: (ctx) => ctx.results.pre && ctx.runId },
          { id: 'branch-b', type: 'code', complexity: 'low', prompt: '走 B', deps: ['pre'], when: () => false },
         ],
         edges: [['pre', 'branch-a'], ['pre', 'branch-b']],
       };
        const o = new Orchestrator({ shadowMode: true });
        const out = await o.run(dag);
        ok('UC3: 条件 false 的 branch-b 被 skip', out.results['branch-b'].status === 'skipped' && out.results['branch-b'].reason === 'when');
        ok('UC3: 条件 true 的 branch-a 执行', out.results['branch-a'].status === 'done');
     }

    // 用例 4：h3web 视频工作流（非 shadow，用 mock executor 代替真 adapter，验证调度 + 聚合）
    {
        const { calls, execute } = countingExecutor();
        const o = new Orchestrator({ shadowMode: false, executor: execute });
        const dag = templateDecompose('制作一个产品宣传短视频');
        const out = await o.run(dag, { ctx: { runId: 'r' } });
        ok('UC4: 非 shadow 经 executor 执行', calls.length === 5);
        ok('UC4: 聚合 JSON 含 5 子任务 + markdown', out.report.json.subtasks.length === 5 && /编排结果/.test(out.report.markdown));
        ok('UC4: 执行序含 compose 在片段之后', calls.indexOf('compose') > calls.indexOf('gen-clip-a'));
     }

    // 用例 5：容错重试 + 降级（retry 耗尽 → fallback → 成功）
    {
        let fbHit = 0;
        const executor = async (st, ctx) => {
            if (st.id === 'flaky') throw new Error('flaky downstream failed');
            if (st.id === 'flaky-fb') { fbHit++; return 'recovered'; }
            return st.id;
         };
        const dag = {
            input: 'retry-fallback',
            subtasks: [
          { id: 'flaky', type: 'code', complexity: 'low', prompt: '易失败', deps: [], retry: 0, fallback: 'flaky-fb' },
          { id: 'flaky-fb', type: 'code', complexity: 'low', prompt: '备用', deps: [] },
         ],
         edges: [],
       };
        const o = new Orchestrator({ shadowMode: false, executor, maxRetries: 2 });
        const out = await o.run(dag);
        ok('UC5: flaky 经 retry 耗尽后降级 fallback 成功', out.results['flaky'].status === 'done' && out.results['flaky'].via === 'flaky-fb');
        ok('UC5: 备用确实被调用', fbHit >= 1);
     }

    // 用例 6：循环依赖被拒（hasCycle 前置）
    {
        const o = new Orchestrator({ shadowMode: true });
        let threw = false;
        try {
            await o.run({
                input: 'cyclic',
                subtasks: [
                      { id: 'a', type: 'code', complexity: 'low', prompt: 'a', deps: ['b'] },
                      { id: 'b', type: 'code', complexity: 'low', prompt: 'b', deps: ['a'] },
                 ],
                edges: [['b', 'a'], ['a', 'b']],
             });
         } catch (e) { threw = /cycle/i.test(e.message); }
        ok('UC6: 循环依赖 DAG 被拒调度', threw);
     }

    // 用例 7：协作历史非侵入落盘（写 tmpdir，不写 home）
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hist-'));
        const o = new Orchestrator({ shadowMode: true, dir });
        const out7 = await o.runFromInput('jwt fastapi service');
        const file = path.join(dir, 'orchestration-history.json');
        ok('UC7: 协作历史落盘到注入 dir（非 home）', fs.existsSync(file) && file.startsWith(os.tmpdir()) && !file.includes(os.homedir()));
        void out7;
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        ok('UC7: 落盘内容含 runId + 子任务', Array.isArray(saved) && saved[0].runId && saved[0].subtasks.length === 4);
         fs.rmSync(dir, { recursive: true, force: true });
     }

    // 用例 8：shadow 默认 → 不触碰 executor（非侵入）
    {
        let execCalled = false;
        const o = new Orchestrator({ shadowMode: true, executor: async () => { execCalled = true; } });
        await o.runFromInput('jwt fastapi');
        ok('shadow: 不触碰 executor（非侵入）', execCalled === false);
     }

    console.log(`\norchestrator demo: ${n} checks PASS`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
