'use strict';

// Claude 全家桶 adapter 端到端样例（v2-M5 R3-b）
// 对标 l1-agent-adapter.demo.js，验证 ClaudeAdapter 把 Anthropic Messages API 形式接入
// L2 契约（非侵入、0 联网用 mock、0 副作用）：
//    ① 能力声明 capabilitiesDeclaration()（protocol=anthropic / 能力 ['code','writing'] / 端点 /v1/messages）
//    ② 健康检查 health()（GET /health，200 即活，无需 key）
//    ③ 模型发现 listModels()（GET /v1/models，OpenAI 兼容形态 {data:[{id}]}；404 容错返 []）
//    ④ 任务接收/结果回传 invoke()：
//       - 有 /v1/messages 端点 → 同步解析 content[].text（真形态，非 choices）+ 注入 x-api-key+anthropic-version
//       - 流式 → 解析 Anthropic SSE（content_block_delta.delta.text 累积 + stop_reason）
//    ⑤ 无 chat 端点（claude-code 无 HTTP shim / claude-desktop）→ 退化为能力发现
//    ⑥ 鉴权：x-api-key 错 → 401
//    ⑦ 接入 Agent Registry：能力标签 + byCapability 路由；门控关（dormant，不触热路径）
// 下游用本文件内联 mock（anthropic 形态），零副作用：不联网、不扣费、密钥用固定 fake 且不打印。

const assert = require('assert');
const http = require('http');
const { ClaudeAdapter, extractText } = require('./claude-adapter.js');
const { AgentRegistry } = require('../agent-registry.js');

let n = 0;
const ok = (msg, a) => { assert(a, msg); n += 1; console.log(`PASS  ${msg}`); };

// ---- mock 下游：Anthropic Messages API 形态 ----
// fake key 仅 mock 用（非真实凭证）；/v1/messages 需 header 'x-api-key' == FAKE_KEY，否则 401
const FAKE_KEY = 'sk-ant-test-fake-key';

