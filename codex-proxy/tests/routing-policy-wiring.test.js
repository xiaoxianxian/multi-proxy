// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * P6 wiring gate — model-id 级路由策略接进三条转发路由后的行为锁。
 *
 * 跑真 app（supertest + HOME 重定向到 tmp + fetch mock），覆盖四条：
 *   1. deny      → 400 MODEL_NOT_PERMITTED，且 fetch 未被调用（请求真被挡住）
 *   2. proxy     → 放行，打上游 URL（= 今天的行为）
 *   3. direct    → 透传到 takeover 真上游（P1 的真值库），用自己的 key
 *   4. 门控关    → 无策略，行为与上线前逐字一致（resolveRoute 恒 proxy）
 *
 * direct 目标解析不出 → 502 DIRECT_TARGET_UNRESOLVED（不猜、不静默回落）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
// ⚠️ jest.resetModules() 后重 require proxy.js 会跑 loadProxy()，含异步模型目录拉取，
//    实测 ~14s；默认 5s 超时不够。给足 30s，不掩盖逻辑——只放开时钟。
jest.setTimeout(30000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-p6-'));
process.env.HOME = tmp;
// 不设 PROXY_AUTH_TOKEN ⇒ fail-open，请求不带认证头（与 config-leak-gate 同手法）
delete process.env.PROXY_AUTH_TOKEN;

const POLICY_FILE = path.join(tmp, 'routing-policy.json');
process.env.PROXY_ROUTING_POLICY_FILE = POLICY_FILE;

const writePolicy = (obj) => fs.writeFileSync(POLICY_FILE, JSON.stringify(obj, null, 2));
const writeTakeover = (agent, obj) => {
  const f = path.join(tmp, '.multi-proxy-manager', `takeover-${agent}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
};

// fetch mock：记录调用参数，返回一个最小可用的上游响应
// ⚠️ reportUsage 会向 manager（127.0.0.1）上报用量，也会经过这个 mock ——
//    断言一律用 upstreamCalls() 过滤掉本地上报，只数真正的上游转发。
let fetchCalls = [];
const mockFetch = jest.fn(async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
    json: async () => ({ id: 'chatcmpl-mock', model: 'mock', choices: [] }),
    body: null,
  };
});
const upstreamCalls = () => fetchCalls.filter(c => !c.url.includes('127.0.0.1') && !c.url.includes('localhost'));

describe('P6 wiring: PROXY_ROUTING_POLICY=1（门控开）', () => {
  let app, loadRoutingPolicy;

  beforeAll(() => {
    process.env.PROXY_ROUTING_POLICY = '1';
    global.fetch = mockFetch;
    // require 在 env 设好之后：门控与文件路径都走上面注入的值
    const proxy = require('../proxy.js');
    app = proxy.app;
    loadRoutingPolicy = proxy.loadRoutingPolicy;
  });

  beforeEach(() => {
    fetchCalls = [];
    mockFetch.mockClear();
  });

  test('deny：白名单外的模型 → 400 MODEL_NOT_PERMITTED，且根本没碰上游', async () => {
    writePolicy({
      default: 'direct',
      rules: [
        { match: 'deepseek-*', action: 'proxy' },
        { match: 'agnes-*', action: 'proxy' },
        { match: 'kimi-*', action: 'deny' },
      ],
    });
    loadRoutingPolicy();

    const res = await request(app)
      .post('/v1/chat/completions')
 .send({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MODEL_NOT_PERMITTED');
    expect(res.body.error).toMatch(/kimi-k2\.6/);
    expect(upstreamCalls()).toHaveLength(0);   // 真挡住了，不是转完再报错
  });

  test('proxy：白名单内的模型 → 放行打上游（= 今天的行为）', async () => {
    writePolicy({ default: 'deny', rules: [{ match: 'deepseek-v4-flash', action: 'proxy' }] });
    loadRoutingPolicy();

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(upstreamCalls()).toHaveLength(1);
    expect(upstreamCalls()[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  test('direct：未列模型 → 透传到 takeover 真上游，带该上游的 key', async () => {
    writePolicy({
      default: 'direct',
      rules: [{ match: 'deepseek-v4-flash', action: 'proxy' }],
    });
    loadRoutingPolicy();
    // detectAgent 默认（无 UA 命中）返回 'codex-proxy' ⇒ 读 takeover-codex-proxy.json
    writeTakeover('codex-proxy', {
      agent: 'codex-proxy',
      upstream: 'https://direct-upstream.example/v1/',
      apiKeyEnv: 'DIRECT_TEST_KEY',
    });
    process.env.DIRECT_TEST_KEY = 'sk-direct-real';

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(upstreamCalls()).toHaveLength(1);
    // URL = takeover upstream + 去 /v1 前缀的入站路径（不拼出 /v1/v1）
    expect(upstreamCalls()[0].url).toBe('https://direct-upstream.example/v1/chat/completions');
    // key 来自 env（takeover 记的是 env 名，不是明文 key）
    expect(upstreamCalls()[0].opts.headers['Authorization']).toBe('Bearer sk-direct-real');
    delete process.env.DIRECT_TEST_KEY;
  });

  test('direct 目标解析不出 → 502 DIRECT_TARGET_UNRESOLVED（不猜、不回落 proxy）', async () => {
    writePolicy({ default: 'direct' });   // 全员 direct
    loadRoutingPolicy();
    // 不给这个 agent 建 takeover 记录

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('x-agent', 'cursor')           // 显式指定一个没有 takeover 记录的 agent
      .send({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('DIRECT_TARGET_UNRESOLVED');
    expect(res.body.error).toMatch(/cursor/);
    expect(upstreamCalls()).toHaveLength(0);   // 没有静默回落成 proxy
  });

  test('apiKeyEnv 指向的 env 没设 → 502（不猜空 key 发出去）', async () => {
    writePolicy({ default: 'direct' });
    loadRoutingPolicy();
    writeTakeover('codex-proxy', {
      agent: 'codex-proxy',
      upstream: 'https://direct-upstream.example/v1',
      apiKeyEnv: 'NOT_SET_ANYWHERE',
    });
    delete process.env.NOT_SET_ANYWHERE;

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/NOT_SET_ANYWHERE/);
    expect(upstreamCalls()).toHaveLength(0);
  });

  test('畸形策略 → 按无策略处理（老行为：放行），不是拒绝服务', async () => {
    fs.writeFileSync(POLICY_FILE, '{ this is not json');
    loadRoutingPolicy();

    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);   // fail-safe 退回老行为，不是把所有人挡在门外
    expect(upstreamCalls()).toHaveLength(1);
  });
});

describe('P6 wiring: 门控关（PROXY_ROUTING_POLICY 未设）→ 零行为变更', () => {
  test('deny 规则写了也不生效：模型照常放行', async () => {
    jest.resetModules();
    delete process.env.PROXY_ROUTING_POLICY;
    global.fetch = mockFetch;
    const proxy = require('../proxy.js');
    proxy.loadRoutingPolicy();
    expect(proxy.getRoutingPolicy()).toBeNull();
    fetchCalls = [];
    mockFetch.mockClear();

    // 即便策略文件写着全员 deny，门控关 ⇒ 完全不读它
    writePolicy({ default: 'deny', rules: [{ match: '*', action: 'deny' }] });

    const res = await request(proxy.app)
      .post('/v1/chat/completions')
      .send({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(upstreamCalls()).toHaveLength(1);
  });
});
