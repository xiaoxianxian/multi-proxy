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

// 真实执行器（2026-10-08 二期缝使能件）：默认不启用（零行为变更）。
// 设 PROXY_SAVINGS_EXECUTOR=forward 才构建透传执行器，把请求打到上游（默认 18790 = codex-proxy）；
// 启用时强制 shadow=off（否则内核不会真调上游）。上游 URL 经 PROXY_SAVINGS_UPSTREAM 注入。
function resolveExecutorOpt() {
  if ((process.env.PROXY_SAVINGS_EXECUTOR || '').toLowerCase() !== 'forward') return undefined;
  const { createForwardExecutor } = require('./gateway.js');
  const upstream = process.env.PROXY_SAVINGS_UPSTREAM || 'http://127.0.0.1:18790';
  return createForwardExecutor(upstream);
}

// 收费确认闸门（MPT 契约 2026-10-12）：默认关 = 不注入 = 网关零行为变更。
// 设 PROXY_SAVINGS_CHARGE_CONFIRM=1/true/on 才构造闸门并注入 gateway；付费路由（真执行）
// 需客户端显式带 X-Charge-Confirm 头（1/true/on）才放行，否则内核抛 402。
// 付费名单可经 PROXY_SAVINGS_PAID_ADAPTERS（逗号分隔）覆盖默认 [deepseek,qwen]。
function resolveChargeConfirmOpt() {
  const v = String(process.env.PROXY_SAVINGS_CHARGE_CONFIRM ?? '').trim().toLowerCase();
  if (!(v === '1' || v === 'true' || v === 'on')) return undefined; // 默认关 → 零行为变更
  const { createChargeConfirmGate } = require('./charge-confirm.js');
  const raw = String(process.env.PROXY_SAVINGS_PAID_ADAPTERS ?? '').trim();
  const paidAdapters = raw
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined; // 空 = 走默认名单
  return createChargeConfirmGate(paidAdapters ? { paidAdapters } : {});
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
    const executor = opts.executor !== undefined ? opts.executor : resolveExecutorOpt();
    const chargeConfirm = opts.chargeConfirm !== undefined ? opts.chargeConfirm : resolveChargeConfirmOpt();
    const gateway = opts.gateway || createSavingsGateway({
        circuitBreaker: opts.circuitBreaker || resolveCircuitBreakerOpt(),
        circuitMode: opts.circuitMode !== undefined ? opts.circuitMode : resolveCircuitModeOpt(),
        // forward 执行器启用时强制 shadow=off（否则内核不真调上游）；未启用则保持默认 shadow（零行为变更）
        ...(executor ? { executor, shadow: false } : {}),
        // 收费确认闸门（MPT 契约 2026-10-12）：门控注入，默认 undefined = 零行为变更
        ...(chargeConfirm ? { chargeConfirm } : {}),
    });
    const watchdog = opts.watchdog || createCostWatchdog();   // G1：硬上限看门狗（默认 hardCap=0 不拦）
    const server = http.createServer(async (req, res) => {
        const url = req.url || '/';
        const pathname = url.split('?')[0];

        if (req.method === 'GET' && pathname === '/health') {
            const cb = gateway.getCircuitBreaker();
            const circuit = cb ? { enabled: true, mode: (opts.circuitMode || resolveCircuitModeOpt()), ...cb.getStateSnapshot() } : { enabled: false };
            return json(res, 200, { ok: true, module: 'savings-gateway', gateOpen: gateOpen(), shadow: gateway.isShadow(), executor: gateway.getExecutor() ? 'forward' : 'none', circuit });
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
            // 收费确认旗标（MPT 契约 2026-10-12）：客户端显式带 X-Charge-Confirm: 1/true/on 才放行付费路由。
            // agent 绝不能静默加这个头（MPT 的 *_CHARGE_CONFIRMATION_REQUIRED 协议）——只有用户批准后才带。
            // 未带 = confirmed 默认 false → 内核在付费路由上抛 402。无闸门时此字段被忽略（零行为变更）。
            const chargeConfirmHeader = String(req.headers['x-charge-confirm'] ?? '').trim().toLowerCase();
            const chargeConfirmed = chargeConfirmHeader === '1' || chargeConfirmHeader === 'true' || chargeConfirmHeader === 'on';
            // G1：硬上限到限暂停——累计成本越过 hardCap 直接在真实执行/模拟前拒绝
            if (watchdog.state().block) {
                return openaiError(res, 429, 'budget hard cap reached; requests paused until cap is raised', 'budget_exceeded');
            }
            try {
                const out = gateway.handleChatCompletions(body, { key, chargeConfirm: chargeConfirmed });
                // 喂 watchdog 累计成本（G1：到限即拒；default hardCap=0 不影响旧行为）
                const entries = gateway.getSavingsLog();
                const lastEntry = entries[entries.length - 1];
                if (lastEntry) watchdog.record(lastEntry);
                // 二期缝（2026-10-08）：真实 executor 异步转发 + 喂熔断 outcome。
                // 仅当注入了 executor 且非 shadow 才走（默认 shadow → 跳过，零行为变更）。
                if (gateway.getExecutor() && !gateway.isShadow()) {
                    try {
                        const ex = await gateway.getExecutor()(out.model, body, { auth: key });
                        const cb = gateway.getCircuitBreaker();
                        if (cb && ex && typeof ex.status === 'string') {
                            // 只有上游自身故障（5xx / 429 / 408 / 网络不可达）才喂熔断；
                            // 4xx 客户端错误（坏 key、参数错）与本执行器不支持的流式都不算上游不健康。
                            if (ex.status === 'failed') cb.recordFailure(out.model);
                            else if (ex.status === 'done') cb.recordSuccess(out.model);
                        }
                        if (ex && ex.status === 'done' && ex.content != null) {
                            out.choices[0].message.content = ex.content;
                            out.x_savings.simulated = false;
                        }
                        // 诚实错误：上游失败绝不能返回 200 + 模拟内容（等于上游挂了还喂假答案）
                        if (ex && ex.status === 'failed') {
                            return openaiError(res, 502, `savings-gateway upstream error: ${ex.error || 'upstream failed'}`, 'upstream_unreachable');
                        }
                        if (ex && ex.status === 'unsupported') {
                            return openaiError(res, 501, 'savings-gateway forward executor does not support upstream streaming responses', 'stream_unsupported');
                        }
                        if (ex && ex.status === 'client_error') {
                            // 原样透传上游 4xx（通常是坏 key），让客户端看到真实原因
                            const sc = Number.isFinite(ex.statusCode) ? ex.statusCode : 400;
                            res.writeHead(sc, { 'Content-Type': 'application/json' });
                            return res.end(ex.raw || JSON.stringify({ error: { message: ex.error, type: 'upstream_client_error', code: null } }));
                        }
                    } catch (ef) {
                        const cb = gateway.getCircuitBreaker();
                        if (cb) cb.recordFailure(out.model);
                        return openaiError(res, 502, `savings-gateway upstream error: ${ef.message}`, 'upstream_unreachable');
                    }
                }
                return json(res, 200, out);
            } catch (e) {
                // 收费确认拦截（MPT 契约 2026-10-12）：402 优先识别，随错误带结构化 verdict（缺哪个确认一目了然）
                if (e.httpStatus === 402 && e.chargeConfirm) {
                    return json(res, 402, {
                        error: {
                            message: 'paid route requires explicit charge confirmation; add X-Charge-Confirm: true header only after user approval',
                            type: 'charge_confirmation_required',
                            code: 'charge_confirmation_required',
                        },
                        chargeConfirm: e.chargeConfirm,
                    });
                }
                const status = e.httpStatus === 401 ? 401 : (e.httpStatus === 503 ? 503 : 400);
                const type = e.httpStatus === 503 ? 'circuit_breaker_open'
                    : (e.message === 'invalid_api_key' || e.message === 'unknown_api_key' ? 'invalid_api_key' : 'invalid_request_error');
                return openaiError(res, status, e.message, type);
            }
        }

        openaiError(res, 404, `unknown route: ${req.method} ${pathname}`);
    });
    // 把网关挂到 server 实例上：start() 的启动日志需要读它（start 拿不到 createServer 的局部变量）。
    // 非侵入：只是多挂一个属性，不改变 http.Server 的任何既有行为。
    server._gateway = gateway;
    return server;
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
            const gw = server._gateway;
            console.log(`[savings-gateway] listening on ${host}:${addr.port} gate=${gateOpen() ? 'open' : 'closed(observe)'} shadow=${gw && gw.isShadow ? gw.isShadow() : 'n/a'}`);
            resolve(server);
        });
    });
}

module.exports = { createServer, start, DEFAULT_PORT };

if (require.main === module) {
    start().catch((e) => { console.error('[savings-gateway] start failed:', e.message); process.exit(1); });
}
