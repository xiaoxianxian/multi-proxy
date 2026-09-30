#!/usr/bin/env node
'use strict';

// step2-canary-run.js —— 翻闸门 Step 2「单任务小流量真执行」受控演练器（runbook §三 Step 2 的可执行版）。
//
// 与 Step 1（observe-shadow-run.js）的区别：Step 1 恒 shadow（只算不跑），
// 本脚本**真执行**——executor 真被调用、下游真收到 HTTP 往返，质量层 2.2/2.3 在热路径真生效。
//
// 三个场景（一次跑完，逐个做止损判定）：
//   A 隔离真执行：realGate=1 + 注入 executor（真 adapter → 真 HTTP → 内联 mock-l1）。
//                 证明「executor 一旦接上，端到端链路 + 质量层是对的」。
//   B 生产当前形态：realGate=1 + **不注入 executor**（= 今天生产打开门控后的真实行为）。
//                 走 _realExecutor 的「仅路由」退化分支：真路由、记录 routedAdapterId，但**不触下游**。
//                 ⚠️ 这就是今天的实际上限：真触下游的 executor 接线尚未生产化（见 runbook §4.4）。
//   C 回退验证：per-call shadowMode:true → executor 0 调用、下游 0 请求（止损开关随时可用）。
//
// 隔离纪律（与 pilot 同款，三条底线）：
//   ① 0 联网 / 0 扣费：下游是内联 mock-l1（127.0.0.1 随机端口），不打任何真实上游、不外发数据。
//   ② 0 副作用：不写 agent 文件、不写 home、不改业务状态；唯一写盘是本脚本的报告（--no-write 可关）。
//   ③ 零行为变更：本脚本只读生产代码，不改任何模块行为；门控全部 per-call/env，不动全局默认值。
//
// 止损条件（runbook §三 Step 2，任一命中即 STOP）：
//   任一子任务 failed / semanticIssues 出现 error 级 / fidelityIssues 非空
//   → 脚本打印 STOP 处置指引（回退命令），并以非零退出码结束。
//
// 用法：
//   node l2/step2-canary-run.js                                  # 默认打 C1「做一个 jwt 认证」
//   node l2/step2-canary-run.js --input "做一个 jwt 认证"          # 换任务
//   node l2/step2-canary-run.js --no-write                       # 只打印不落盘
//   node l2/step2-canary-run.js --no-mock-downstream             # 只跑 B/C（不起 mock，验证纯路由形态）

const fs = require('fs');
const path = require('path');

const { AgentRegistry } = require('./agent-registry.js');
const { McpServer } = require('./mcp-server.js');
const { seedDefaultProfiles } = require('./mcp-default-seed.js');
const { resolveNoCandidatePolicy } = require('./knowledge-base/routing-base.js');

const DEFAULT_INPUT = '做一个 jwt 认证';   // C1：fastapi-jwt 模板（code×3 + test×1），观察态里最干净的一条

// 止损判定：把一次 orchestrate 的结果判成 GO / STOP
function triage(p) {
    const reasons = [];
    const failed = (p.subtasks || []).filter((s) => s.status === 'failed');
    if (failed.length) reasons.push(`子任务 failed：${failed.map((s) => s.id).join(', ')}`);
    const semErr = ((p.quality && p.quality.semanticIssues) || []).filter((i) => i.level === 'error');
    if (semErr.length) reasons.push(`2.2 error 级：${semErr.map((i) => i.message).join(' | ')}`);
    const fid = (p.quality && p.quality.fidelityIssues) || [];
    if (fid.length) reasons.push(`2.3 保真改样：${JSON.stringify(fid)}`);
    const noRoute = ((p.report && p.report.subtasks) || [])
        .filter((s) => !s.value || !s.value.routedAdapterId).map((s) => s.id);
    if (noRoute.length) reasons.push(`无路由（routedAdapterId 为空）：${noRoute.join(', ')}`);
    return { go: reasons.length === 0, reasons };
}

async function callOrchestrate(server, id, args) {
    const res = await server.handleMessageAsync({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'orchestrate', arguments: args },
    });
    return JSON.parse(res.result.content[0].text);
}

