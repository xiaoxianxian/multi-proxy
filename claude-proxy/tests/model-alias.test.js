// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * claude-proxy 核心增量测试：MODEL_ALIASES（claude-* → 上游真名映射）。
 *
 * 这是「Claude Code 零改动接入」的兑现点——选择器/--model/ANTHROPIC_MODEL
 * 发什么 claude 名字，都必须落到可转发的上游模型上，且：
 *   · /v1/messages 走 Anthropic 协议路径（deepseek/moonshot 的 /anthropic 端点）
 *   · 成本记账用映射后的真名（定价才对）
 *   · 非 claude 名原样透传（上游真名直连不受影响）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const request = require('supertest');
jest.setTimeout(30000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alias-'));
process.env.HOME = tmp;
delete process.env.PROXY_AUTH_TOKEN;                       // fail-open，与 wiring 测试同手法
process.env.DEEPSEEK_API_KEY = 'sk-deepseek-test';
process.env.MOONSHOT_API_KEY = 'sk-moonshot-test';
process.env.AGNES_API_KEY = 'sk-agnes-test';
// 门控全关：只验别名本身，不掺路由策略/预算/熔断变量
delete process.env.PROXY_ROUTING_POLICY;
delete process.env.PROXY_BUDGET_GUARD;

let fetchCalls = [];
const mockFetch = jest.fn(async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  // /v1/messages 走 pipeUpstreamBytes：必须给 web 流（Readable.fromWeb），
  // body 为 null 时该函数直接 return undefined，handler 解构会炸（500）。
  const payload = Buffer.from('{"id":"msg-mock","type":"message","content":[]}');
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
    json: async () => ({ id: 'msg-mock', model: 'mock', content: [] }),
    text: async () => payload.toString(),
    body: Readable.toWeb(Readable.from([payload])),
  };
});
const upstreamCalls = () => fetchCalls.filter(c => !c.url.includes('127.0.0.1') && !c.url.includes('localhost'));

