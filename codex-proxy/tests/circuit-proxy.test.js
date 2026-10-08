/**
 * per-provider 上游熔断回归（18790 codex-proxy，2026-10-09）
 *
 * 守的是三条硬语义：
 *   1. 门控关 → 零行为变更（上游 500 原样透传 500，/health 报 enabled:false）
 *   2. 上游真故障（5xx）→ 喂熔断 → OPEN 后 block 模式快速 503 CIRCUIT_OPEN
 *   3. 客户端错（401 坏 key）→ **不喂**熔断，原样透传 401，breaker 保持 CLOSED
 *      反例：把 401 也记失败，一个用错 key 的客户端就能熔断整个 provider、连累所有流量。
 *
 * fetch 全部打桩，不产生任何真实上游流量。
 */
'use strict';

// 单用例实测波动很大：单跑 6~8s，但全量并行时 CPU 争抢下能到 30s+。
// 慢的不是逻辑而是加载——require('../proxy.js')（express 依赖链）约 3s，
// 且每条用例都要 jest.resetModules() 重建 registry（门控 env 必须逐例隔离）。
// 给足 120s，避免把「机器慢」误判成「熔断语义错」。
jest.setTimeout(120000);

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEYS = ['HOME', 'PROXY_AUTH_TOKEN', 'PROXY_CIRCUIT_BREAKER', 'PROXY_CIRCUIT_MODE', 'PORT'];

function loadProxy(env = {}) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mproxy-home-'));
  process.env.HOME = tmpHome;              // 隔离 ~/.multi-proxy-manager/providers.json
  process.env.PROXY_AUTH_TOKEN = '';       // 免鉴权
  delete process.env.PROXY_CIRCUIT_BREAKER;
  delete process.env.PROXY_CIRCUIT_MODE;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  jest.resetModules();
  // eslint-disable-next-line global-require
  const mod = require('../proxy.js');

  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return mod;
}

/** 打桩上游：返回固定 status 的 JSON 响应（非流式，避开 body 管道） */
function stubFetch(status, payload = {}) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
}

function startServer(mod) {
  const server = mod.app.listen(0, '127.0.0.1');
  return new Promise((resolve) => {
    server.once('listening', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(port, data, resolve, reject);
    req.end(data);
  });
}

function httpRequest(port, data, resolve, reject) {
  return require('http').request(
    {
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    },
    (r) => {
      let buf = '';
      r.on('data', (c) => { buf += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: buf }));
    },
  ).on('error', reject);
}

/** GET /health（免鉴权：PROXY_AUTH_TOKEN=''） */
function getHealth(port) {
  return new Promise((resolve, reject) => {
    require('http')
      .get({ host: '127.0.0.1', port, path: '/health' }, (r) => {
        let buf = '';
        r.on('data', (c) => { buf += c; });
        r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(buf) }));
      })
      .on('error', reject);
  });
}

const BODY = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }] };

/**
 * ⚠️ 必须读 per-provider 快照，不能读 cb.currentState：
 * 熔断器对带 providerId 的调用会生成 sibling 实例，主实例（default）永远 CLOSED。
 * 读主实例会让「坏 key 不误熔断」这种断言变成假通过。
 */
function providerState(cb, name) {
  const all = cb.getProviders();
  return all[name] || { state: 'CLOSED', failureCount: 0 };
}

