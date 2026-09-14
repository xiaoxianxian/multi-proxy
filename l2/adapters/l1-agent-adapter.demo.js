'use strict';

// L1 chat 型 agent adapter 端到端样例（P0 收口 · Codex + Hermes 两个样例）
//
// 验证 L1AgentAdapter 把 OpenAI 兼容 chat 代理接入 Agent Registry 的契约（非侵入）：
//   - Codex（有 /v1/chat/completions）: chat 型，supportsChat=true，invoke 走同步 chat
//   - Hermes（无 chat 端点）           : 退化为能力发现，supportsChat=false，invoke 返 discovery
//   - 鉴权：x-proxy-auth 错误 → 401
//   - 接入 Agent Registry：能力标签 + byCapability 路由
// 下游用 mock-l1.js（codex 真 chat / hermes noChat 404），零副作用。

const assert = require('assert');
const { L1AgentAdapter, probePort } = require('./l1-agent-adapter.js');
const { AgentRegistry } = require('../agent-registry.js');
const startMockL1 = require('../mock-l1.js');

let n = 0;
const ok = (msg, a) => { assert(a, msg); n += 1; console.log(`PASS  ${msg}`); };

(async () => {
    console.log('--- L1AgentAdapter demo (P0 收口: Codex + Hermes 两个样例) ---\n');

    // ① Codex: 有 chat 端点 → 真 chat
    const mockCodex = startMockL1(0, { noChat: false, model: 'deepseek-v4-pro' });
    await new Promise((r) => setTimeout(r, 30));
    const codexPort = mockCodex.getPort();
    const codex = new L1AgentAdapter({
        id: 'codex', name: 'codex-proxy',
        portCandidates: [], port: codexPort, token: mockCodex.token,
        capabilities: ['code', 'writing'],
        chatPath: '/v1/chat/completions',
     });
    const chDecl = codex.capabilitiesDeclaration();
    ok('Codex caps supportsTaskQueue=false', chDecl.supportsTaskQueue === false);
    ok('Codex caps isChatAgent=true', chDecl.isChatAgent === true);
    ok('Codex caps supportsChat=true', chDecl.supportsChat === true);
    ok('Codex caps has capabilities code/writing', ['code', 'writing'].every((c) => chDecl.capabilities.includes(c)));

     // 健康检查：codex /health 返 healthy
    const cxH = await codex.health();
    ok('Codex health ok=true status=healthy', cxH.ok === true && cxH.status === 'healthy');
    ok('Codex health raw=200', cxH.raw === 200);
    ok('Codex health port matches mock', cxH.port === codexPort);

     // /v1/models 发现：OpenAI 形态 {data:[{id}]}
    const cxModels = await codex.listModels();
    ok('Codex listModels returns 2 models', Array.isArray(cxModels) && cxModels.length === 2);
    ok('Codex models contains deepseek-v4-pro', cxModels.some((m) => m.id === 'deepseek-v4-pro'));

     // 任务接收/结果回传：chat 同步 invoke
    const cxTask = await codex.invoke({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] });
    ok('Codex invoke state=done', cxTask.state === 'done');
    ok('Codex invoke type=chat', cxTask.type === 'chat');
    ok('Codex invoke returns content mock-ok', cxTask.result && cxTask.result.content === 'mock-ok');
    ok('Codex invoke has task_id', typeof cxTask.task_id === 'string' && cxTask.task_id.startsWith('l1_'));
     // run 是 invoke 的别名（无轮询）
    const cxRun = await codex.run({ model: 'deepseek-v4-pro', messages: [] });
    ok('Codex run===invoke alias content=mock-ok', cxRun.result && cxRun.result.content === 'mock-ok');

    // ② Hermes: 无 chat 端点 → 退化为能力发现
    const mockHermes = startMockL1(0, { noChat: true, model: 'qwen3.8:27b-mlx' });
    await new Promise((r) => setTimeout(r, 30));
    const hermesPort = mockHermes.getPort();
    const hermes = new L1AgentAdapter({
        id: 'hermes', name: 'hermes-proxy',
        portCandidates: [], port: hermesPort, token: mockHermes.token,
        capabilities: ['writing'],
      });
    const hmDecl = hermes.capabilitiesDeclaration();
    ok('Hermes caps isChatAgent=true but supportsChat=false', hmDecl.isChatAgent === true && hmDecl.supportsChat === false);
    const hmH = await hermes.health();
    ok('Hermes health ok=true', hmH.ok === true);
    const hmModels = await hermes.listModels();
    ok('Hermes listModels returns 2 models (qwen3.8 in there)', Array.isArray(hmModels) && hmModels.length === 2);
       // invoke 无 chat → 退化为 discovery，如实返回 available_models
    const hmTask = await hermes.invoke({ model: 'qwen3.8:27b-mlx', messages: [] });
    ok('Hermes invoke type=discovery (no chat endpoint)', hmTask.type === 'discovery');
    ok('Hermes discovery note explains no chat', typeof hmTask.note === 'string' && hmTask.note.includes('无 chat'));
    ok('Hermes discovery returns available_models', Array.isArray(hmTask.result && hmTask.result.available_models));

    // ③ 接入 Agent Registry：能力注册 + byCapability 路由
    const reg = new AgentRegistry();
    reg.create({ id: 'codex', name: 'codex-proxy', type: 'codex', capabilityTags: ['code', 'writing'], version: '1.0.0' });
    reg.create({ id: 'hermes', name: 'hermes-proxy', type: 'hermes', capabilityTags: ['writing'], version: '1.0.0' });
    ok('Registry byCapability("code")==1 (only codex)', reg.byCapability('code').length === 1);
    ok('Registry byCapability("writing")==2 (codex+hermes)', reg.byCapability('writing').length === 2);
    ok('Registry count==2', reg.count() === 2);
    const coder = reg.byCapability('code')[0];
    ok('code route resolves to codex', coder && coder.id === 'codex');

    // ④ 鉴权：x-proxy-auth 错误 → 401（自包含 mock，不依赖上面 mockCodex 的生命周期）
    const http = require('http');
    const authMock = http.createServer((req, res) => {
       if (req.url.startsWith('/v1/')) { // 鉴权中间件：x-proxy-auth 错 → 401
           res.writeHead(401, { 'Content-Type': 'application/json' });
           return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        }
       res.writeHead(404); res.end('nf');
     });
    await new Promise((r) => authMock.listen(0, '127.0.0.1', r));
    const authPort = authMock.address().port;
    const bad = new L1AgentAdapter({
       id: 'codex-bad', portCandidates: [], port: authPort,
       token: 'WRONG-TOKEN', chatPath: '/v1/chat/completions',
    });
    let authThrew = false;
    try { await bad.invoke({ model: 'x', messages: [] }); } catch (e) { authThrew = /401/.test(e.message); }
    ok('wrong x-proxy-auth → 401 (chat)', authThrew);

    // 收尾
    await mockCodex.close();
    await mockHermes.close();
    await new Promise((r) => authMock.close(r));
    console.log(`\n${n === 25 ? 'ALL PASS' : 'FAIL'}: ${n} checks — L1 chat 型 adapter(Codex 真 chat + Hermes discovery 退化)+接入 Registry`);
    process.exit(n === 25 ? 0 : 1);
})().catch((e) => {
    console.error('FAIL:', e.message);
    console.error(e.stack);
    process.exit(1);
});
