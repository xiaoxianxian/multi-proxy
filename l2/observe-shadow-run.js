#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// observe-shadow-run.js —— 翻闸门 Step 1「观察态」真跑器（runbook §三 Step 1 的可执行版）。
//
// 干什么：
//   用**生产真实入口**跑一批真实业务需求语料，只开质量层（PROXY_L2_QUALITY=1），
//   **保持 shadow**（PROXY_ADAPTER_REAL 不设 → 恒 shadow；REST 侧 per-call shadowMode 默认 true），
//   把 2.2 语义审阅的告警 + 路由层「无候选/档位缺口」诊断收集成一份报告。
//
// 为什么需要它：
//   runbook Step 1 原是手工步骤（"先看一轮真实任务流里的审阅告警"）。手工跑不可复现、不可比对。
//   本脚本把它固化：同一批语料、随时可重跑、结果可 diff → 翻 reject 之前有据可依。
//
// 非侵入纪律（与 l2 内核同构，三条底线）：
//   ① 0 联网 / 0 扣费：shadow 恒开，不注入 executor，不触任何真实 adapter；
//      route() 只做「该谁来跑」的决策计算，不发任何下游请求。
//   ② 0 副作用：不写 agent 文件、不写 home、不改任何业务状态；唯一写盘是本脚本的报告文件（--no-write 可关）。
//      路由预演（route()）**只算决策**：不发请求、不触发 executor，因此 reject 口径下也不会真失败。
//   ③ 零行为变更：本脚本只读生产代码，不改任何模块行为。
//
// 用法：
//   node l2/observe-shadow-run.js                 # 默认：MCP + REST 两入口真跑，写报告
//   node l2/observe-shadow-run.js --no-write      # 只打印，不落盘
//   node l2/observe-shadow-run.js --mcp-only      # 只跑 MCP 入口（REST 需 express，可跳过）
//   PROXY_L2_NOCANDIDATE=observe node l2/observe-shadow-run.js  # 回退到观察口径再跑一遍（默认已是 reject）
//
// 输出解读：
//   warn  = 拆解产物某 type 当前无 adapter 承接（诊断，不阻塞）
//   error = 路由层根本派不出去（chosen=null）/ 模态不匹配 —— 切 reject 前必须清零

const fs = require('fs');
const path = require('path');

const { AgentRegistry } = require('./agent-registry.js');
const { PluginRuntime } = require('./plugin-runtime.js');
const { RouteEngine } = require('./route-engine.js');
const { McpServer } = require('./mcp-server.js');
const { seedDefaultProfiles } = require('./mcp-default-seed.js');
const { reviewRouteDecision } = require('./semantic-review.js');
const { resolveNoCandidatePolicy } = require('./knowledge-base/routing-base.js');
const { templateDecompose } = require('./decomposer.js');   // 仅用于补齐 complexity（同一输入同一模板，确定性）

// ---- 真实业务需求语料（本项目/周边真实任务句式，覆盖三个模板路径）----
// 覆盖意图：fastapi-jwt（code/test）、video-workflow（plan/video/compose）、兜底 single(code)。
// 改动语料 = 改动观察口径，请连报告一起重跑，别只改一处。
const CORPUS = [
    { id: 'C1', input: '做一个 jwt 认证' },
    { id: 'C2', input: '实现 FastAPI 的 JWT 刷新令牌流程，并补单元测试' },
    { id: 'C3', input: '生成一段 60 秒的 3D 皮克斯风格 AI 短剧视频' },
    { id: 'C4', input: '做一个产品宣传短片：先出分镜，再生成片段，最后合成加音频' },
    { id: 'C5', input: '给 multi-proxy 的 route-engine 加熔断降级开关' },
    { id: 'C6', input: '把 h3web 的分镜故事板改成支持拖拽排序，并出一份设计文档' },
    { id: 'C7', input: '优化 l2 编排内核的 prompt cache 命中率并做压测' },
    { id: 'C8', input: '审核平台黄金集标注指南 v1 起草，附 10 篇示例标注' },
    { id: 'C9', input: '用 fastapi 搭一个带认证的评论服务，写测试' },
    { id: 'C10', input: '视频生成任务里角色漂移怎么解决' },
];

// ---- 小工具 ----
function uniq(arr) { return Array.from(new Set(arr)); }
function pad(s, n) { const str = String(s); return str + ' '.repeat(Math.max(0, n - str.length)); }

