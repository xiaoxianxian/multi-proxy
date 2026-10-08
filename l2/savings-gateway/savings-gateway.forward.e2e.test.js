// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
//
// savings-gateway 真实 executor 端到端测试（二期缝·2026-10-08）
// 起一个可切换 200/500 的假上游，验证：
//   ① 上游健康 → 200，内容来自真上游，breaker 保持 CLOSED（不误伤）
//   ② 上游持续 500 → 真 outcome 喂回 breaker → 熔断 OPEN → failover 无健康候选 → 503
//   ③ 上游恢复 → 半开探测成功 → 回到 CLOSED → 重新 200
// 全程不依赖真实 provider key / 18790，确定性、可离线跑。
//
// 用法：node l2/savings-gateway/savings-gateway.forward.e2e.test.js

'use strict';

// 开网关门控（否则 /v1/chat/completions 返回 403 gate-closed），仅本测试进程生效
process.env.PROXY_SAVINGS_GATEWAY = '1';

const http = require('http');
const assert = require('assert');
const { createServer } = require('./server.js');
const { createSavingsGateway, createForwardExecutor } = require('./gateway.js');
const { CircuitBreaker } = require('../circuit-breaker.js');

function startFakeUpstream(state) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        if (state.mode === '401') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        }
        if (state.down) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'upstream down' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK from upstream' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function post(port, body, auth) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: auth || 'Bearer gw_default-large' },
    }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  const state = { down: false };
  const up = await startFakeUpstream(state);
  const upPort = up.address().port;

  // 快速熔断配置（测试用，避免等 30s resetTimeout）
  const fastBreaker = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 600, errorRateThreshold: 0.6, slidingWindowSize: 10, minRequests: 1, successThreshold: 1, halfOpenMaxCalls: 3 });
  const gw = createSavingsGateway({
    circuitBreaker: fastBreaker,
    circuitMode: 'failover',
    executor: createForwardExecutor(`http://127.0.0.1:${upPort}`),
    shadow: false,
  });
  const srv = createServer({ gateway: gw, circuitMode: 'failover' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const gwPort = srv.address().port;
  const body = { messages: [{ role: 'user', content: 'hi' }], complexity: 'medium', usage: { prompt_tokens: 1, completion_tokens: 1 } };

  let pass = 0;
  const check = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✓ ${name}`); };

  // ① 上游健康 → 200，内容来自真上游
  const r1 = await post(gwPort, body);
  check('上游健康 → 200', r1.status === 200);
  check('内容来自真上游（非 shadow 模拟）', r1.body.includes('OK from upstream'));
  check('breaker 仍 CLOSED', gw.getCircuitBreaker().currentState === 'CLOSED');

  // ② 上游持续 500 → 真 outcome 喂回 → 熔断 OPEN → failover 无健康候选 → 503
  state.down = true;
  let saw503 = false;
  for (let i = 0; i < 8; i++) {
    const x = await post(gwPort, body);
    if (x.status === 503) { saw503 = true; break; }
  }
  check('上游故障后 → 熔断触发 503（真实 outcome 喂回生效）', saw503 === true);

  // ③ 上游恢复 → 半开探测 → 回到 CLOSED → 200
  state.down = false;
  await new Promise((r) => setTimeout(r, 800)); // 等 resetTimeout(600) 触发 HALF_OPEN
  let recovered = false;
  for (let i = 0; i < 5; i++) {
    const x = await post(gwPort, body);
    if (x.status === 200 && x.body.includes('OK from upstream')) { recovered = true; break; }
  }
  check('上游恢复 → 半开探测成功 → 重新 200', recovered === true);
  check('breaker 回到 CLOSED', gw.getCircuitBreaker().currentState === 'CLOSED');

  // ④ 上游 401（客户端坏 key）→ 原样透传 401，且**不得**喂熔断（否则一个错 key 连累所有流量）
  state.mode = '401';
  const r401 = await post(gwPort, body, 'Bearer bad-key');
  check('上游 401 → 透传 401（不伪装成 200）', r401.status === 401);
  check('401 不喂熔断 → breaker 仍 CLOSED', gw.getCircuitBreaker().currentState === 'CLOSED');
  check('401 不记失败（failureCount 未涨）', gw.getCircuitBreaker().getStateSnapshot().failureCount === 0);

  srv.close();
  up.close();
  console.log(`\n[savings-gateway forward e2e] PASS ${pass} / ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
