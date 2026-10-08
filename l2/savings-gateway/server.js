// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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
const { createCostWatchdog } = require('./cost-watchdog.js');

const DEFAULT_PORT = 18795;

// P1-b 增强（2026-10-08）：per-provider 熔断门控，默认关（零行为变更）。
// 设 PROXY_SAVINGS_CIRCUIT_BREAKER=1/true/recommended 才向网关注入 cc-switch 派生推荐熔断器；
// 关 = 不注入 breaker（circuitOpen 恒为 undefined，老行为不变）。
// 注入后动作由 PROXY_SAVINGS_CIRCUIT_MODE 控制：observe(默认·只记账) / failover(改路由到健康候选) / block(OPEN 即拒 503)。
function resolveCircuitBreakerOpt() {
  const v = process.env.PROXY_SAVINGS_CIRCUIT_BREAKER;
  if (v === '1' || v === 'true' || v === 'recommended') return 'recommended';
  return undefined; // → gateway 内 circuitBreaker=null（默认关）
}

// 熔断动作模式（2026-10-08 二期缝）。仅当上面的 breaker 已注入才有意义；默认 observe（零行为变更）。
function resolveCircuitModeOpt() {
  const m = (process.env.PROXY_SAVINGS_CIRCUIT_MODE || 'observe').toLowerCase();
  return ['observe', 'failover', 'block'].includes(m) ? m : 'observe';
}

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
    const gateway = opts.gateway || createSavingsGateway({
        circuitBreaker: opts.circuitBreaker || resolveCircuitBreakerOpt(),
        circuitMode: opts.circuitMode !== undefined ? opts.circuitMode : resolveCircuitModeOpt(),
    });
    const watchdog = opts.watchdog || createCostWatchdog();   // G1：硬上限看门狗（默认 hardCap=0 不拦）
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
            // G1：硬上限到限暂停——累计成本越过 hardCap 直接在真实执行/模拟前拒绝
            if (watchdog.state().block) {
                return openaiError(res, 429, 'budget hard cap reached; requests paused until cap is raised', 'budget_exceeded');
            }
            try {
                const out = gateway.handleChatCompletions(body, { key });
                // 喂 watchdog 累计成本（G1：到限即拒；default hardCap=0 不影响旧行为）
                const entries = gateway.getSavingsLog();
                const lastEntry = entries[entries.length - 1];
                if (lastEntry) watchdog.record(lastEntry);
                return json(res, 200, out);
            } catch (e) {
                const status = e.httpStatus === 401 ? 401 : (e.httpStatus === 503 ? 503 : 400);
                const type = e.httpStatus === 503 ? 'circuit_breaker_open'
                    : (e.message === 'invalid_api_key' || e.message === 'unknown_api_key' ? 'invalid_api_key' : 'invalid_request_error');
                return openaiError(res, status, e.message, type);
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