// 路由预演：对单个子任务算一次 route() 决策 + 2.2b 决策审阅。
// 声明：纯计算，不发请求（RouteEngine 构造 shadowMode:true，且此处不注入 executor）。
function previewRoute(routeEngine, st) {
    let decision = null;
    let routeError = null;
    try {
        decision = routeEngine.route({ id: st.id, type: st.type, complexity: st.complexity, prompt: st.prompt });
    } catch (e) {
        routeError = e && e.message || String(e);   // reject 策略下 route 不抛（抛在执行器），此处仅兜底
    }
    const review = reviewRouteDecision(decision, st);
    return {
        id: st.id,
        type: st.type,
        complexity: st.complexity || 'medium',
        chosen: (decision && decision.chosen && decision.chosen.adapterId) || null,
        expectedTier: (decision && decision.expectedTier) || null,
        noCandidate: !!(decision && decision.noCandidate),
        rejected: !!(decision && decision.rejected),
        policy: (decision && decision.noCandidatePolicy) || null,
        reason: (decision && decision.noCandidateReason) || null,
        issues: review.issues,
        routeError,
    };
}

// ---- 入口 A：MCP 真实入口（stdio bridge 的同一条 callToolAsync 路径）----
function buildMcpServer() {
    const registry = new AgentRegistry();
    seedDefaultProfiles(registry);
    const routeEngine = new RouteEngine({
        registry,
        pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }),
        shadowMode: true,
    });
    // gate='1' 开 bridge；realGate 不传 → 默认 '0'（恒 shadow，不触下游）
    const server = new McpServer({ gate: '1', registry, routeEngine });
    server.initialized = true;
    return { server, routeEngine, registry };
}

async function callOrchestrate(server, input) {
    const res = await server.handleMessageAsync({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'orchestrate', arguments: { input, quality: true } },
    });
    return JSON.parse(res.result.content[0].text);
}

// ---- 入口 B：REST 真实入口（express 真起 HTTP，跑 manager 的 orchestration 路由）----
async function runRestEntry(corpus) {
    let express;
    try {
        express = require('express');
    } catch (e) {
        return { skipped: true, reason: 'express not resolvable from l2/ (run from multi-proxy-manager or install deps)' };
    }
    process.env.PROXY_ORCHESTRATION = '1';       // 门控：编排路由放行（生产同款门控）
    process.env.PROXY_L2_QUALITY = '1';          // 质量层开（与 MCP 入口同一门控语义）
    const orchestration = require('../multi-proxy-manager/routes/orchestration.js');

    const app = express();
    app.use(express.json());
    app.use('/api/orchestration', orchestration);

    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const out = [];
    try {
        for (const c of corpus) {
            const resp = await fetch(`${base}/api/orchestration/run`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ input: c.input, quality: true, shadowMode: true }),
            });
            const body = await resp.json();
            out.push({ id: c.id, status: resp.status, body });
        }
    } finally {
        server.close();
    }
    return { skipped: false, results: out };
}

