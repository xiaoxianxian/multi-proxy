'use strict';

// L1 chat 型 agent mock —— 模拟 codex-proxy / hermes-proxy 的最小 HTTP 后端。
// 对应真实下游：
//    - codex-proxy（Node/Express :18790）：GET /health + GET /v1/models + POST /v1/chat/completions
//    - hermes-proxy（Python/Flask :18793）：GET /health + GET /v1/models（**无 chat 端点**）
//
// 真实契约（据两代理源码核实，非臆测）：
//    - 共享：GET /health（返 {status, uptime, ...} / {status:'ok'}）+ GET /v1/models（OpenAI 形态 {data:[{id}]}）
//    - 鉴权：x-proxy-auth: <PROXY_AUTH_TOKEN>；token 未设 → 开放（无 token 也过，实测现状）
//    - codex 独有：POST /v1/chat/completions 同步返 { id, choices:[{message:{content}}] }
//    - hermes 无 chat 端点：/v1/chat/completions 返 404（adapter 退化为能力发现）
//
// 用途：验证 L1AgentAdapter 契约（P0 协议可行性，非侵入）。
// 零副作用：不写任何文件、不起真代理、不触上游。token 用固定 fake，adapter 注入，demo 绝不打印 token。

const http = require('http');

// fixture token（仅 mock 用，非真实凭证）
const FAKE_TOKEN = 'test-proxy-token';

// opts.model 可注入到 chat 响应；opts.noChat=true 模拟 hermes（chat 端点 404）
// opts.reasoningOnly=true → 模拟**推理型模型**（如本地 qwen3.8）：正文吐到 message.reasoning，
//   content 返空串（2026-10-01 Ollama 实测形态）——用于验证调用方的空 content 兜底。
// opts.content='' → 自定义空 content（不含 reasoning）。
// opts.noAuth=true → 不校验 x-proxy-auth，模拟**本地 Ollama :11434**（本机开放、无鉴权概念）。
module.exports = function startMockL1(port, opts = {}) {
    let chatCalls = 0;
    const chatModels = [];   // 每次 chat 请求携带的 model（用于断言档位选对模型）
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');

         // 鉴权：/v1/* 需 x-proxy-auth==FAKE_TOKEN（模拟两代理的 requireAuth）
        // opts.noAuth=true → 跳过校验（模拟本地 Ollama：无鉴权，任何请求都过）
        if (!opts.noAuth && (u.pathname.startsWith('/v1/') || u.pathname === '/health')) {
            const header = req.headers['x-proxy-auth'];
            if (header !== FAKE_TOKEN) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
             }
         }

        if (u.pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'healthy', uptime: 1, probe: 'mock-l1' }));
         }

        if (u.pathname === '/v1/models' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                object: 'list',
                data: [
                    { id: opts.model || 'deepseek-v4-pro', object: 'model', created: 1, owned_by: 'mock' },
                    { id: 'agnes-2.5-flash', object: 'model', created: 1, owned_by: 'mock' },
                ],
             }));
        }

        if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
            if (opts.noChat) {
                 // 模拟 hermes：无 chat 端点
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Not Found' }));
             }
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                chatCalls += 1;
                let parsedBody = {};
                try { parsedBody = JSON.parse(body || '{}'); } catch { parsedBody = {}; }
                if (parsedBody.model) chatModels.push(parsedBody.model);
                const message = { role: 'assistant' };
                if (opts.reasoningOnly) {
                    message.content = '';               // 推理型：正文在 reasoning，content 空
                    message.reasoning = opts.reasoning || '（mock 推理正文：先把问题拆开想一遍）';
                } else {
                    message.content = ('content' in opts) ? opts.content : 'mock-ok';
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    id: 'chatcmpl-mock-' + chatCalls,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: parsedBody.model || opts.model || 'deepseek-v4-pro',
                    choices: [{ index: 0, message, finish_reason: opts.reasoningOnly ? 'length' : 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
                }));
            });
            return;
         }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
     });

    server.listen(port, '127.0.0.1');
    return {
        server,
        token: FAKE_TOKEN,
        getPort: () => server.address().port,
        getChatCalls: () => chatCalls,
        getChatModels: () => chatModels.slice(),     // 每次 chat 请求携带的 model 列表
        getLastModel: () => chatModels.length ? chatModels[chatModels.length - 1] : null,
        close: () => new Promise((res) => server.close(res)),
     };
};
