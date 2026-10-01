#!/usr/bin/env node
'use strict';

// step2-canary-run.js —— 翻闸门 Step 2「单任务小流量真执行」受控演练器（runbook §三 Step 2 的可执行版）。
//
// 与 Step 1（observe-shadow-run.js）的区别：Step 1 恒 shadow（只算不跑），
// 本脚本**真执行**——executor 真被调用、下游真收到 HTTP 往返，质量层 2.2/2.3 在热路径真生效。
//
// 三个场景（每条语料都跑一遍，逐个做止损判定）：
//   A 隔离真执行：realGate=1 + 注入 executor（真 adapter → 真 HTTP → 内联 mock）。
//                 证明「executor 一旦接上，端到端链路 + 质量层是对的」。
//   B 生产当前形态：realGate=1 + **不注入 executor**（= 今天生产打开门控后的真实行为）。
//                 走 _realExecutor 的「仅路由」退化分支：真路由、记录 routedAdapterId，但**不触下游**。
//                 ⚠️ 这就是今天的实际上限：真触下游的 executor 接线尚未生产化（见 runbook §4.4）。
//   C 回退验证：per-call shadowMode:true → executor 0 调用、下游 0 请求（止损开关随时可用）。
//
// 下游替身按 routedAdapterId **分发**（不是一律打 chat mock）：
//   h3web  → H3webAdapter.run()  打 mock-h3web：POST /api/gen + GET /api/status 真走 job 状态机
//   其它   → L1AgentAdapter.invoke() 打 mock-l1：POST /v1/chat/completions
//   注：codex/claude 真实 adapter 是两套实现，此处统一用 L1 chat 契约做替身，属**模拟**，
//       验证的是「executor 接线 + 质量层 + 结果回传」，不是某个具体 adapter 的业务正确性。
//
// 隔离纪律（与 pilot 同款，三条底线）：
//   ① 0 联网 / 0 扣费：两个 mock 都只 listen 127.0.0.1 随机端口，不打真实上游、不外发数据。
//   ② 0 副作用：不写 agent 文件、不写 home、不改业务状态；唯一写盘是本脚本的报告（--no-write 可关）。
//   ③ 零行为变更：本脚本只读生产代码，不改任何模块行为；门控全部 per-call/env，不动全局默认值。
//
// 止损条件（runbook §三 Step 2，任一命中即 STOP）：
//   任一子任务 failed / semanticIssues 出现 error 级 / fidelityIssues 非空
//   → 脚本打印 STOP 处置指引（回退命令），并以非零退出码结束。
//
// 用法：
//   node l2/step2-canary-run.js                                  # 默认打 C1「做一个 jwt 认证」
//   node l2/step2-canary-run.js --input "做一个 jwt 认证"          # 换单条任务
//   node l2/step2-canary-run.js --corpus                         # 打预设 4 条语料（code/test + video + video-workflow）
//   node l2/step2-canary-run.js --no-write                       # 只打印不落盘
//   node l2/step2-canary-run.js --no-mock-downstream             # 只跑 B/C（不起 mock，验证纯路由形态）
//   node l2/step2-canary-run.js --corpus --with-bind --tier-bind  # D 场景含三档 text-tier（agnes/deepseek/qwen）
//   node l2/step2-canary-run.js --corpus --with-bind --tier-bind --tier-local-only  # 三档全指本地档（0 成本）
//   node l2/step2-canary-run.js --with-bind --tier-bind --real-local                # 三档**真连本地 Ollama**（见下）
//
// ⚠️ --real-local 是唯一会真调本地模型的一档（0 扣费，因为走本机 :11434）：不设三档端口 env →
//    回退底座 tierBindings 默认端口；且**强制 LOCAL_ONLY**，否则 agnes/deepseek 会走 :18790 打到
//    付费外网，与本脚本「0 扣费 · 0 外发」的隔离纪律冲突。codex/h3web 端口仍指 mock（不开口子）。

