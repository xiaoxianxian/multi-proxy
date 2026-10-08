// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// Pilot —— 热路径小流量验证（翻闸门前的最后一步受控演练）。
//
// 验证对象 = **生产真实入口**，不是另搭假链路：
//   McpServer.callToolAsync('orchestrate') → 二级门控 PROXY_ADAPTER_REAL（realGate='1'）
//   → Orchestrator(shadowMode=false) → _realExecutor() → routeEngine.route() → executor → 真 adapter → 真 HTTP。
//
// 四个场景：
//   A 真执行 + 质量层开：证明「翻闸门」后链路真的跑通，且 2.2/2.3 在热路径真的生效（不再是旁路）。
//   B 一键回退：per-call shadowMode:true → executor 0 调用、下游 0 请求（回退开关真可用）。
//   C 质量层默认关：不传 quality → result 无 quality 字段、行为与既有逐字一致（零行为变更）。
//   D 保真拦截：executor 改样 prompt → fidelityIssues 记录；qualityThrow=true → 子任务 failed（不是静默通过）。
//
// 纪律（同 adapters/agent-live-e2e.demo.js）：
//   ① 0 联网：下游是内联 mock-l1，不触真实上游、0 扣费。② 0 副作用：不写盘、不写 agent 文件。③ fake token 不打印。

const startMockL1 = require('./mock-l1.js');
const { L1AgentAdapter } = require('./adapters/l1-agent-adapter.js');
const { AgentRegistry } = require('./agent-registry.js');
const { McpServer } = require('./mcp-server.js');
const { seedDefaultProfiles } = require('./mcp-default-seed.js');
const { resolveNoCandidatePolicy } = require('./knowledge-base/routing-base.js');

let pass = 0;
let fail = 0;
const ok = (msg, cond) => {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
};

function call(server, id, args) {
    return server.handleMessageAsync({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'orchestrate', arguments: args },
    }).then((res) => JSON.parse(res.result.content[0].text));
}

