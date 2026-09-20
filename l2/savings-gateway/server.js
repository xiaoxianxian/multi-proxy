'use strict';

// 省钱网关 thin HTTP server（task1 一期 · 决策②端口 18795）
// OpenAI 兼容：POST /v1/chat/completions（Bearer dummy key）→ 难度路由 + 模拟 delta 记账。
// 只读看板：GET /savings/report / GET /savings/signal（喂 alert.js cost 规则）。
//
// 非侵入（与 manager routes 的 alert/orchestration 接线纪律一致）：
//   - 门控 PROXY_SAVINGS_GATEWAY 默认关 → /v1/* 全 403 gate-closed（/health 与只读看板放行）；
//     开 = 服务（一期 shadow 模拟，不落盘、不触真实上游）
//   - shadow 默认开（PROXY_SAVINGS_SHADOW=0/… 才关；关 = 二期真执行缝，需注入 executor）
//   - 零依赖：node 内置 http；不碰 forward.js / codex-proxy/proxy.js 热路径
//   - 绑定 127.0.0.1（沿用 manager server.js BIND_HOST 惯例；跨机/Docker 设 SAVE_GATEWAY_BIND_HOST）

const http = require('http');
const { createSavingsGateway, gateOpen, GATE_ENV, SHADOW_ENV } = require('./gateway.js');

const DEFAULT_PORT = 18795;

function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let data = '';
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
            data += c;
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

// OpenAI 风格错误（agent 客户端可识别）
function openaiError(res, status, message, type) {
    json(res, status, { error: { message, type: type || 'invalid_request_error', code: null } });
}

function createServer(opts = {}) {
    const gateway = opts.gateway || createSavingsGateway();
    return http.createServer(async (req, res) => {
        const url = req.url || '/';
        const pathname = url.split('?')[0];

        if (req.method === 'GET' && pathname === '/health') {
            return json(res, 200, { ok: true, module: 'savings-gateway', gateOpen: gateOpen(), shadow: gateway.isShadow() });
        }

        if (req.method === 'GET' && pathname === '/savings/report') {
            const q = new URL(url, 'http://x').searchParams;
            const windowMs = q.has('windowMs') ? parseInt(q.get('windowMs'), 10) : undefined;
            return json(res, 200, { ...gateway.savingsReport(windowMs), gate: gateOpen() ? 'open' : 'closed(observe)' });
        }

        // 喂 alert.js 的 cost 信号（契约：{ source:'cost', providerId, cost, budget? }）
        if (req.method === 'GET' && pathname === '/savings/signal') {
            const q = new URL(url, 'http://x').searchParams;
            const budget = q.has('budget') ? parseFloat(q.get('budget')) : undefined;
            return json(res, 200, { ...gateway.produceCostSignal({ budget }), gate: gateOpen() ? 'open' : 'closed(observe)' });
        }

        if (req.method === 'POST' && pathname === '/v1/chat/completions') {
            if (!gateOpen()) {
                return json(res, 403, { error: { message: 'savings-gateway gate closed', type: 'gate_closed', code: GATE_ENV } });
            }
            let raw;
            try { raw = await readBody(req); } catch (e) { return openaiError(res, 413, e.message, 'payload_too_large'); }
            let body;
            try { body = raw ? JSON.parse(raw) : {}; } catch { return openaiError(res, 400, 'invalid JSON body'); }
            if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
                return openaiError(res, 400, "missing required parameter: 'messages'");
            }
            const auth = req.headers['authorization'] || '';
            const key = auth.startsWith('Bearer ') ? auth.slice(7) : null;
            try {
                const out = gateway.handleChatCompletions(body, { key });
                return json(res, 200, out);
            } catch (e) {
                const status = e.httpStatus === 401 ? 401 : 400;
                return openaiError(res, status, e.message, e.message === 'invalid_api_key' || e.message === 'unknown_api_key' ? 'invalid_api_key' : 'invalid_request_error');
            }
        }

        openaiError(res, 404, `unknown route: ${req.method} ${pathname}`);
    });
}

// 直接 node 运行 = 起服务；被 require = 只导出工厂（测试不监听）
function start(port, bindHost) {
    const server = createServer();
    const p = Number.isFinite(port) ? port : (parseInt(process.env.SAVE_GATEWAY_PORT, 10) || DEFAULT_PORT);
    const host = bindHost || process.env.SAVE_GATEWAY_BIND_HOST || '127.0.0.1';
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => {
            server.off('error', reject);
            const addr = server.address();
            console.log(`[savings-gateway] listening on ${host}:${addr.port} gate=${gateOpen() ? 'open' : 'closed(observe)'} shadow=${SHADOW_ENV === '0' ? 'off' : 'on'}`);
            resolve(server);
        });
    });
}

module.exports = { createServer, start, DEFAULT_PORT };

if (require.main === module) {
    start().catch((e) => { console.error('[savings-gateway] start failed:', e.message); process.exit(1); });
}