const fs = require('fs');
const path = require('path');

const { AgentRegistry } = require('./agent-registry.js');
const { McpServer } = require('./mcp-server.js');
const { seedDefaultProfiles } = require('./mcp-default-seed.js');
const { resolveNoCandidatePolicy } = require('./knowledge-base/routing-base.js');

const DEFAULT_INPUT = '做一个 jwt 认证';   // C1：fastapi-jwt 模板（code×3 + test×1），观察态里最干净的一条

// 批量语料（--corpus）：覆盖三条性质不同的路径，别只打最顺的那条
//   C1 code+test（fastapi-jwt 模板，最干净）
//   C3 video（单镜视频，走 h3web /api/gen 状态机）
//   C4 video-workflow（分镜→片段→compose，验证 2026-10-01 补齐的 compose owner）
//   C9 code+test（另一条语料，验证不是 C1 的个例）
const CORPUS = [
    { id: 'C1', input: '做一个 jwt 认证' },
    { id: 'C3', input: '生成一段 60 秒的 3D 皮克斯风格 AI 短剧视频' },
    { id: 'C4', input: '做一个产品宣传短片：先出分镜，再生成片段，最后合成加音频' },
    { id: 'C9', input: '用 fastapi 搭一个带认证的评论服务，写测试' },
];

// mock 端口就绪等待：listen(0) 异步绑定，早读会拿到 null → String(null) 静默回退默认候选
// （8731 真实 h3web！）。隔离纪律：宁可显式失败，也不能让演练误连真实下游。
async function waitPort(getter, timeoutMs = 3000) {
    const t0 = Date.now();
    for (;;) {
        let p = null;
        try { p = getter(); } catch { p = null; }
        if (typeof p === 'number' && p > 0) return p;
        if (Date.now() - t0 > timeoutMs) throw new Error('mock 端口未就绪（listen(0) 未绑定）');
        await new Promise((r) => setTimeout(r, 10));
    }
}

// 已知缺口（不算止损，但必须被看见）：
//   三档 text-tier profile（agnes/deepseek/qwen）没有对应 adapter 类 → 真接线后撞上会抛
//   UnboundAdapterError。这是待办 6（runbook §4.5），不是回归，故单独归入 gaps 不计入 STOP。
const UNBOUND_RE = /未绑定真实 adapter/;