function startMockAnthropic(port, opts = {}) {
    let msgCalls = 0;
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');

        if (u.pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok' }));
          }

        if (u.pathname === '/v1/models' && req.method === 'GET') {
            if (opts.noModels) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Not Found' })); // 模拟 claude-code/desktop 无 /v1/models
              }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                object: 'list',
                data: [
                    { id: 'claude-3-5-sonnet-latest', object: 'model', created: 1, owned_by: 'anthropic' },
                    { id: 'claude-opus-4-20250514', object: 'model', created: 1, owned_by: 'anthropic' },
                 ],
              }));
          }

        if (u.pathname === '/v1/messages' && req.method === 'POST') {
            // 鉴权：x-api-key 必须匹配（Anthropic 原生，非 Bearer/非 x-proxy-auth）
            if (req.headers['x-api-key'] !== FAKE_KEY) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
              }
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let reqBody = {};
                try { reqBody = JSON.parse(body || '{}'); } catch {}
                const model = reqBody.model || 'claude-3-5-sonnet-latest';
                msgCalls += 1;
                if (reqBody.stream) {
                     // Anthropic SSE 事件流
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'anthropic-version': '2023-06-01',
                    });
                    const evt = (type, payload) =>
                        `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
                    res.write(evt('message_start', { type: 'message_start', message: { id: 'msg_' + msgCalls, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } }));
                    res.write(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
                    res.write(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } }));
                    res.write(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from claude' } }));
                    res.write(evt('content_block_stop', { type: 'content_block_stop', index: 0 }));
                    res.write(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
                    res.write(evt('message_stop', { type: 'message_stop' }));
                    return res.end();
                  }
                 // 非流式：Anthropic message 形态
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    id: 'msg_' + msgCalls,
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [
                        { type: 'text', text: 'mock-claude-ok' },
                        { type: 'thinking', thinking: 'reasoning here' },
                        { type: 'text', text: ' second block' },
                    ],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
                 }));
             });
            return;
         }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
      });

    server.listen(port, '127.0.0.1');
    return {
        server,
        key: FAKE_KEY,
        getPort: () => server.address().port,
        getMsgCalls: () => msgCalls,
        close: () => new Promise((res) => server.close(res)),
      };
}

(async () => {
    console.log('--- ClaudeAdapter demo (v2-M5 R3-b: Anthropic Messages API 真形态 + 0 联网 mock) ---\n');

     // ① 能力声明
    const adapter = new ClaudeAdapter({ id: 'claude', name: 'Claude', portCandidates: [], port: 0 });
    const decl = adapter.capabilitiesDeclaration();
    ok('caps protocol=anthropic', decl.protocol === 'anthropic');
    ok('caps authScheme=x-api-key', decl.authScheme === 'x-api-key');
    ok('caps has code+writing', ['code', 'writing'].every((c) => decl.capabilities.includes(c)));
    ok('caps supportsChat=true (has /v1/messages)', decl.supportsChat === true);
    ok('caps supportsTaskQueue=false (chat 型同步)', decl.supportsTaskQueue === false);
    ok('caps healthEndpoint=/health', decl.healthEndpoint === '/health');

    // ② health 不需 key（GET /health 200 即活）
    const mock = startMockAnthropic(0, {});
    await new Promise((r) => setTimeout(r, 30));
    const port = mock.getPort();
    const live = new ClaudeAdapter({ id: 'claude', name: 'Claude', port: port, portCandidates: [], apiKey: mock.key });
    const h = await live.health();
    ok('health ok=true status=ok', h.ok === true && h.status === 'ok');
    ok('health raw=200', h.raw === 200);
    ok('health 锁定注入端口', h.port === port);

    // ③ 模型发现：真 /v1/models 形态（OpenAI 兼容 data[]）
    const models = await live.listModels();
    ok('listModels 返 2 个模型', Array.isArray(models) && models.length === 2);
    ok('listModels 含 claude-3-5-sonnet-latest', models.some((m) => m.id === 'claude-3-5-sonnet-latest'));

    // ④ invoke 非流式：真解析 content[].text（两个 text 块拼接 + 跳过 thinking 块）
    const syncTask = await live.invoke({ model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, system: 'be terse' });
    ok('sync invoke state=done', syncTask.state === 'done');
    ok('sync invoke type=chat', syncTask.type === 'chat');
    ok('sync invoke 解析 content[].text 拼接', syncTask.result.content === 'mock-claude-ok second block');
    ok('sync invoke 跳过 thinking 块', !/reasoning/.test(syncTask.result.content));
    ok('sync invoke 带 stop_reason=end_turn', syncTask.result.stop_reason === 'end_turn');
    ok('sync invoke 带 usage 透传', syncTask.result.usage && syncTask.result.usage.total_tokens === 22);
    ok('sync invoke 模型回显', syncTask.result.model === 'claude-3-5-sonnet-latest');
    ok('sync invoke task_id 前缀 claude_', typeof syncTask.task_id === 'string' && syncTask.task_id.startsWith('claude_'));

    // ⑤ invoke 流式：真解析 Anthropic SSE（content_block_delta 累积 + stop_reason）
    const streamTask = await live.invoke({ model: 'claude-3-5-sonnet-latest', messages: [{ role: 'user', content: 'hi' }], stream: true });
    ok('stream invoke 累积 text=hello from claude', streamTask.result.content === 'hello from claude');
    ok('stream invoke 标记 stream=true', streamTask.stream === true);
    ok('stream invoke stop_reason=end_turn', streamTask.result.stop_reason === 'end_turn');
    ok('stream invoke 见过 7 个 SSE 事件', streamTask.result.events_seen === 7);

    // ⑥ 注入 x-api-key + 固定 anthropic-version（mock 校验 key 匹配才 200）
    ok('x-api-key 正确 mock 才 200（mock 已发 2 次 /v1/messages）', mock.getMsgCalls() === 2);

    // ⑦ 鉴权失败：x-api-key 错 → 401
    const bad = new ClaudeAdapter({ id: 'claude', port: port, portCandidates: [], apiKey: 'WRONG-KEY' });
    let authThrew = false;
    try { await bad.invoke({ model: 'x', messages: [] }); } catch (e) { authThrew = /401/.test(e.message); }
    ok('wrong x-api-key → 401', authThrew);

    // ⑧ 无 chat 端点 → 退化为能力发现（claude-code 无 HTTP shim / claude-desktop 场景）
    //    chatPath: null 绕过构造器默认 '/v1/messages'，模拟「无 chat 端点」
    const discovery = new ClaudeAdapter({ id: 'claude-desktop', port: port, portCandidates: [], apiKey: mock.key, chatPath: null });
    const discTask = await discovery.invoke({ model: 'x', messages: [] });
    ok('无 chat 端点 → type=discovery', discTask.type === 'discovery');
    ok('discovery note 说明退化', /能力发现/.test(discTask.note));
    ok('discovery 返 available_models', Array.isArray(discTask.result.available_models) && discTask.result.available_models.length === 2);

    // ⑨ /v1/models 404 容错（claude-code/desktop 无 models 端点 → 空发现，不抛）
    const mockNoModels = startMockAnthropic(0, { noModels: true });
    await new Promise((r) => setTimeout(r, 30));
    const noModelsAdapter = new ClaudeAdapter({ id: 'claude-code', port: mockNoModels.getPort(), portCandidates: [], apiKey: mockNoModels.key, chatPath: '/v1/messages' });
    const nm = await noModelsAdapter.listModels();
    ok('listModels 404 → 空数组（容错）', Array.isArray(nm) && nm.length === 0);
    await mockNoModels.close();

    // ⑩ 接入 Agent Registry：能力 + byCapability 路由
      //    type 用 'custom'（AGENT_TYPES 封闭白名单 = codex/hermes/cursor/custom，含 claude 需改 core，
      //    违反 0 副作用）；语义区分靠 id/adapterId='claude'，与 h3web/aigc/三档 tier 同款惯例。
    const reg = new AgentRegistry();
    reg.create({ id: 'codex', name: 'Codex', type: 'codex', capabilityTags: ['code', 'review'], version: '1.0.0' });
    reg.create({ id: 'claude', name: 'Claude', type: 'custom', adapterId: 'claude', capabilityTags: ['code', 'writing'], version: '1.0.0' });
    ok('Registry byCapability("writing")==1（仅 claude）', reg.byCapability('writing').length === 1);
    ok('Registry byCapability("code")==2（codex+claude）', reg.byCapability('code').length === 2);

    // ⑫ extractText 独立校验（非数组/非对象容错）
    ok('extractText(array) 拼接 text 块', extractText([{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'b' }]) === 'ab');
    ok('extractText(string) 原样', extractText('plain') === 'plain');
    ok('extractText(null) 空串', extractText(null) === '');

    // ⑬ 门控关：adapter 默认不持 open handle（_resolvedPort 惰性到首次调用），0 副作用
    const dormant = new ClaudeAdapter({ id: 'claude', port: 0 });
    ok('门控关：新构造 adapter 未 resolve 端口（惰性，不触网）', dormant._resolvedPort === null);

    // 收尾
    await mock.close();
    console.log(`\n${n === 35 ? 'ALL PASS' : 'FAIL'}: ${n} checks — Claude 全家桶 adapter(Anthropic Messages API 真形态 + 流式 SSE + 401 + 发现退化 + 注册 + 门控关 dormant)`);
    process.exit(n === 35 ? 0 : 1);
})().catch((e) => {
    console.error('FAIL:', e.message);
    console.error(e.stack);
    process.exit(1);
});
