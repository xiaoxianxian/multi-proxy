// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// R1 live E2E（v2-M5 · 三 agent 真连 + gate/executor 机制）—— 对标 mcp-orchestrate-real.demo.js。
//
// 「三 agent 真连」= 三个 agent 各经自己的**真实 HTTP round-trip** 完成原生 op（非 3 个子任务塞给一个 agent）：
//    ① Codex  (L1AgentAdapter → mock-l1 有 chat 端点) : invoke chat → content 'mock-ok'          (HTTP 200)
//    ② Hermes (L1AgentAdapter → mock-l1 noChat)        : invoke 无 chat 端点 → 退化为 discovery   (HTTP 200, available_models)
//    ③ Claude (ClaudeAdapter → mock Anthropic Messages): invoke /v1/messages → content[].text     (HTTP 200)
// 再加 gate/executor 机制（真 McpServer + 真 RouteEngine + seedDefaultProfiles）：
//    - PROXY_ADAPTER_REAL 关（默认）→ orchestrate 恒 shadow，注入 executor **0 调用**（非侵入、零副作用）
//    - 开 + 注入 executor → orchestrate shadow=false，executor **真被调用**、经 routeEngine.route 路由到真实 adapterId、
//      真值回传（代理→网关→中台→执行→回结果 的端到端 wiring）
//
// 纪律（adapter-protocol.md §五 + 续跑手册 §七，全程遵守）：
//    ① 0 联网用 mock：下游 codex/hermes/claude 全是内联/mock-l1 替身，不触真实上游、不扣费。
//    ② 0 副作用：不写任何 agent 文件、不写盘。
//    ③ 密钥 fake 且不打印。
//    ④ 门控默认关：gate 关态是默认路径，证明「不改现有路由行为」。
//
// 真实「起 codex/hermes/cursor 真上游 + 扣费 + 打真 API」是维护者单独授权的扩展（PART-D），
// 本 demo 默认**不自动跑**——它是 R1 的安全切片（隔离 mock 下游，零扣费），真上游是授权后的 opt-in。

const assert = require('assert');
const http = require('http');
const { L1AgentAdapter } = require('./l1-agent-adapter.js');
const { ClaudeAdapter } = require('./claude-adapter.js');
const startMockL1 = require('../mock-l1.js');
const { AgentRegistry } = require('../agent-registry.js');
const { McpServer } = require('../mcp-server.js');
const { seedDefaultProfiles } = require('../mcp-default-seed.js');

let n = 0;
const ok = (msg, a) => { assert(a, msg); n += 1; console.log(`PASS   ${msg}`); };