describe('codex-proxy per-provider 上游熔断', () => {
  test('① 门控关 → 零行为变更：上游 500 原样透传，breaker=null', async () => {
    const mod = loadProxy();                       // 不设 PROXY_CIRCUIT_BREAKER
    expect(mod.getCircuitBreaker()).toBeNull();
    stubFetch(500);
    const { server, port } = await startServer(mod);
    try {
      const r = await post(port, BODY);
      expect(r.status).toBe(500);                  // 原样透传，没有被熔断改写
    } finally {
      await closeServer(server);
    }
  });

  test('② 上游 5xx → 喂熔断 → OPEN 后 block 模式返 503 CIRCUIT_OPEN', async () => {
    const mod = loadProxy({ PROXY_CIRCUIT_BREAKER: 'recommended', PROXY_CIRCUIT_MODE: 'block' });
    const cb = mod.getCircuitBreaker();
    expect(cb).not.toBeNull();
    stubFetch(500);
    const { server, port } = await startServer(mod);
    try {
      let saw503 = false;
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await post(port, BODY);
        if (r.status === 503) { saw503 = true; expect(r.body).toContain('CIRCUIT_OPEN'); break; }
      }
      expect(saw503).toBe(true);
      expect(providerState(cb, 'DeepSeek').state).toBe('OPEN');
    } finally {
      await closeServer(server);
    }
  });

  test('③ 401 坏 key 不喂熔断：原样透传 401 且 breaker 保持 CLOSED', async () => {
    const mod = loadProxy({ PROXY_CIRCUIT_BREAKER: 'recommended', PROXY_CIRCUIT_MODE: 'block' });
    const cb = mod.getCircuitBreaker();
    stubFetch(401);
    const { server, port } = await startServer(mod);
    try {
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await post(port, BODY);
        expect(r.status).toBe(401);                // 客户端错原样透传，绝不能被熔断改成 503
      }
      expect(providerState(cb, 'DeepSeek').state).toBe('CLOSED');   // 关键：坏 key 不能熔断 provider
      expect(providerState(cb, 'DeepSeek').failureCount).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  test('④ 上游 200 → 记成功，breaker 保持 CLOSED', async () => {
    const mod = loadProxy({ PROXY_CIRCUIT_BREAKER: 'recommended', PROXY_CIRCUIT_MODE: 'block' });
    const cb = mod.getCircuitBreaker();
    stubFetch(200, { choices: [{ message: { content: 'ok' } }] });
    const { server, port } = await startServer(mod);
    try {
      const r = await post(port, BODY);
      expect(r.status).toBe(200);
      expect(providerState(cb, 'DeepSeek').state).toBe('CLOSED');
    } finally {
      await closeServer(server);
    }
  });

  test('⑤ classifyUpstreamStatus 分类：5xx/429/408 算上游，其余 4xx 算客户端', () => {
    const mod = loadProxy();
    expect(mod.classifyUpstreamStatus(500)).toBe('upstream');
    expect(mod.classifyUpstreamStatus(503)).toBe('upstream');
    expect(mod.classifyUpstreamStatus(429)).toBe('upstream');
    expect(mod.classifyUpstreamStatus(408)).toBe('upstream');
    expect(mod.classifyUpstreamStatus(401)).toBe('client');
    expect(mod.classifyUpstreamStatus(400)).toBe('client');
    expect(mod.classifyUpstreamStatus(404)).toBe('client');
  });

  test('⑥ observe（默认/线上现状）只记账不拦：OPEN 后仍原样透传 500，绝不出现 503', async () => {
    const mod = loadProxy({ PROXY_CIRCUIT_BREAKER: 'recommended' });   // 不设 MODE → observe
    const cb = mod.getCircuitBreaker();
    stubFetch(500);
    const { server, port } = await startServer(mod);
    try {
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await post(port, BODY);
        expect(r.status).toBe(500);              // observe = 只记账，行为与门控关时一致
      }
      expect(providerState(cb, 'DeepSeek').state).toBe('OPEN');   // 但账要记下来
    } finally {
      await closeServer(server);
    }
  });

  test('⑦ /health 暴露 per-provider 明细（不是只看主实例）', async () => {
    const mod = loadProxy({ PROXY_CIRCUIT_BREAKER: 'recommended', PROXY_CIRCUIT_MODE: 'observe' });
    stubFetch(500);
    const { server, port } = await startServer(mod);
    try {
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await post(port, BODY);
      }
      const h = await getHealth(port);
      const c = h.json.circuit;
      expect(c.enabled).toBe(true);
      expect(c.mode).toBe('observe');
      // 关键：主实例恒 CLOSED，必须能从 providers 里看见真状态
      expect(c.state).toBe('CLOSED');
      expect(c.providers.DeepSeek.state).toBe('OPEN');
      expect(c.totals.tracked).toBe(1);
      expect(c.totals.open).toContain('DeepSeek');
      expect(c.totals.worstErrorRate).toBeGreaterThan(0.5);
    } finally {
      await closeServer(server);
    }
  });

  test('⑧ 门控关 → /health 报 enabled:false 且不带 providers', async () => {
    const mod = loadProxy();
    stubFetch(500);
    const { server, port } = await startServer(mod);
    try {
      const h = await getHealth(port);
      expect(h.json.circuit).toEqual({ enabled: false });
    } finally {
      await closeServer(server);
    }
  });
});