(async () => {
    console.log('--- Pilot: 热路径小流量验证（mock 隔离下游 · 0 扣费 · 0 副作用）---\n');

    // mock 下游（带 chat 端点的 L1 代理形态）+ 真 adapter（真 HTTP round-trip 打它）
    const mock = startMockL1(0, { noChat: false, model: 'pilot-model' });
    await new Promise((r) => setTimeout(r, 50));
    const adapter = new L1AgentAdapter({
        id: 'pilot-codex', name: 'pilot-codex-proxy', portCandidates: [], port: mock.getPort(),
        token: mock.token, capabilities: ['code', 'review'], chatPath: '/v1/chat/completions',
    });

    const reg = new AgentRegistry();
    seedDefaultProfiles(reg);   // 生产默认注册表（codex/claude/h3web + 三档 tier）

    let httpCalls = 0;
    let execCalls = 0;
    // 生产语义的 executor：(adapterId, subtask, ctx) → 经真 adapter 打真 HTTP round-trip
    const executor = async (adapterId, subtask) => {
        execCalls++;
        const t = await adapter.invoke({ model: 'pilot-model', messages: [{ role: 'user', content: subtask.prompt }] });
        httpCalls++;
        return { marker: 'pilot-real-http', adapterId, content: t.result && t.result.content };
    };
    // 恶意 executor：改样 subtask.prompt（验证 2.3 执行保真在热路径能否检出）
    const mutatingExecutor = (adapterId, subtask) => {
        execCalls++;
        subtask.prompt = `${subtask.prompt} [MUTATED]`;   // 下发后被改样
        httpCalls++;
        return { marker: 'pilot-mutated', adapterId };
    };

    const INPUT = '做一个 jwt 认证';   // → fastapi-jwt 模板：4 子任务线性依赖（code×3 + test×1）

    // ===== A：真执行 + 质量层开 =====
    console.log('A) 真执行 + 质量层开（realGate=1 + quality:true）');
    {
        const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
        const p = await call(server, 1, { input: INPUT, quality: true });
        ok('shadow=false（真执行，per-call 未强制回退）', p.shadow === false);
        ok('模板命中 fastapi-jwt（4 子任务线性依赖）', p.template === 'fastapi-jwt' && p.subtasks.length === 4);
        ok('4 子任务全部 done', p.subtasks.every((s) => s.status === 'done'));
        const codeNodes = p.report.subtasks.filter((s) => s.id !== 'unit-test');
        const testNode = p.report.subtasks.find((s) => s.id === 'unit-test');
        ok('3 个 code 子任务真经 _realExecutor 执行（executed + 真实 routedAdapterId）',
            codeNodes.every((s) => s.value && s.value.status === 'executed' && s.value.routedAdapterId));
        // 2026-10-01：此前 unit-test(type='test') 无 profile 承接 → routedAdapterId=null，
        // 已在 l2/mcp-default-seed.js 给声明 'code' 的 profile（codex/claude）补 'test' 能力。
        ok(`test 子任务已有 adapter 承接（routedAdapterId=${testNode.value.routedAdapterId}）`,
            !!testNode.value.routedAdapterId);
        ok('全部 4 子任务均有真实 routedAdapterId（无静默无路由执行）',
            p.report.subtasks.every((s) => s.value && s.value.routedAdapterId));
        ok('2.2 审阅层对 unit-test 不再报「无候选」warn（能力补 owner 后自洽）',
            !p.quality.semanticIssues.some((i) => i.subtaskId === 'unit-test' && /候选|路由不到/i.test(i.message)));
        ok(`下游真收到 4 次 HTTP 往返（实际 ${httpCalls}）`, httpCalls === 4);
        ok('真值回传：mock content 出现在 report 里',
            p.report.subtasks.every((s) => s.value && s.value.value && s.value.value.content === 'mock-ok'));
        ok('质量观测 sidecar 存在（2.2/2.3 已接入热路径）',
            p.quality && Array.isArray(p.quality.semanticIssues) && Array.isArray(p.quality.fidelityIssues));
        ok('2.3 执行保真：良性 executor 无改样记录', p.quality.fidelityIssues.length === 0);
        console.log(`     ℹ 2.2 语义审阅诊断: ${JSON.stringify(p.quality.semanticIssues)}`);
    }

    // ===== B：一键回退（同一 server，per-call shadowMode:true）=====
    console.log('\nB) 一键回退（per-call shadowMode:true）');
    {
        const beforeExec = execCalls, beforeHttp = httpCalls;
        const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
        const p = await call(server, 2, { input: INPUT, shadowMode: true });
        ok('回退立即生效：shadow=true', p.shadow === true);
        ok('executor 0 调用（0 副作用）', execCalls === beforeExec);
        ok('下游 0 请求', httpCalls === beforeHttp);
        ok('回退后仍产出完整决策/报告（4 子任务 done，仅不真执行）', p.subtasks.every((s) => s.status === 'done'));
    }

    // ===== C：质量层默认关 = 零行为变更 =====
    console.log('\nC) 质量层默认关（不传 quality）');
    {
        const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
        const p = await call(server, 3, { input: INPUT });
        ok('默认关时 result 无 quality 字段（与既有逐字一致）', p.quality === undefined);
        ok('默认关时仍正常真执行（行为不受质量门控影响）', p.shadow === false && p.subtasks.every((s) => s.status === 'done'));
    }

    // ===== D：保真拦截（恶意 executor 改样）=====
    console.log('\nD) 保真拦截（executor 改样 prompt）');
    {
        const serverWarn = new McpServer({ gate: '1', registry: reg, realGate: '1', executor: mutatingExecutor });
        const pw = await call(serverWarn, 4, { input: INPUT, quality: true, qualityThrow: false });
        ok('2.3 在热路径检出改样（fidelityIssues ≥1）', pw.quality.fidelityIssues.length >= 1);
        ok('qualityThrow=false → 记录但不阻断（子任务仍 done）', pw.subtasks.every((s) => s.status === 'done'));

        const serverThrow = new McpServer({ gate: '1', registry: reg, realGate: '1', executor: mutatingExecutor });
        const pt = await call(serverThrow, 5, { input: INPUT, quality: true, qualityThrow: true });
        ok('qualityThrow=true → 改样子任务 failed（硬拒生效，非静默通过）',
            pt.subtasks.some((s) => s.status === 'failed'));
        ok('失败按依赖传播：根 failed → 下游 skipped（2.1 传播在热路径成立）',
            pt.subtasks.filter((s) => s.status === 'skipped').length >= 1);
    }

    // ===== E：无候选兜底策略（质量工程 §四待办②）在热路径的三种形态 =====
    // 构造一个**没有任何 adapter 承接**的能力自己喂进热路径（type='audio-mix'），
    // 对比 默认口径 / observe / reject 的差异。
    // ⚠️ 2026-10-01 起底座默认 = reject，故 observe 分支必须显式设 env（不能再依赖默认），
    //    并单独留一条"默认口径"断言当看门狗 —— 底座默认值再变，这里会第一时间红。
    console.log('\nE) 无候选兜底策略（type 无人承接）');
    {
        const orphanDag = {
            input: 'orphan', template: 'orphan',
            subtasks: [{ id: 'orphan', type: 'audio-mix', complexity: 'low', prompt: '混音', deps: [] }],
            edges: [],
        };
        const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });

        // E0 默认口径（生产实际，当前 = reject）
        const beforeDefault = execCalls;
        const pd = await call(server, 60, { dag: orphanDag, quality: true });
        const defaultPolicy = resolveNoCandidatePolicy().strategy;
        ok(`默认口径 = ${defaultPolicy}（底座 noCandidatePolicy，生产实际）`,
            defaultPolicy === 'reject'
                ? pd.subtasks[0].status === 'failed' && execCalls === beforeDefault
                : pd.subtasks[0].status === 'done' && execCalls === beforeDefault + 1);

        // E1 observe（显式）
        process.env.PROXY_L2_NOCANDIDATE = 'observe';
        const beforeExec = execCalls;
        const po = await call(server, 6, { dag: orphanDag, quality: true });
        ok('observe（显式）：仍能执行但 routedAdapterId=null —— 现状的静默降级被如实记录',
            po.subtasks[0].status === 'done' && po.report.subtasks[0].value.routedAdapterId === null);
        ok('observe 下 2.2 审阅层已对该 type 给出无候选诊断',
            po.quality.semanticIssues.some((i) => i.subtaskId === 'orphan'));
        ok('observe 下 executor 确实被调用（等于改造前行为）', execCalls === beforeExec + 1);

        process.env.PROXY_L2_NOCANDIDATE = 'reject';
        const actsBefore = execCalls;
        try {
            const pr = await call(server, 7, { dag: orphanDag, quality: true });
            ok('reject：无候选 → 子任务 failed（不再「无路由也执行」）', pr.subtasks[0].status === 'failed');
            ok('reject 下 executor 未被调用（0 下游副作用）', execCalls === actsBefore);
            ok(`reject 失败原因透出到 report：${String(pr.subtasks[0].error || pr.subtasks[0].reason || '').slice(0, 40)}…`,
                JSON.stringify(pr).includes('route rejected'));
        } finally {
            delete process.env.PROXY_L2_NOCANDIDATE;
        }
    }

    await mock.close();
    console.log(`\n--- PASS ${pass} / FAIL ${fail} ---`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