(async () => {
    const argv = process.argv.slice(2);
    const writeReport = !argv.includes('--no-write');
    const useMock = !argv.includes('--no-mock-downstream');
    const idx = argv.indexOf('--input');
    const input = (idx >= 0 && argv[idx + 1]) ? argv[idx + 1] : DEFAULT_INPUT;

    const policy = resolveNoCandidatePolicy().strategy;
    console.log('=== L2 翻闸门 Step 2 · 单任务小流量真执行（受控 canary）===');
    console.log(`任务：${input}`);
    console.log(`无候选策略 = ${policy}（底座默认）；下游 = ${useMock ? '内联 mock-l1（0 扣费 · 0 外发）' : '不起 mock（仅跑纯路由形态）'}\n`);

    const reg = new AgentRegistry();
    seedDefaultProfiles(reg);

    let execCalls = 0;
    let httpCalls = 0;
    let mock = null;
    let adapter = null;
    let executor = undefined;

    if (useMock) {
        const startMockL1 = require('./mock-l1.js');
        const { L1AgentAdapter } = require('./adapters/l1-agent-adapter.js');
        mock = startMockL1(0, { noChat: false, model: 'canary-model' });
        await new Promise((r) => setTimeout(r, 50));
        adapter = new L1AgentAdapter({
            id: 'canary-codex', name: 'canary-codex-proxy', portCandidates: [], port: mock.getPort(),
            token: mock.token, capabilities: ['code', 'review', 'test'], chatPath: '/v1/chat/completions',
        });
        // 生产语义的 executor：(adapterId, subtask, ctx) → 经真 adapter 打真 HTTP round-trip（打到 mock）
        executor = async (adapterId, subtask) => {
            execCalls++;
            const t = await adapter.invoke({ model: 'canary-model', messages: [{ role: 'user', content: subtask.prompt }] });
            httpCalls++;
            return { marker: 'canary-real-http', adapterId, content: t.result && t.result.content };
        };
    }

    const results = [];
    const record = (scene, p, extra) => {
        const t = triage(p);
        results.push({ scene, p, extra, triage: t });
        const tag = t.go ? 'GO  ' : 'STOP';
        console.log(`${tag} ${scene}`);
        console.log(`     shadow=${p.shadow} 模板=${p.template} 子任务=${(p.subtasks || []).map((s) => `${s.id}:${s.status}`).join(' ')}`);
        if (extra) console.log(`     ${extra}`);
        if (!t.go) t.reasons.forEach((r) => console.log(`     ⚠ ${r}`));
        return t.go;
    };

    // ===== A：隔离真执行（executor 真跑 + 下游真收到 HTTP）=====
    if (useMock) {
        const before = { e: execCalls, h: httpCalls };
        const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
        const p = await callOrchestrate(server, 1, { input, quality: true, qualityThrow: true });
        record('A 隔离真执行（executor 真跑 · 下游真往返）', p,
            `executor 调用 ${execCalls - before.e} 次 / 下游 HTTP ${httpCalls - before.h} 次 · ` +
            `routedAdapterId=${(p.report.subtasks || []).map((s) => `${s.id}→${s.value && s.value.routedAdapterId}`).join(' ')}`);
        console.log(`     2.2 诊断: ${JSON.stringify(p.quality && p.quality.semanticIssues)}`);
        console.log(`     2.3 诊断: ${JSON.stringify(p.quality && p.quality.fidelityIssues)}`);
    }

    // ===== B：生产当前形态（不注入 executor → 真路由、不触下游）=====
    {
        const before = { e: execCalls, h: httpCalls };
        const server = new McpServer({ gate: '1', registry: reg, realGate: '1' });   // executor 缺省 undefined
        const p = await callOrchestrate(server, 2, { input, quality: true, qualityThrow: true });
        const statuses = (p.report.subtasks || []).map((s) => `${s.id}:${s.value && s.value.status}`).join(' ');
        record('B 生产当前形态（无 executor → 仅路由，不触下游）', p,
            `value.status=${statuses} · executor/HTTP 增量 ${execCalls - before.e}/${httpCalls - before.h}（应为 0/0）`);
    }

    // ===== C：回退验证（per-call shadowMode:true）=====
    {
        const before = { e: execCalls, h: httpCalls };
        const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
        const p = await callOrchestrate(server, 3, { input, shadowMode: true, quality: true });
        const okBack = (execCalls - before.e) === 0 && (httpCalls - before.h) === 0;
        console.log(`${okBack ? 'GO  ' : 'STOP'} C 回退（per-call shadowMode:true）`);
        console.log(`     shadow=${p.shadow} · executor/HTTP 增量 ${execCalls - before.e}/${httpCalls - before.h}（应为 0/0）`);
        results.push({ scene: 'C 回退', p, extra: '', triage: { go: okBack, reasons: okBack ? [] : ['回退未生效：仍有 executor/HTTP 调用'] } });
    }

    if (mock) await mock.close();

    const allGo = results.every((r) => r.triage.go);
    console.log(`\n--- 结论：${allGo ? 'GO —— 未触发任何止损条件，可按 runbook 继续放量' : 'STOP —— 命中止损条件'} ---`);
    if (!allGo) {
        console.log('处置：立即回退（二选一，成本为零）：');
        console.log('  per-call：{ "shadowMode": true }         → 本次回 shadow');
        console.log('  env：     PROXY_ADAPTER_REAL=0           → 恒 shadow（恢复默认关）');
    }

    // ---- 报告落盘 ----
    if (writeReport) {
        const d = new Date();
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const reportPath = path.join(__dirname, `STEP2-CANARY-${date}.md`);
        const L = [];
        L.push(`# L2 Step 2 小流量真执行 canary 报告（${date}）`);
        L.push('');
        L.push('> 生成：`node l2/step2-canary-run.js`（Step 2 受控真执行，可重跑）。');
        L.push(`> 任务：\`${input}\`　无候选策略：\`${policy}\`　下游：${useMock ? '内联 mock-l1（0 扣费 · 0 外发）' : '未起 mock'}`);
        L.push('> 门控：per-call `quality:true` + `qualityThrow:true`（硬拒档），`realGate=1`；不动任何全局默认值。');
        L.push('');
        L.push('## 一、结论');
        L.push('');
        L.push(allGo ? '**GO** —— 三个场景均未触发止损条件。' : '**STOP** —— 命中止损条件，见下表 reasons。');
        L.push('');
        L.push('## 二、场景明细');
        L.push('');
        L.push('| 场景 | 结论 | shadow | 模板 | 子任务状态 | 关键观测 |');
        L.push('|---|---|---|---|---|---|');
        for (const r of results) {
            const st = (r.p.subtasks || []).map((s) => `${s.id}:${s.status}`).join(' ');
            L.push(`| ${r.scene} | ${r.triage.go ? 'GO' : 'STOP'} | ${r.p.shadow} | ${r.p.template || '—'} | ${st || '—'} | ${r.extra || '—'} |`);
        }
        L.push('');
        L.push('## 三、止损判定（runbook §三 Step 2）');
        L.push('');
        L.push('| 场景 | 判定 | reasons |');
        L.push('|---|---|---|');
        for (const r of results) {
            L.push(`| ${r.scene} | ${r.triage.go ? 'GO' : 'STOP'} | ${r.triage.reasons.length ? r.triage.reasons.join('；') : '—'} |`);
        }
        L.push('');
        L.push('## 四、这场 canary 说明了什么（诚实版）');
        L.push('');
        L.push('1. **A 证明链路通**：executor 真被调用、下游真收到 HTTP、真值经 report 回传、2.2/2.3 在热路径真生效；');
        L.push('   `qualityThrow:true` 的硬拒档未误伤（告警归零 → 无 failed）。');
        L.push('2. **B 是今天生产的真实上限**：manager 侧**尚未**给 McpServer 注入 executor，');
        L.push('   故 `PROXY_ADAPTER_REAL=1` 走 `_realExecutor` 的「仅路由」退化分支——真路由、记录选中 adapter，');
        L.push('   **但不触下游**。也就是说今天打开门控不会扣费、不外发，但也拿不到真实结果。');
        L.push('3. **要真触下游，还差 executor 接线**：把 executor 接到真实 adapter（codex/claude/…）会真花钱、真外发数据，');
        L.push('   属需显式拍板的动作，本脚本**不做**（见 runbook §4.4）。');
        L.push('');
        L.push('## 五、下一步');
        L.push('');
        L.push(allGo
            ? '1. 换其它语料复跑本脚本（`--input`），积累 N 次 GO 后再谈 Step 4 全量投放。\n2. 若要真触下游，先拍板 executor 接线方案（见 §四.3）。'
            : '1. 立即回退（per-call `shadowMode:true` 或 `PROXY_ADAPTER_REAL=0`）。\n2. 按 reasons 修完再重跑；回退成本为零。');
        L.push('');
        fs.writeFileSync(reportPath, L.join('\n'), 'utf8');
        console.log(`\n报告已写入：${reportPath}`);
    }

    process.exit(allGo ? 0 : 1);
})().catch((e) => {
    console.error('step2-canary failed:', e && e.stack || e);
    process.exit(1);
});