describe('MODEL_ALIASES — 纯函数', () => {
  let resolveAlias, applyModelAlias, ALIAS_DISPLAY;
  beforeAll(() => {
    ({ resolveAlias, applyModelAlias, ALIAS_DISPLAY } = require('../proxy.js'));
  });

  test('三个档位按前缀命中默认表', () => {
    expect(resolveAlias('claude-sonnet-4-5')).toBe('deepseek-v4-pro');
    expect(resolveAlias('claude-3-5-sonnet-20241022')).toBe('deepseek-v4-pro');
    expect(resolveAlias('claude-opus-4-5')).toBe('deepseek-v4-pro');
    expect(resolveAlias('claude-3-opus-20240229')).toBe('deepseek-v4-pro');
    expect(resolveAlias('claude-3-5-haiku-20241022')).toBe('agnes-3.0-flash');
    expect(resolveAlias('claude-3-haiku-20240307')).toBe('agnes-3.0-flash');
  });

  test('大小写不敏感', () => {
    expect(resolveAlias('Claude-Sonnet-4-5')).toBe('deepseek-v4-pro');
    expect(resolveAlias('CLAUDE-3-5-HAIKU-20241022')).toBe('agnes-3.0-flash');
  });

  test('非 claude 名原样返回（上游真名直连）', () => {
    expect(resolveAlias('deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(resolveAlias('agnes-3.0-flash')).toBe('agnes-3.0-flash');
    expect(resolveAlias('kimi-k2.5')).toBe('kimi-k2.5');
  });

  test('空值/非字符串不炸', () => {
    expect(resolveAlias(undefined)).toBeUndefined();
    expect(resolveAlias(null)).toBeNull();
    expect(resolveAlias('')).toBe('');
    expect(resolveAlias(42)).toBe(42);
  });

  test('applyModelAlias 就地改写 body.model', () => {
    const body = { model: 'claude-sonnet-4-5', messages: [] };
    const mapped = applyModelAlias(body);
    expect(mapped).toBe('deepseek-v4-pro');
    expect(body.model).toBe('deepseek-v4-pro');   // 就地：上游与记账都用真名
  });

  test('ALIAS_DISPLAY 覆盖 Claude Code 常见名字形态', () => {
    for (const name of ALIAS_DISPLAY) {
      expect(resolveAlias(name)).not.toBe(name);  // 展示名必须都能映射走
    }
  });
});

describe('MODEL_ALIASES — /v1/messages 端到端（Anthropic 协议路径）', () => {
  let app;
  beforeAll(() => {
    global.fetch = mockFetch;
    app = require('../proxy.js').app;
  });
  beforeEach(() => { fetchCalls = []; mockFetch.mockClear(); });

  test('claude-sonnet-4-5 → deepseek 的 /anthropic/v1/messages，body 改写为真名', async () => {
    const res = await request(app)
      .post('/v1/messages')
      .set('anthropic-version', '2023-06-01')
      .send({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    const calls = upstreamCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(JSON.parse(calls[0].opts.body).model).toBe('deepseek-v4-pro');
    expect(calls[0].opts.headers['x-api-key']).toBe('sk-deepseek-test');
    expect(calls[0].opts.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('claude-3-5-haiku-20241022 → agnes 的 /v1/messages（根路径型上游）', async () => {
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    const calls = upstreamCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://apihub.agnes-ai.com/v1/messages');
    expect(JSON.parse(calls[0].opts.body).model).toBe('agnes-3.0-flash');
    expect(calls[0].opts.headers['x-api-key']).toBe('sk-agnes-test');
  });

  test('上游真名直连不受别名影响', async () => {
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    const calls = upstreamCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].opts.body).model).toBe('deepseek-v4-flash');
  });

  test('未知 claude 名字以外的怪名字 → UNSUPPORTED_MODEL（不瞎映射）', async () => {
    const res = await request(app)
      .post('/v1/messages')
      .send({ model: 'claude-99-ultra', messages: [] });

    // claude-99-ultra 不匹配任何档位前缀 ⇒ 原样进 findProvider ⇒ 无此上游 ⇒ 400
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_MODEL');
    expect(upstreamCalls()).toHaveLength(0);
  });

  test('chat/completions 入口同样映射（OpenAI 风格客户端备用口）', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'claude-opus-4-5', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    const calls = upstreamCalls();
    expect(calls).toHaveLength(1);
    // 该入口走 OpenAI 风格 URL（与 /v1/messages 的 /anthropic 路径是两条路，都对）
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(JSON.parse(calls[0].opts.body).model).toBe('deepseek-v4-pro');
  });
});

describe('claude-proxy 附加面', () => {
  let app, resolveAlias;
  beforeAll(() => {
    global.fetch = mockFetch;
    ({ app, resolveAlias } = require('../proxy.js'));
  });

  test('/v1/models 同时列出上游真名与 claude 别名', async () => {
    const res = await request(app).get('/v1/models');
    expect(res.status).toBe(200);
    const ids = res.body.data.map(m => m.id);
    expect(ids).toContain('deepseek-v4-pro');
    expect(ids).toContain('claude-sonnet-4-5');
    expect(ids).toContain('claude-3-5-haiku-20241022');
  });

  test('count_tokens 返回保守估算', async () => {
    const res = await request(app)
      .post('/v1/messages/count_tokens')
      .send({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello world' }] });
    expect(res.status).toBe(200);
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });

  test('env 覆盖别名目标（CLAUDE_ALIAS_SONNET）', () => {
    process.env.CLAUDE_ALIAS_SONNET = 'moonshot-v1-8k';
    expect(resolveAlias('claude-sonnet-4-5')).toBe('moonshot-v1-8k');
    delete process.env.CLAUDE_ALIAS_SONNET;
    expect(resolveAlias('claude-sonnet-4-5')).toBe('deepseek-v4-pro'); // 删后回默认
  });

  test('无客户端配置文件时 /health 仍是 healthy（不无谓 degraded）', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.checks.config).toBe(true);
  });
});

