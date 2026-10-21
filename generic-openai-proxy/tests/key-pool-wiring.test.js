// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * key-pool wiring 集成测试（/v1/chat/completions）。
 * mock 全局 fetch 按 Authorization 头区分两把 key（K1/K2）：
 *   · 门控开 + K1 429 + K2 200 → 自动换 K2 再试 → 200（价值证明）
 *   · 门控关 + K1 429          → 不轮换、不进 provider-fallback → 429（零变更证明）
 *   · 门控开 + K1/K2 都 429    → 两把都试、有界停（不无限重试）→ 429
 * env 每个用例内现设（jest.setup-afterenv 会在用例后恢复 env，不能靠 beforeAll）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let mod, server, port;
let keyStatus = {};     // key → 上游状态（按 Authorization 头里的 key）
let fetchCalls = [];

function writeProviders(home) {
  const dir = path.join(home, '.multi-proxy-manager');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify([
    {
      id: 'ds-pool-test', name: 'DeepSeek', provider_id: 'deepseek',
      base_url: 'http://127.0.0.1:11434/v1', api_key: 'K1',
      models: ['deepseek-v4-flash'], enabled: true,
    },
  ], null, 2));
}

function stubFetch() {
  global.fetch = jest.fn(async (url, opts) => {
    const u = String(url);
    const isChat = u.includes('/chat/completions');
    const key = isChat ? String((opts && opts.headers && opts.headers.Authorization) || '').replace('Bearer ', '') : '';
    if (isChat) fetchCalls.push(key); // 只记 chat 转发；忽略 loadProxy 的异步模型同步 fetch（否则污染计数）
    const status = keyStatus[key] !== undefined ? keyStatus[key] : 200;
    const ok = status >= 200 && status < 300;
    return {
      ok, status,
      json: async () => ({
        id: 'x', choices: [{ message: { role: 'assistant', content: 'ok-' + key }, finish_reason: 'stop' }],
        model: 'deepseek-v4-flash',
      }),
      text: async () => JSON.stringify({ error: 'rate limit', status }),
    };
  });
}

function postChat() {
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] };
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (r) => {
      let buf = '';
      r.on('data', (c) => { buf += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: buf }));
    }).on('error', reject);
    req.end(data);
  });
}

beforeAll(() => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mproxy-kp-'));
  process.env.HOME = tmpHome;
  writeProviders(tmpHome);
  jest.resetModules();
  mod = require('../proxy.js');
  stubFetch();
  server = mod.app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => { port = server.address().port; resolve(); }));
});
afterAll((done) => { server.close(() => done()); });

function setupEnv() {
  process.env.PROXY_AUTH_TOKEN = '';          // 免鉴权
  process.env.DEEPSEEK_API_KEY_2 = 'K2';      // 第二把 key（env，不进 git）
  delete process.env.PROXY_CIRCUIT_BREAKER;
  delete process.env.PROXY_ROUTING_POLICY;
  delete process.env.PROXY_BUDGET_GUARD;
  fetchCalls = [];
}

describe('key-pool wiring', () => {
  test('门控开 + K1 429 + K2 200 → 换 K2 再试 → 200（价值）', async () => {
    setupEnv();
    process.env.PROXY_KEYPOOL = '1';
    keyStatus = { K1: 429, K2: 200 };
    const r = await postChat();
    expect(r.status).toBe(200);
    expect(fetchCalls).toEqual(['K1', 'K2']); // 先 K1 撞 429，自动换 K2 成功
  });

  test('门控关 + K1 429 → 不轮换（走 provider-fallback/原样透传）→ 429（零变更）', async () => {
    setupEnv();
    delete process.env.PROXY_KEYPOOL;
    keyStatus = { K1: 429, K2: 200 };
    const r = await postChat();
    expect(r.status).toBe(429);
    expect(fetchCalls).toEqual(['K1']); // 没用 K2，行为与上线前一致
  });

  test('门控开 + K1/K2 都 429 → 两把都试、有界停 → 429（不无限重试）', async () => {
    setupEnv();
    process.env.PROXY_KEYPOOL = '1';
    keyStatus = { K1: 429, K2: 429 };
    const r = await postChat();
    expect(r.status).toBe(429);
    expect(fetchCalls).toEqual(['K1', 'K2']); // 恰好两把各一次，不循环
  });

  test('门控开 + 无第二把（DEEPSEEK_API_KEY_2 空）→ 只试 K1 → 429', async () => {
    setupEnv();
    process.env.DEEPSEEK_API_KEY_2 = '';
    process.env.PROXY_KEYPOOL = '1';
    keyStatus = { K1: 429 };
    const r = await postChat();
    expect(r.status).toBe(429);
    expect(fetchCalls).toEqual(['K1']);
  });
});