// ---- 主流程 ----
(async () => {
    const argv = process.argv.slice(2);
    const writeReport = !argv.includes('--no-write');
    const mcpOnly = argv.includes('--mcp-only');

    // 观察态门控：质量层开，真执行恒关（shadow）。策略取自 env（默认 observe）。
    process.env.PROXY_L2_QUALITY = '1';
    delete process.env.PROXY_ADAPTER_REAL;
    const policy = resolveNoCandidatePolicy();

    console.log('=== L2 翻闸门 Step 1 · 观察态真跑（shadow 恒开 · 0 联网 · 0 副作用）===');
    console.log(`无候选策略 policy=${policy.strategy}（底座默认 2026-10-01 起 = reject；env PROXY_L2_NOCANDIDATE 可覆盖为 observe / fallback-default / reject）`);
    console.log(`语料 ${CORPUS.length} 条 · 入口 ${mcpOnly ? 'MCP' : 'MCP + REST'}\n`);

    const { server, routeEngine } = buildMcpServer();
    const rows = [];

    for (const c of CORPUS) {
        const r = await callOrchestrate(server, c.input);
        const semanticIssues = (r.quality && r.quality.semanticIssues) || [];
        const fidelityIssues = (r.quality && r.quality.fidelityIssues) || [];
        // 入口产物只暴露 {id,type,status}（orchestrator.js:107），complexity 不在其中。
        // 路由需要 complexity 定档位 → 用同输入再跑一次模板拆解按 id 补齐（模板拆解确定性强，
        // 与入口产物同源同参数，逐字一致；纯本地计算，不触下游）。
        const full = templateDecompose(c.input);
        const cxById = new Map(full.subtasks.map((s) => [s.id, s.complexity]));
        const previews = (r.subtasks || []).map((st) =>
            previewRoute(routeEngine, { id: st.id, type: st.type, complexity: cxById.get(st.id) }));
        rows.push({
            corpus: c,
            template: r.template,
            shadow: r.shadow,
            subtaskCount: previews.length,
            semanticIssues,
            fidelityIssues,
            previews,
        });
    }

    // ---- 汇总统计 ----
    const totalSubtasks = rows.reduce((n, r) => n + r.subtaskCount, 0);
    const noCandPreviews = rows.flatMap((r) => r.previews).filter((p) => p.noCandidate);
    const rejectedPreviews = rows.flatMap((r) => r.previews).filter((p) => p.rejected);
    const routeErrors = rows.flatMap((r) => r.previews).filter((p) => p.routeError);
    const allIssues = rows.flatMap((r) => r.previews.flatMap((p) => p.issues));
    const errIssues = allIssues.filter((i) => i.level === 'error');
    const warnIssues = allIssues.filter((i) => i.level === 'warn');
    const byType = {};
    for (const p of rows.flatMap((r) => r.previews)) {
        byType[p.type] = byType[p.type] || { count: 0, noCandidate: 0, chosen: new Set(), tiers: new Set() };
        byType[p.type].count += 1;
        if (p.noCandidate) byType[p.type].noCandidate += 1;
        if (p.chosen) byType[p.type].chosen.add(p.chosen);
        byType[p.type].tiers.add(p.expectedTier);
    }

    // ---- 控制台输出 ----
    console.log('--- 逐任务 ---');
    for (const r of rows) {
        const flags = [];
        if (r.semanticIssues.length) flags.push(`2.2warn×${r.semanticIssues.length}`);
        if (r.fidelityIssues.length) flags.push(`2.3×${r.fidelityIssues.length}`);
        const nc = r.previews.filter((p) => p.noCandidate).length;
        if (nc) flags.push(`无候选×${nc}`);
        const errs = r.previews.flatMap((p) => p.issues).filter((i) => i.level === 'error').length;
        if (errs) flags.push(`ERROR×${errs}`);
        console.log(`${pad(r.corpus.id, 4)} ${pad(r.template, 15)} n=${r.subtaskCount} shadow=${r.shadow} ${flags.length ? '⚠ ' + flags.join(' ') : '✓ clean'}`);
    }

    console.log('\n--- 按 capability tag 汇总（路由预演）---');
    console.log(`${pad('type', 10)}${pad('n', 5)}${pad('无候选', 8)}${pad('档位', 10)}chosen`);
    for (const [type, v] of Object.entries(byType)) {
        console.log(`${pad(type, 10)}${pad(v.count, 5)}${pad(v.noCandidate, 8)}${pad(Array.from(v.tiers).join('/'), 10)}${Array.from(v.chosen).join(',') || '—'}`);
    }

    console.log('\n--- 告警明细 ---');
    if (!allIssues.length && !noCandPreviews.length) {
        console.log('（无）');
    } else {
        for (const r of rows) {
            for (const i of r.semanticIssues) console.log(`[2.2 warn] ${r.corpus.id} ${i.subtaskId || ''} ${i.message}`);
            for (const p of r.previews) {
                for (const i of p.issues) console.log(`[2.2 ${i.level}] ${r.corpus.id}/${p.id} ${i.message}`);
            }
        }
    }

    const rest = mcpOnly ? { skipped: true, reason: '--mcp-only' } : await runRestEntry(CORPUS);
    console.log('\n--- REST 入口（manager 真实路由 · 真 HTTP）---');
    if (rest.skipped) {
        console.log(`跳过：${rest.reason}`);
    } else {
        for (const r of rest.results) {
            const q = r.body && r.body.quality;
            const n = (r.body && r.body.subtasks && r.body.subtasks.length) || 0;
            console.log(`${pad(r.id, 4)} HTTP ${r.status} template=${pad(r.body && r.body.template, 15)} n=${n} 2.2warn=${(q && q.semanticIssues.length) || 0} 2.3=${(q && q.fidelityIssues.length) || 0}`);
        }
    }

    console.log('\n--- 结论 ---');
    console.log(`子任务总数 ${totalSubtasks} · 无候选 ${noCandPreviews.length} · 硬拒(rejected) ${rejectedPreviews.length} · error ${errIssues.length} · warn ${warnIssues.length}`);
    const dirtyTypes = Object.entries(byType).filter(([, v]) => v.noCandidate > 0).map(([t]) => t);
    console.log(dirtyTypes.length
        ? `⚠ 存在无 adapter 承接的 capability：${uniq(dirtyTypes).join(', ')} —— 切 reject 前必须补齐 owner，否则这些子任务会硬失败。`
        : '✓ 全部 capability 均有 adapter 承接 —— 具备切 reject 的能力前提。');

    // ---- 报告落盘 ----
    if (writeReport) {
        // 本地日期（非 UTC）：toISOString 会把 GMT+8 的凌晨算成前一天，报告名会错位。
        const d = new Date();
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const reportPath = path.join(__dirname, `OBSERVE-REPORT-${date}.md`);
        const lines = [];
        lines.push(`# L2 观察态真跑报告（${date}）`);
        lines.push('');
        lines.push('> 生成：`node l2/observe-shadow-run.js`（Step 1 观察态，可重跑、可 diff）。');
        lines.push(`> 姿态：质量层开（\`PROXY_L2_QUALITY=1\`）+ shadow 恒开（不触下游 adapter）；无候选策略 \`${policy.strategy}\`。`);
        lines.push('> 入口：MCP（`McpServer.callToolAsync`）' + (rest.skipped ? '' : ' + REST（`POST /api/orchestration/run`，真起 HTTP）') + '，均为生产真实入口。');
        lines.push('');
        lines.push('## 一、总量');
        lines.push('');
        lines.push(`- 语料 ${CORPUS.length} 条 / 子任务 ${totalSubtasks} 个`);
        lines.push(`- 路由无候选 ${noCandPreviews.length} 个 · 硬拒 ${rejectedPreviews.length} 个 · route 抛错 ${routeErrors.length} 个`);
        lines.push(`- 2.2 审阅：error ${errIssues.length} 条 / warn ${warnIssues.length} 条`);
        lines.push(`- 2.3 保真：${rows.reduce((n, r) => n + r.fidelityIssues.length, 0)} 条（shadow 下不派发，预期恒 0）`);
        lines.push('');
        lines.push('## 二、按 capability tag');
        lines.push('');
        lines.push('| type | 子任务数 | 无候选 | 期望档位 | 选中 adapter |');
        lines.push('|---|---|---|---|---|');
        for (const [type, v] of Object.entries(byType)) {
            lines.push(`| ${type} | ${v.count} | ${v.noCandidate} | ${Array.from(v.tiers).join('/')} | ${Array.from(v.chosen).join(', ') || '—'} |`);
        }
        lines.push('');
        lines.push('## 三、逐任务');
        lines.push('');
        lines.push('| 语料 | 输入 | 模板 | 子任务 | 无候选 | 告警 |');
        lines.push('|---|---|---|---|---|---|');
        for (const r of rows) {
            const nc = r.previews.filter((p) => p.noCandidate).length;
            const warns = r.semanticIssues.length + r.previews.flatMap((p) => p.issues).filter((i) => i.level === 'warn').length;
            const errs = r.previews.flatMap((p) => p.issues).filter((i) => i.level === 'error').length;
            lines.push(`| ${r.corpus.id} | ${r.corpus.input} | ${r.template} | ${r.subtaskCount} | ${nc} | ${errs ? `error×${errs} ` : ''}${warns ? `warn×${warns}` : ''}${!errs && !warns ? '—' : ''} |`);
        }
        lines.push('');
        lines.push('## 四、告警明细');
        lines.push('');
        if (!allIssues.length && !rows.some((r) => r.semanticIssues.length)) {
            lines.push('（无）');
        } else {
            for (const r of rows) {
                for (const i of r.semanticIssues) lines.push(`- \`[2.2 warn]\` ${r.corpus.id} — ${i.message}`);
                for (const p of r.previews) {
                    for (const i of p.issues) lines.push(`- \`[2.2 ${i.level}]\` ${r.corpus.id}/${p.id} — ${i.message}`);
                }
            }
        }
        lines.push('');
        lines.push('## 五、结论与下一步');
        lines.push('');
        if (dirtyTypes.length) {
            lines.push(`1. **存在无 owner 的 capability**：${uniq(dirtyTypes).join('、')}。这些子任务在 \`observe\` 下只是被记录，切 \`reject\` 会硬失败 → 切之前先补 registry 能力（与 \`plan\`/\`test\` 同一类补法：给现有 profile 加 tag，纯增量不夺现有路由）。`);
        } else {
            lines.push('1. 全部 capability 均有 adapter 承接，具备切 `reject` 的能力前提。');
        }
        lines.push('2. 补齐后可重跑本脚本确认告警清零，再按 runbook §三 Step 2 做单任务小流量真执行。');
        lines.push('3. 任意时刻回退成本为零：per-call `shadowMode:true` 或 `PROXY_ADAPTER_REAL=0`。');
        lines.push('');
        fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
        console.log(`\n报告已写入：${reportPath}`);
    }

    console.log('\n观察态真跑结束（shadow 恒开，未触任何下游 adapter）。');
})().catch((e) => {
    console.error('observe-shadow-run failed:', e && e.stack || e);
    process.exit(1);
});
