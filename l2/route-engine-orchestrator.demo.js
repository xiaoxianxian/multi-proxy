'use strict';

// L2 P3 · route-engine ↔ orchestrator 桥（runDag）的 E2E 真跑 demo。
// 证明：route-engine._execute 桩已接真 executor；route() 选出的 adapter 由 orchestrator 调度真执行。
// 纪律：默认 shadow=true 不执行；shadowMode=false + 注入 executor 才真跑，全程 mock executor（不碰 agent 文件/不联网）。
// 约定：executor 经 RouteEngine 构造器注入（this.executor）；runDag 内部把它桥接给 Orchestrator。

const assert = require('assert');
const { RouteEngine } = require('./route-engine');
const { AgentRegistry } = require('./agent-registry');
const { PluginRuntime } = require('./plugin-runtime');

let n = 0;
const ok = (m, a) => { assert(a, m); n += 1; console.log(`PASS ${m}`); };
const EXPECTED = 13;

const newEngine = (reg, extra = {}) =>
     new RouteEngine({ registry: reg, pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }), ...extra });

const mkReg = () => {
   const r = new AgentRegistry();
    r.create({ id: 'h3web', name: 'H3', type: 'custom', adapterId: 'h3web', capabilityTags: ['video', 'text2video', 'image'] });
    r.create({ id: 'codex', name: 'CX', type: 'codex', adapterId: 'codex', capabilityTags: ['code', 'review'] });
    return r;
};

(async () => {
      // ---- 用例 1：_execute 默认 stub（无 executor 注入）→ status 'queued' 不变 ----
{
    const engine = newEngine(mkReg(), { shadowMode: false });
    const dec = engine.route({ id: 't1', type: 'video', prompt: 'cat' });
    const exec = await engine._execute(dec.chosen.adapterId, { type: 'video' });
    ok('UC1: 默认 _execute 保持 stub status queued', exec.status === 'queued' && exec.adapterId === 'h3web');
}

      // ---- 用例 2：构造器注入 executor 后 _execute 真跑（直接调用，绕开 route() 内部的 executor 调用避免计数污染）----
      {
      let called = 0;
      const engine = newEngine(mkReg(), {
       executor: async (adapterId, task) => { called++; return { ok: true, adapter: adapterId }; },
      });
      const exec = await engine._execute('h3web', { id: 't2', type: 'video', prompt: 'cat' });
      ok('UC2: 注入 executor 后 _execute 真跑 status done', exec.status === 'done' && exec.value && exec.value.ok === true);
      ok('UC2: executor 真被调用 1 次（直接调用 _execute，不经过 route()）', called === 1);
      }

      // ---- 用例 3：executor 抛错 → status failed，不冒泡污染 DAG ----
{
    const engine = newEngine(mkReg(), { shadowMode: false, executor: async () => { throw new Error('adapter boom'); } });
    const exec = await engine._execute('codex', { id: 'e', type: 'code' });
    ok('UC3: executor 抛错转 status failed 带 error', exec.status === 'failed' && /boom/.test(exec.error));
}

      // ---- 用例 4：runDag shadow=true → 子任务全 done 但 value.shadow=true（非侵入）----
{
    const engine = newEngine(mkReg(), { shadowMode: true });
    const dag = {
        input: 'video+code',
        subtasks: [
              { id: 'gen', type: 'video', complexity: 'high', prompt: 'gen clip', deps: [] },
              { id: 'review', type: 'code', complexity: 'low', prompt: 'review', deps: [] },
         ],
        edges: [],
      };
    const out = await engine.runDag(dag);
    ok('UC4: runDag shadow 全子任务 done', Object.values(out.results).every((r) => r.status === 'done'));
    ok('UC4: 子任务 value.shadow=true（未真执行）', out.results.gen.value && out.results.gen.value.shadow === true);
    ok('UC4: report json 有 2 子任务', out.report.json.subtasks.length === 2);
}

      // ---- 用例 5：runDag shadow=false + executor → 真执行，路由选中 adapter 经 _execute 真跑 ----
      // 真输出 shape：results.gen.value = {adapterId, status:'done', value:'exec-<adapter>-<id>', adapter, via:'route-engine'}
{
    const executed = [];
    const engine = newEngine(mkReg(), {
        shadowMode: false,
        executor: async (adapterId, task) => {
            executed.push({ adapterId, taskId: task.id, type: task.type });
            return `exec-${adapterId}-${task.id}`;
          },
      });
    const dag = {
        input: 'gen+review',
        subtasks: [
              { id: 'gen', type: 'video', complexity: 'high', prompt: 'gen clip', deps: [] },
              { id: 'review', type: 'code', complexity: 'low', prompt: 'review', deps: [] },
         ],
        edges: [],
      };
    const out = await engine.runDag(dag);
    ok('UC5: 非 shadow 真执行全 done', Object.values(out.results).every((r) => r.status === 'done'));
    ok('UC5: 子任务 value 经路由选中 adapter（h3web 接 video）', out.results.gen.value.value.includes('h3web') && out.results.gen.value.via === 'route-engine');
    ok('UC5: type=code 路由到 codex', out.results.review.value.value.includes('codex'));
    ok('UC5: executor 真被调用 2 次', executed.length === 2);
}

      // ---- 用例 6：未注入 executor + shadowMode=false → _execute 走 stub queued（status 仍 done）----
{
    const engine = newEngine(mkReg(), { shadowMode: false });
    const dag = {
        input: 'x',
        subtasks: [{ id: 'g', type: 'video', prompt: 'g', deps: [] }],
        edges: [],
      };
    const out = await engine.runDag(dag);
    ok('UC6: 未注入 executor 时 _execute 走 stub queued（status 仍 done）', out.results.g.status === 'done');
    ok('UC6: value 是 _execute stub 结果（status queued）', out.results.g.value && out.results.g.value.status === 'queued');
}

    console.log(`\nroute-engine↔orchestrator bridge demo: ${n}/${EXPECTED} checks PASS`);
    if (n !== EXPECTED) {
        console.error(`FAIL: ${EXPECTED - n} 项未通过`);
        process.exit(1);
       }
})().catch((e) => {
    console.error('FAIL:', e && e.stack || e);
    process.exit(1);
});
