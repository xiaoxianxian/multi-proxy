// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// 集成测试：/v1/chat/completions 的 bounded failover。
// 复用 loadProxy 思路（隔离 HOME + 免鉴权），mock 全局 fetch 按 URL 区分两个上游：
//   · 127.0.0.1:11434 = Ollama（primary，带 fallback）
//   · 127.0.0.1:18789 = WorkBuddy（fallback 目标）
// 验证：Ollama 瞬态 500 → 切 WorkBuddy 200；Ollama 确定性 400 → 不切；双 500 → 链耗尽 502。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let mod;
let server;
let port;

// 上游状态（按 URL host:port 区分）
let ollamaStatus = 200;
let wbStatus = 200;

function writeProviders(home) {
  const dir = path.join(home, '.multi-proxy-manager');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify([
    {
      id: 'ollama-local-0001', name: 'Ollama-Local', provider_id: 'ollama', api_key: '',
      base_url: 'http://127.0.0.1:11434/v1', models: ['qwen3.8:27b-mlx'],
      fallback: ['wb-deepseek-v3.2'], enabled: true,
    },
    {
      id: 'wb-shim-0001', name: 'WorkBuddy', provider_id: 'workbuddy', api_key: 'x',
      base_url: 'http://127.0.0.1:18789/v1', models: ['wb-deepseek-v3.2'], enabled: true,
    },
  ], null, 2));
}

function stubFetch() {
  global.fetch = jest.fn(async (url, opts) => {
    const u = String(url);
    const status = u.includes('11434') ? ollamaStatus : (u.includes('18789') ? wbStatus : 200);
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      json: async () => ({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'ok-from-' + u }, finish_reason: 'stop' }],
        model: opts && opts.body ? JSON.parse(opts.body).model : 'x',
      }),
      text: async () => JSON.stringify({ error: 'upstream', status }),
    };
  });
}

function postChat(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
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
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mproxy-fb-'));
  process.env.HOME = tmpHome;
  process.env.PROXY_AUTH_TOKEN = '';
  delete process.env.PROXY_CIRCUIT_BREAKER;
  delete process.env.PROXY_CIRCUIT_MODE;
  delete process.env.PROXY_ROUTING_POLICY;
  delete process.env.PROXY_BUDGET_GUARD;
  writeProviders(tmpHome);
  jest.resetModules();
  mod = require('../proxy.js');
  stubFetch();
  server = mod.app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => { port = server.address().port; resolve(); }));
});

afterAll((done) => { server.close(() => done()); });

describe('chat handler: bounded failover', () => {
  test('Ollama 500 → WorkBuddy 200 兜底', async () => {
    ollamaStatus = 500; wbStatus = 200;
    const r = await postChat({ model: 'qwen3.8:27b-mlx', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect(r.body).toContain('18789');   // 实际由 WorkBuddy 上游返回
  });

  test('Ollama 400（确定性）→ 不 fallback，返回 400', async () => {
    ollamaStatus = 400; wbStatus = 200;
    const r = await postChat({ model: 'qwen3.8:27b-mlx', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('18789');  // 没切到 WorkBuddy
  });

  test('Ollama 500 + WorkBuddy 500 → 链耗尽 502 FALLBACK_EXHAUSTED', async () => {
    ollamaStatus = 500; wbStatus = 500;
    const r = await postChat({ model: 'qwen3.8:27b-mlx', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(502);
    expect(r.body).toContain('FALLBACK_EXHAUSTED');
  });
});