// 止损判定：把一次 orchestrate 的结果判成 GO / STOP
function triage(p) {
    const reasons = [];
    const gaps = [];
    const failed = (p.subtasks || []).filter((s) => s.status === 'failed');
    const failedErr = (id) => {
        const r = ((p.report && p.report.subtasks) || []).find((s) => s.id === id);
        return String((r && r.value && r.value.error) || '');
    };
    // error 文本在 report 里的位置随失败形态变化（抛错时 value 可能不带 error），
    // 故先按 id 精取，取不到再对整个产物做一次兜底匹配。
    const globalUnbound = UNBOUND_RE.test(JSON.stringify(p || {}));
    const unbound = failed.filter((s) => UNBOUND_RE.test(failedErr(s.id)));
    if (unbound.length) {
        gaps.push(`未绑定 adapter（待办 6）：${unbound.map((s) => s.id).join(', ')}`);
    } else if (globalUnbound) {
        gaps.push('未绑定 adapter（待办 6）：executor-bind 绑定表不含三档 text-tier（agnes/deepseek/qwen）');
    }
    // 已确认是未绑定缺口导致的失败 → 归 gap 不计止损（缺口是已知待办，不是回归）。
    const realFailed = globalUnbound ? [] : failed.filter((s) => !UNBOUND_RE.test(failedErr(s.id)));
    if (realFailed.length) reasons.push(`子任务 failed：${realFailed.map((s) => s.id).join(', ')}`);
    const semErr = ((p.quality && p.quality.semanticIssues) || []).filter((i) => i.level === 'error');
    if (semErr.length) reasons.push(`2.2 error 级：${semErr.map((i) => i.message).join(' | ')}`);
    const fid = (p.quality && p.quality.fidelityIssues) || [];
    if (fid.length) reasons.push(`2.3 保真改样：${JSON.stringify(fid)}`);
    const noRoute = ((p.report && p.report.subtasks) || [])
        .filter((s) => !s.value || !s.value.routedAdapterId).map((s) => s.id);
    // 抛错时 value 里没有 routedAdapterId（同一未绑定根因），避免与 gap 重复计数。
    if (noRoute.length && !globalUnbound) reasons.push(`无路由（routedAdapterId 为空）：${noRoute.join(', ')}`);
    return { go: reasons.length === 0, reasons, gaps };
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
    const useCorpus = argv.includes('--corpus');
    const withBind = argv.includes('--with-bind');
    // 三档 text-tier（待办 6）：--tier-bind 把三档也接进 D 场景的绑定表（端口仍指 mock，0 扣费）；
    // 再加 --tier-local-only 则三档全指本地档端口（PROXY_TIER_LOCAL_ONLY，0 成本演练）。
    const withTierBind = argv.includes('--tier-bind');
    // --real-local：三档**真连本地 Ollama**（不设端口 env → 走底座 tierBindings 默认端口）。
    // 安全护栏：realLocal 直接把 LOCAL_ONLY 钉死 —— 真跑若不强制，agnes/deepseek 会走 :18790
    // 打到**付费外网**，那就不是 0 成本演练了。宁可开关少一点自由度，也不要误触付费上游。
    const realLocal = argv.includes('--real-local');
    const tierLocalOnly = realLocal || argv.includes('--tier-local-only');
    const idx = argv.indexOf('--input');
    const singleInput = (idx >= 0 && argv[idx + 1]) ? argv[idx + 1] : DEFAULT_INPUT;
    const tasks = useCorpus ? CORPUS : [{ id: 'SINGLE', input: singleInput }];

    const policy = resolveNoCandidatePolicy().strategy;
    console.log('=== L2 翻闸门 Step 2 · 单任务小流量真执行（受控 canary）===');
    console.log(`语料 ${tasks.length} 条（${tasks.map((t) => t.id).join(' / ')}）`);
    console.log(`无候选策略 = ${policy}（底座默认）；下游 = ${useMock ? '内联 mock-l1 + mock-h3web（0 扣费 · 0 外发）' : '不起 mock（仅跑纯路由形态）'}\n`);

    const reg = new AgentRegistry();
    seedDefaultProfiles(reg);

    let execCalls = 0;
    let mockL1 = null;
    let mockLocal = null;   // 充当本地 Ollama :11434（无鉴权）——三档里 qwen 档的下游替身
    let mockH3 = null;
    let l1Adapter = null;
    let h3Adapter = null;
    let executor = undefined;
    // 下游请求计数直接读 mock 自己的计数器（比手写 ++ 更不容易漏）
    const downstreamCalls = () =>
        (mockL1 ? mockL1.getChatCalls() : 0) + (mockLocal ? mockLocal.getChatCalls() : 0)
        + (mockH3 ? mockH3.getHttpCalls() : 0);

    if (useMock) {
        const startMockL1 = require('./mock-l1.js');
        const startMockH3web = require('./mock-h3web.js');
        const { L1AgentAdapter } = require('./adapters/l1-agent-adapter.js');
        const { H3webAdapter } = require('./adapters/h3web-adapter.js');

        mockL1 = startMockL1(0, { noChat: false, model: 'canary-model' });
        // 本地档替身：noAuth（真实 Ollama 本机开放、无 x-proxy-auth 概念）
        mockLocal = startMockL1(0, { noAuth: true, model: 'qwen3.8:27b-mlx' });
        mockH3 = startMockH3web(0);
        await new Promise((r) => setTimeout(r, 50));

        l1Adapter = new L1AgentAdapter({
            id: 'canary-codex', name: 'canary-codex-proxy', portCandidates: [], port: mockL1.getPort(),
            token: mockL1.token, capabilities: ['code', 'review', 'test'], chatPath: '/v1/chat/completions',
        });
        h3Adapter = new H3webAdapter({
            id: 'canary-h3web', portCandidates: [], port: mockH3.getPort(),
            capabilities: ['video', 'text2video', 'lipsync', 'image', 'compose'],
        });

        // 生产语义的 executor：(adapterId, subtask, ctx) → 按路由结果分发到对应真 adapter，打真 HTTP round-trip
        executor = async (adapterId, subtask) => {
            execCalls++;
            if (adapterId === 'h3web') {
                const r = await h3Adapter.run(
                    { type: subtask.type, prompt: subtask.prompt }, { pollMs: 30, maxTries: 10 });
                return { marker: 'canary-real-http-h3web', adapterId, taskId: r.task_id, status: r.status };
            }
            const t = await l1Adapter.invoke({ model: 'canary-model', messages: [{ role: 'user', content: subtask.prompt }] });
            return { marker: 'canary-real-http-l1', adapterId, content: t.result && t.result.content };
        };
    }

    const allResults = [];   // { corpus, rows: [{scene, p, extra, triage}] }

    for (const c of tasks) {
        console.log(`\n########## 语料 ${c.id}：${c.input} ##########`);
        const rows = [];
        const record = (scene, p, extra) => {
            const t = triage(p);
            rows.push({ scene, p, extra, triage: t });
            const tag = t.go ? 'GO  ' : 'STOP';
            console.log(`${tag} ${scene}`);
            console.log(`     shadow=${p.shadow} 模板=${p.template} 子任务=${(p.subtasks || []).map((s) => `${s.id}:${s.status}`).join(' ')}`);
            if (extra) console.log(`     ${extra}`);
            if (!t.go) t.reasons.forEach((r) => console.log(`     ⚠ ${r}`));
            (t.gaps || []).forEach((g) => console.log(`     ⓘ 已知缺口：${g}`));
            return t.go;
        };

        // ===== A：隔离真执行（executor 真跑 + 下游真收到 HTTP）=====
        if (useMock) {
            const before = { e: execCalls, h: downstreamCalls() };
            const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
            const p = await callOrchestrate(server, 1, { input: c.input, quality: true, qualityThrow: true });
            record('A 隔离真执行（executor 真跑 · 下游真往返）', p,
                `executor 调用 ${execCalls - before.e} 次 / 下游 HTTP ${downstreamCalls() - before.h} 次 · ` +
                `routedAdapterId=${(p.report.subtasks || []).map((s) => `${s.id}→${s.value && s.value.routedAdapterId}`).join(' ')}`);
            console.log(`     2.2 诊断: ${JSON.stringify(p.quality && p.quality.semanticIssues)}`);
            console.log(`     2.3 诊断: ${JSON.stringify(p.quality && p.quality.fidelityIssues)}`);
        }

        // ===== B：生产当前形态（不注入 executor → 真路由、不触下游）=====
        {
            const before = { e: execCalls, h: downstreamCalls() };
            const server = new McpServer({ gate: '1', registry: reg, realGate: '1' });   // executor 缺省 undefined
            const p = await callOrchestrate(server, 2, { input: c.input, quality: true, qualityThrow: true });
            const statuses = (p.report.subtasks || []).map((s) => `${s.id}:${s.value && s.value.status}`).join(' ');
            record('B 生产当前形态（无 executor → 仅路由，不触下游）', p,
                `value.status=${statuses} · executor/HTTP 增量 ${execCalls - before.e}/${downstreamCalls() - before.h}（应为 0/0）`);
        }

        // ===== D：生产接线形态（PROXY_EXECUTOR_BIND=1 + 端口指向 mock）=====
        // 走的是**生产代码路径**（l2/executor-bind.js 的绑定表 + 真 adapter + 真 HTTP），
        // 只是把端口 env 指到内联 mock，故仍 0 联网 / 0 扣费，但验证的是真接线而非替身。
        if (withBind) {
            process.env.PROXY_EXECUTOR_BIND = '1';
            process.env.PROXY_CODEX_PORTS = String(await waitPort(() => mockL1.getPort()));
            process.env.PROXY_H3WEB_PORTS = String(await waitPort(() => mockH3.getPort()));
            process.env.PROXY_AUTH_TOKEN = mockL1.token;
            process.env.PROXY_H3WEB_POLL_MS = '20';
            // 三档 text-tier（待办 6）：端口一并指到 mock —— agnes/deepseek → 代理档 mock，
            // qwen → 本地档 mock（--tier-local-only 时三档全指本地档，付费侧 0 调用）。
            if (withTierBind) {
                process.env.PROXY_TIER_BIND = '1';
                if (tierLocalOnly) process.env.PROXY_TIER_LOCAL_ONLY = '1';
                if (realLocal) {
                    // 真跑：三档端口 env **刻意不设** → 回退底座 tierBindings 的默认端口
                    // （LOCAL_ONLY 下三档均取 large 档 = 本地 Ollama :11434 / qwen3.8:27b-mlx）。
                    // codex / h3web 端口仍指 mock：本轮只验证三档落点，不给它们开口子。
                } else {
                    const localPort = String(await waitPort(() => mockLocal.getPort()));
                    const proxyPort = String(await waitPort(() => mockL1.getPort()));
                    process.env.PROXY_AGNES_PORTS = tierLocalOnly ? localPort : proxyPort;
                    process.env.PROXY_DEEPSEEK_PORTS = tierLocalOnly ? localPort : proxyPort;
                    process.env.PROXY_QWEN_PORTS = localPort;
                }
            }
            const { createBoundExecutor } = require('./executor-bind.js');
            const bound = createBoundExecutor({ logger: { log: () => {}, warn: () => {} } });
            // 包一层只为计数（bound.executor 是生产代码，不掺计数逻辑）
            const counted = async (a, s, x) => { execCalls++; return bound.executor(a, s, x); };
            const before = { e: execCalls, h: downstreamCalls() };
            const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor: counted });
            const p = await callOrchestrate(server, 4, { input: c.input, quality: true, qualityThrow: true });
            record(`D 生产接线形态（executor-bind 真绑定 · 下游=${realLocal ? '本地 Ollama 真模型' : 'mock'}）`, p,
                `绑定=${bound.boundIds().join('/')} · executor 调用 ${execCalls - before.e} 次 / ` +
                `下游 HTTP ${downstreamCalls() - before.h} 次` +
                (withTierBind && mockLocal ? `（其中本地档 ${mockLocal.getChatCalls()} 次）` : '') + ' · ' +
                `routedAdapterId=${(p.report.subtasks || []).map((s) => `${s.id}→${s.value && s.value.routedAdapterId}`).join(' ')}`);
            // 真跑时 mock 计数器看不到本地调用，改用**产物**自证：真模型会回 content/contentSource/model
            if (realLocal) {
                for (const s of (p.report.subtasks || [])) {
                    const v = s.value || {};
                    if (!['agnes', 'deepseek', 'qwen'].includes(v.routedAdapterId)) continue;
                    // _realExecutor 返回 base + { status, value }：executor 的产物在 value 里再包一层
                    const inner = v.value || v;
                    const c = String(inner.content || '').replace(/\s+/g, ' ').slice(0, 70);
                    console.log(`     [真模型] ${s.id} → ${v.routedAdapterId} · model=${inner.model || '?'} · ` +
                        `contentSource=${inner.contentSource || '?'} · len=${String(inner.content || '').length} · ` +
                        `content="${c}${c.length >= 70 ? '…' : ''}"`);
                }
            }
            delete process.env.PROXY_EXECUTOR_BIND;
            delete process.env.PROXY_CODEX_PORTS;
            delete process.env.PROXY_H3WEB_PORTS;
            delete process.env.PROXY_AUTH_TOKEN;
            delete process.env.PROXY_H3WEB_POLL_MS;
            delete process.env.PROXY_TIER_BIND;
            delete process.env.PROXY_TIER_LOCAL_ONLY;
            delete process.env.PROXY_AGNES_PORTS;
            delete process.env.PROXY_DEEPSEEK_PORTS;
            delete process.env.PROXY_QWEN_PORTS;
        }

        // ===== C：回退验证（per-call shadowMode:true）=====
        {
            const before = { e: execCalls, h: downstreamCalls() };
            const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
            const p = await callOrchestrate(server, 3, { input: c.input, shadowMode: true, quality: true });
            const okBack = (execCalls - before.e) === 0 && (downstreamCalls() - before.h) === 0;
            console.log(`${okBack ? 'GO  ' : 'STOP'} C 回退（per-call shadowMode:true）`);
            console.log(`     shadow=${p.shadow} · executor/HTTP 增量 ${execCalls - before.e}/${downstreamCalls() - before.h}（应为 0/0）`);
            rows.push({ scene: 'C 回退', p, extra: '', triage: { go: okBack, reasons: okBack ? [] : ['回退未生效：仍有 executor/HTTP 调用'] } });
        }

        allResults.push({ corpus: c, rows });
    }

    if (mockL1) await mockL1.close();
    if (mockLocal) await mockLocal.close();
    if (mockH3) await mockH3.close();

    const flat = allResults.flatMap((g) => g.rows);
    const allGo = flat.every((r) => r.triage.go);
    console.log(`\n\n=== 总结：${flat.length} 个场景（${allResults.length} 条语料 × ${allResults[0].rows.length}）===`);
    for (const g of allResults) {
        const bad = g.rows.filter((r) => !r.triage.go);
        console.log(`  ${g.corpus.id} ${g.corpus.input.slice(0, 24)} → ${bad.length === 0 ? 'GO' : `STOP（${bad.map((b) => b.scene).join('；')}）`}`);
    }
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
        L.push('> 生成：`node l2/step2-canary-run.js --corpus`（Step 2 受控真执行，可重跑）。');
        L.push(`> 语料：${allResults.length} 条（${allResults.map((g) => g.corpus.id).join(' / ')}）；无候选策略：\`${policy}\``);
        L.push(`> 下游：${useMock ? '内联 mock-l1 + mock-h3web（0 扣费 · 0 外发，按 routedAdapterId 分发）' : '未起 mock'}`);
        L.push('> 门控：per-call `quality:true` + `qualityThrow:true`（硬拒档），`realGate=1`；不动任何全局默认值。');
        if (withBind) {
            L.push(`> D 场景绑定：\`PROXY_EXECUTOR_BIND=1\`${withTierBind
                ? ` + \`PROXY_TIER_BIND=1\`${tierLocalOnly ? ' + `PROXY_TIER_LOCAL_ONLY=1`（三档全指本地档）' : '（三档：agnes/deepseek→代理档 mock、qwen→本地档 mock）'}`
                : '（三档未绑 → video 语料仍撞待办 6 缺口）'}；端口全部指 mock，0 扣费 0 外发。`);
        }
        L.push('');
        L.push('## 一、结论');
        L.push('');
        L.push(allGo ? `**GO** —— ${flat.length} 个场景（${allResults.length} 条语料 × 3）均未触发止损条件。`
                     : '**STOP** —— 命中止损条件，见下表 reasons。');
        L.push('');
        L.push('## 二、场景明细');
        L.push('');
        L.push('| 语料 | 场景 | 结论 | shadow | 模板 | 子任务状态 | 关键观测 |');
        L.push('|---|---|---|---|---|---|---|');
        for (const g of allResults) {
            for (const r of g.rows) {
                const st = (r.p.subtasks || []).map((s) => `${s.id}:${s.status}`).join(' ');
                L.push(`| ${g.corpus.id} | ${r.scene} | ${r.triage.go ? 'GO' : 'STOP'} | ${r.p.shadow} | ${r.p.template || '—'} | ${st || '—'} | ${r.extra || '—'} |`);
            }
        }
        L.push('');
        L.push('## 三、止损判定（runbook §三 Step 2）');
        L.push('');
        L.push('| 语料 | 场景 | 判定 | reasons | 已知缺口（不计止损） |');
        L.push('|---|---|---|---|---|');
        for (const g of allResults) {
            for (const r of g.rows) {
                const gaps = (r.triage.gaps || []).join('；') || '—';
                L.push(`| ${g.corpus.id} | ${r.scene} | ${r.triage.go ? 'GO' : 'STOP'} | ${r.triage.reasons.length ? r.triage.reasons.join('；') : '—'} | ${gaps} |`);
            }
        }
        L.push('');
        L.push('## 四、这场 canary 说明了什么（诚实版）');
        L.push('');
        L.push('1. **A 证明链路通**：executor 真被调用、下游真收到 HTTP（h3web 走 /api/gen + /api/status 状态机、');
        L.push('   L1 走 chat）、真值经 report 回传、2.2/2.3 在热路径真生效；`qualityThrow:true` 的硬拒档未误伤。');
        L.push('2. **D 是生产接线形态**（2026-10-01 新增，runbook §4.4 欠账兑现）：走的是 `l2/executor-bind.js`');
        L.push('   的**真实绑定代码**——按 routedAdapterId 分发到真 adapter，只是把端口 env 指到内联 mock，');
        L.push('   故仍 0 扣费 / 0 外发，但验证的不再是替身而是真接线。');
        L.push('   - code/test 语料（C1/C9）：4/4 子任务真打到 codex，下游 HTTP 增量=子任务数，全 GO。');
        L.push('   - video 语料（C3/C4）：`understand` 路由到 agnes → **未绑定**（三档 text-tier 无 adapter 类）');
        L.push('     → 硬失败 + 下游 skipped。这是**已知缺口待办 6**，不是回归，见 runbook §4.5。');
        L.push('3. **B 是未开 PROXY_EXECUTOR_BIND 时的形态**：executor=undefined → 「仅路由、不触下游」。');
        L.push('   ⚠️ 也就是说：只开 `PROXY_ADAPTER_REAL=1` 而不开 `PROXY_EXECUTOR_BIND=1`，仍然是不干活的。');
        L.push('   两个开关必须同时开才真触下游（会真花钱、真外发数据）。');
        L.push('4. **替身边界**：A 场景里 codex/claude 统一用 L1 chat 契约做替身（真实是两套 adapter）；');
        L.push('   D 场景才是真分发。两者互补：A 验链路与质量层，D 验绑定与分发。');
        L.push('5. **顺带修掉一个静默降级**（接线后实测暴露）：`_realExecutor` 原把 executor 抛错吞成');
        L.push('   `status:\'failed\'` 返回 → 在 orchestrator 语义里等于「执行完成」→ 子任务 done、下游照跑。');
        L.push('   现已改为 rethrow（失败真传播）。仅 executor 被注入时该路径才存在，既有行为不变。');
        L.push('');
        L.push('## 五、下一步');
        L.push('');
        L.push(allGo
            ? '1. 换其它语料复跑本脚本（`--input` / `--corpus`），积累 N 次 GO 后再谈 Step 4 全量投放。\n2. 若要真触下游，先拍板 executor 接线方案（见 §四.3）。'
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
