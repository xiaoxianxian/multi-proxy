'use strict';

// contract.demo.js — L2 事实绑定层（质量工程 2.1）契约校验真跑验证。
// 零副作用：纯校验 + 单次 shadow 编排，不起服务、不写文件、不触真实 adapter。
// 跑法：node l2/contract.demo.js
const assert = require('assert');
const { validateSubtask, validateDag } = require('./contract.js');
const { Orchestrator } = require('./orchestrator.js');
const { templateDecompose } = require('./decomposer.js');

let n = 0;
const ok = (m, a) => { assert(a, m); n += 1; console.log(`PASS ${m}`); };
const rejects = (m, fn) => { let t = false; try { fn(); } catch { t = true; } ok(m, t); };

// A. 合法子任务契约通过
ok('valid: 合法子任务通过', (() => { try { validateSubtask({ id: 's1', type: 'code', complexity: 'low', prompt: 'p', deps: [] }); return true; } catch { return false; } })());

// B. 反向：type 缺失 / 空 / 非字符串 → 拒绝
rejects('rev: type 缺失被拒', () => validateSubtask({ id: 's1', prompt: 'p', deps: [] }));
rejects('rev: type 空串被拒', () => validateSubtask({ id: 's1', type: '', prompt: 'p', deps: [] }));
rejects('rev: type 数字被拒', () => validateSubtask({ id: 's1', type: 123, prompt: 'p', deps: [] }));

// C. 反向：prompt 非字符串 → 拒绝（允许空串，语义层职责）
rejects('rev: prompt 缺失被拒', () => validateSubtask({ id: 's1', type: 'code', deps: [] }));
rejects('rev: prompt 数字被拒', () => validateSubtask({ id: 's1', type: 'code', prompt: 42, deps: [] }));
ok('lenient: prompt 空串放行（语义层职责）', (() => { try { validateSubtask({ id: 's1', type: 'code', prompt: '', deps: [] }); return true; } catch { return false; } })());

// D. 反向：complexity 非法 → 拒绝
rejects('rev: complexity 非法被拒', () => validateSubtask({ id: 's1', type: 'code', complexity: 'ultra', prompt: 'p', deps: [] }));

// E. 反向：deps 非数组 / 含非字符串 → 拒绝
rejects('rev: deps 非数组被拒', () => validateSubtask({ id: 's1', type: 'code', prompt: 'p', deps: 'x' }));
rejects('rev: deps 含非字符串被拒', () => validateSubtask({ id: 's1', type: 'code', prompt: 'p', deps: [1] }));

// F. validateDag：依赖悬空 / 重复 id → 拒绝
rejects('rev: dag 依赖悬空被拒', () => validateDag({ subtasks: [{ id: 'a', type: 'code', complexity: 'low', prompt: 'p', deps: ['ghost'] }] }));
rejects('rev: dag 重复 id 被拒', () => validateDag({ subtasks: [
    { id: 'a', type: 'code', prompt: 'p', deps: [] },
    { id: 'a', type: 'code', prompt: 'p', deps: [] },
] }));

// G. 集成：编排进入执行前，非法 DAG 在 run() 抛（shadow 下也不执行）
(async () => {
    const orch = new Orchestrator({ shadowMode: true });
    let threw = false;
    try { await orch.run({ subtasks: [{ id: 'a', type: '', prompt: 'p', deps: [] }], edges: [] }); } catch { threw = true; }
    ok('integ: 非法子任务在 run() 编排前被拒（shadow 也不执行）', threw);

    // 合法 DAG：shadow 下跑通、子任务全 done、不触真实 adapter
    const dag = templateDecompose('帮我写一个 FastAPI 服务，支持 JWT 认证 + 数据库');
    const r = await orch.run(dag);
    ok('integ: 合法 DAG shadow 跑通且全 done', r.report.json.subtasks.every((s) => s.status === 'done'));
    ok('integ: 合法 DAG 不触真实 adapter（shadow 值 true）', r.report.json.shadowMode === true);

    console.log(`\ncontract demo: ${n} checks PASS`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
