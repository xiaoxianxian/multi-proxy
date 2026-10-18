// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// 集成测试：/v1/chat/completions 入口的子 agent 上下文观测接线。
// 复用 chat-failover.test.js 的 harness（隔离 HOME + providers.json + mock 全局 fetch），
// 验证（外部对照 #71 PilotDeck 落地件，2026-10-18）：
//   1. 带 <multi-proxy-subagent-model> 标签 + tools 无派发工具 ⇒ [subagent] 日志命中，
//      且请求**照常完成**（观测不阻断、不改写——mock 上游收到的 body 与客户端发的逐字节一致）；
//   2. 门控关 ⇒ 零日志、请求照常；
//   3. 主 agent 形态（tools 含 agent）⇒ 不误判；
//   4. x-main-agent: false 头 ⇒ 命中（显式标志法）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let mod;
let server;
let port;

// mock 上游收到的最后一个请求体（断言「观测不改写」用）
let lastUpstreamBody = null;

function writeProviders(home) {
  const dir = path.join(home, '.multi-proxy-manager');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify([
    {
      id: 'wire-up-0001', name: 'Wire-Upstream', provider_id: 'wire', api_key: 'x',
      base_url: 'http://127.0.0.1:19999/v1', models: ['wire-test-model'], enabled: true,
    },
  ], null, 2));
}

function stubFetch() {
  global.fetch = jest.fn(async (url, opts) => {
    const u = String(url);
    // 只对上游 URL 记录请求体；reportUsage 等其它 fetch（manager 上报）一律吞掉不记录
    if (u.includes('19999')) {
      lastUpstreamBody = opts && opts.body ? JSON.parse(opts.body) : null;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'chatcmpl-wire-1',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          model: 'wire-test-model',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: async () => '{}',
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  });
}

function postChat(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (r) => {
      let buf = '';
      r.on('data', (c) => { buf += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: buf }));
    }).on('error', reject);
    req.end(data);
  });
}

beforeAll(() => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mproxy-subagent-'));
  process.env.HOME = tmpHome;
  process.env.PROXY_AUTH_TOKEN = '';
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

describe('chat handler: subagent 观测（PROXY_SUBAGENT_DETECT）', () => {
  test('标签 + tools 反推双信号 ⇒ 命中日志，且请求照常完成、上游 body 逐字节不变', async () => {
    process.env.PROXY_SUBAGENT_DETECT = '1';
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      const body = {
        model: 'wire-test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: '调研这个仓库<multi-proxy-subagent-model>wire-light-model</multi-proxy-subagent-model>' }] }],
        tools: [{ name: 'read_file' }, { name: 'grep' }], // 无派发工具 ⇒ 反推命中
      };
      const r = await postChat(body);
      expect(r.status).toBe(200);
      // 命中日志（双信号：tagged + missing-agent-tool）
      const subLog = logs.find((l) => l.includes('[subagent]'));
      expect(subLog).toBeDefined();
      expect(subLog).toContain('tagged');
      expect(subLog).toContain('missing-agent-tool');
      expect(subLog).toContain('wire-light-model');
      // 观测不改写：上游收到的 body 与客户端发的完全一致（标签没被剥、tools 没被动）
      expect(lastUpstreamBody).toEqual(body);
    } finally {
      spy.mockRestore();
      delete process.env.PROXY_SUBAGENT_DETECT;
    }
  });

  test('门控关 ⇒ 零日志、请求照常', async () => {
    delete process.env.PROXY_SUBAGENT_DETECT;
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      const r = await postChat({
        model: 'wire-test-model',
        messages: [{ role: 'user', content: '干点活<multi-proxy-subagent-model>m</multi-proxy-subagent-model>' }],
        tools: [{ name: 'read_file' }],
      });
      expect(r.status).toBe(200);
      expect(logs.find((l) => l.includes('[subagent]'))).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test('主 agent 形态（tools 含 agent）⇒ 不误判', async () => {
    process.env.PROXY_SUBAGENT_DETECT = '1';
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      const r = await postChat({
        model: 'wire-test-model',
        messages: [{ role: 'user', content: '帮我重构模块' }],
        tools: [{ name: 'agent' }, { name: 'read_file' }],
      });
      expect(r.status).toBe(200);
      expect(logs.find((l) => l.includes('[subagent]'))).toBeUndefined();
    } finally {
      spy.mockRestore();
      delete process.env.PROXY_SUBAGENT_DETECT;
    }
  });

  test('x-main-agent: false 头 ⇒ 显式标志法命中', async () => {
    process.env.PROXY_SUBAGENT_DETECT = '1';
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      const r = await postChat(
        { model: 'wire-test-model', messages: [{ role: 'user', content: '子任务' }], tools: [{ name: 'agent' }] },
        { 'x-main-agent': 'false' },
      );
      expect(r.status).toBe(200);
      const subLog = logs.find((l) => l.includes('[subagent]'));
      expect(subLog).toBeDefined();
      expect(subLog).toContain('explicit');
    } finally {
      spy.mockRestore();
      delete process.env.PROXY_SUBAGENT_DETECT;
    }
  });
});