// ---- mock 下游：Anthropic Messages API 形态（claude 专用；codex/hermes 用共享 mock-l1）----
// fake key 仅 mock 用（非真实凭证，且不含 sk- 形态避免被密钥检测误判）；/v1/messages 需 header 'x-api-key' 匹配，否则 401
const FAKE_KEY = 'fixture-xapikey-r1-0001';
function startMockAnthropic(port) {
    let msgCalls = 0;
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');
        if (u.pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok' }));
           }
        if (u.pathname === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ object: 'list', data: [
                { id: 'claude-3-5-sonnet-latest', object: 'model', owned_by: 'anthropic' },
               ] }));
           }
        if (u.pathname === '/v1/messages' && req.method === 'POST') {
            if (req.headers['x-api-key'] !== FAKE_KEY) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
              }
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                msgCalls += 1;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    id: 'msg_' + msgCalls, type: 'message', role: 'assistant',
                    content: [{ type: 'text', text: 'mock-claude-ok' }],
                    stop_reason: 'end_turn',
                   }));
              });
            return;
          }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    server.listen(port, '127.0.0.1');
    return { getPort: () => server.address().port, getMsgCalls: () => msgCalls,
             close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    console.log('--- R1 live E2E demo (v2-M5: 三 agent 真连 + gate/executor · 隔离 mock 下游 · 0 扣费 0 副作用) ---\n');

    // ===== 第一部分：三 agent 各经自己的真实 HTTP round-trip 完成原生 op =====
    // ① Codex：L1AgentAdapter → mock-l1（有 /v1/chat/completions）→ 真 chat
    const mockCodex = startMockL1(0, { noChat: false, model: 'deepseek-v4-pro' });
    await new Promise((r) => setTimeout(r, 30));
    const codex = new L1AgentAdapter({
        id: 'codex', name: 'codex-proxy', portCandidates: [], port: mockCodex.getPort(),
        token: mockCodex.token, capabilities: ['code', 'writing'], chatPath: '/v1/chat/completions',
      });
    const cxHealth = await codex.health();
    ok('① Codex health=200(真 HTTP round-trip)', cxHealth.ok === true && cxHealth.raw === 200);
    const cxTask = await codex.invoke({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'ping' }] });
    ok('① Codex invoke→chat content=mock-ok', cxTask.state === 'done' && cxTask.type === 'chat' && cxTask.result.content === 'mock-ok');

    // ② Hermes：L1AgentAdapter → mock-l1（无 chat 端点，noChat=true）→ 退化为能力发现
    const mockHermes = startMockL1(0, { noChat: true, model: 'qwen3.8:27b-mlx' });
    await new Promise((r) => setTimeout(r, 30));
    const hermes = new L1AgentAdapter({
        id: 'hermes', name: 'hermes-proxy', portCandidates: [], port: mockHermes.getPort(),
        token: mockHermes.token, capabilities: ['writing'],
      });
    const hmTask = await hermes.invoke({ model: 'qwen3.8:27b-mlx', messages: [] });
    ok('② Hermes 无 chat 端点→退化 discovery', hmTask.type === 'discovery' && Array.isArray(hmTask.result.available_models));
    ok('② Hermes discovery 拿到 available_models(真 HTTP 200 /v1/models)', hmTask.result.available_models.length >= 1);

    // ③ Claude：ClaudeAdapter → mock Anthropic /v1/messages → content[].text
    const mockClaude = startMockAnthropic(0);
    await new Promise((r) => setTimeout(r, 30));
    const claude = new ClaudeAdapter({ id: 'claude', portCandidates: [], port: mockClaude.getPort(), apiKey: FAKE_KEY });
    const clTask = await claude.invoke({ model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'ping' }] });
    ok('③ Claude invoke→/v1/messages content 含 mock-claude-ok', typeof (clTask.result && clTask.result.content) === 'string' && clTask.result.content.includes('mock-claude-ok'));
    ok('③ Claude mock 真收到 1 次 /v1/messages(真 HTTP 往返)', mockClaude.getMsgCalls() === 1);

    // 三个 agent 同时真连 → 三套独立 HTTP 服务都真在 LISTEN 且都回了 200
    ok('三 agent 三套独立 HTTP round-trip 同时成立',
       [cxHealth.raw, hmTask.type === 'discovery', clTask.result && clTask.result.content].every(Boolean));

    // ===== 第二部分：gate/executor 机制（真 McpServer + 真 RouteEngine + seedDefaultProfiles）=====
    // 注册真 agent profile：seed 已带 codex/claude，补 hermes（三 agent 入注册表）
    const reg = new AgentRegistry();
    seedDefaultProfiles(reg);
    reg.create({ id: 'hermes', name: 'hermes-proxy', type: 'hermes', capabilityTags: ['writing'] });
    ok('注册表含三 agent(codex+hermes+claude)',
       ['codex', 'hermes', 'claude'].every((id) => reg.list().some((p) => p.id === id)));

    // 用一个 DAG：code→codex，video→h3web（两者唯一 owner，路由确定性，避免 3 个 writing 都 tie 给 claude 的假象）
    const dag = {
        template: 'three-agent-live-e2e',
        input: 'R1 live E2E: code 交 codex, video 交 h3web',
        subtasks: [
            { id: 'code-node', type: 'code', complexity: 'low', prompt: 'x', deps: [] },
            { id: 'video-node', type: 'video', complexity: 'low', prompt: 'x', deps: ['code-node'] },
        ],
        edges: [['code-node', 'video-node']],
    };

    // UC-A：gate 关（默认）→ 恒 shadow，注入 executor 0 调用（非侵入、零副作用、不改现有路由行为）
    {
    let calls = 0;
    const executor = async (a, s) => { calls++; return `v-${s.id}`; };
    const server = new McpServer({ gate: '1', registry: reg, realGate: '0', executor });
    const res = await server.handleMessageAsync({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'orchestrate', arguments: { dag, shadowMode: false } },
      });
    const p = JSON.parse(res.result.content[0].text);
    ok('gate 关 → 恒 shadow(per-call shadowMode:false 不可绕过门控)', p.shadow === true);
    ok('gate 关 → 注入 executor 0 调用(零副作用)', calls === 0);
    ok('gate 关 → 子任务仍 done(仅路由/记录, 不真执行)', p.subtasks.every((s) => s.status === 'done'));
   }

    // UC-B：gate 开 + 注入 executor → 真执行(shadow=false)，executor 真被调、经 routeEngine 路由到真实 adapterId、真值回传
    {
    let calls = 0;
    const seen = {};
    const executor = async (adapterId, st) => {
        calls++;
        seen[st.id] = adapterId;
        return { marker: 'real-exec', adapterId, subtaskId: st.id };
      };
    const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
    const res = await server.handleMessageAsync({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'orchestrate', arguments: { dag } },
      });
    const p = JSON.parse(res.result.content[0].text);
    ok('gate 开+executor → shadow=false(真执行)', p.shadow === false);
    ok('gate 开+executor → 子任务经 _realExecutor 真执行(status executed 含 routedAdapterId)',
       p.report && p.report.subtasks.every((s) => s.status === 'done' && s.value && s.value.status === 'executed' && s.value.routedAdapterId));
    ok('gate 开+executor → executor 真被调用 2 次(DAG 2 子任务)', calls === 2);
    ok('gate 开+executor → code 子任务路由到 codex(真实 adapterId 回传)', seen['code-node'] === 'codex');
    ok('gate 开+executor → video 子任务路由到 h3web(唯一 owner)', seen['video-node'] === 'h3web');
    ok('代理→网关→中台→执行→回结果：真值经 report 回传', p.report.subtasks.some((s) => s.value && s.value.value && s.value.value.marker === 'real-exec'));
   }

    // ===== 收尾 =====
    await mockCodex.close();
    await mockHermes.close();
    await mockClaude.close();
    console.log(`\n${n === 17 ? 'ALL PASS' : 'FAIL'}: ${n} checks — R1 三 agent 真连(codex chat / hermes discovery / claude chat)+gate/executor 机制(隔离 mock 下游·0 扣费 0 副作用)`);
    process.exit(n === 17 ? 0 : 1);
})().catch((e) => {
    console.error('FAIL:', e && e.stack || e);
    process.exit(1);
});
