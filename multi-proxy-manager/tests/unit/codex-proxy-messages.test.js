/**
 * codex-proxy /v1/messages 路由回环测试（Anthropic wire）。
 *
 * 目标：锁住「Claude Code 把 ANTHROPIC_BASE_URL 指到 18790」这条路的关键事实：
 *   1. 上游 URL 必须是**同协议直通**的 Anthropic 兼容路径（去掉 /v1 再挂 /anthropic），
 *      而不是被误走成 /v1/chat/completions（那是翻译，我们没有写翻译层）。
 *   2. 🔴 鉴权必须**换成 provider 自己的 key**，绝不能把入站的 Claude Code token 透上去。
 *   3. anthropic-version 透传；入站缺省则兜 2023-06-01（Anthropic 必填头）。
 *   4. 入站是 Bearer 形态（ANTHROPIC_AUTH_TOKEN）时，上游也带一份同值 Bearer；
 *      入站没有就不带（不要凭空造一个 undefined Bearer）。
 *   5. 上游非 2xx 原样透传状态码（不把真因盖成 500）。
 *
 * 用 supertest(app) + stub global.fetch，不发真实外网请求（不扣费）。
 */

// 必须在 require proxy.js 之前设 —— UPSTREAM_MODELS / DATA_DIR 都是模块加载时求值的常量。
//   ⚠️ HOME 必须指到临时目录：否则 loadProviders() 会读本机真实的
//      ~/.multi-proxy-manager/providers.json；那里若有个也声明了 deepseek-v4-pro 的自定义
//      provider，会**抢占内置 provider**（findProvider 的设计优先级，见 proxy.js:190-198），
//      断言就变成依赖运行环境了 —— 本文件首跑就是这么挂的（拿到的上游 key 是本机真 key，
//      而非 env 里的测试 key）。隔离后：providers.json 不存在 → 回落内置 → key 来自 env。
const fs = require('fs');
const os = require('os');
const path = require('path');
delete process.env.PROXY_AUTH_TOKEN;
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-msg-test-'));
process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';

const request = require('supertest');
const { app } = require('../../../codex-proxy/proxy.js');

const capture = [];

beforeEach(() => {
  capture.length = 0;
  global.fetch = jest.fn(async (url, opts) => {
    capture.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    return new Response(
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '收到' }], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
});

afterEach(() => { jest.restoreAllMocks(); });

describe('POST /v1/messages', () => {
  test('不支持的模型 → 400 UNSUPPORTED_MODEL（不碰上游）', async () => {
    const r = await request(app)
      .post('/v1/messages')
      .send({ model: 'totally-unknown-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UNSUPPORTED_MODEL');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('🔴 上游是同协议直通：URL 为 {base}/anthropic/v1/messages（不是 /v1/chat/completions）', async () => {
    await request(app)
      .post('/v1/messages')
      .send({ model: 'deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sent = capture[0];
    expect(sent.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    // 反向断言：绝不能落到 OpenAI 面
    expect(sent.url).not.toContain('/chat/completions');
    expect(sent.url).not.toContain('/responses');
  });

  test('🔴 鉴权换成 provider 的 key（入站 token 绝不上游透传）', async () => {
    await request(app)
      .post('/v1/messages')
      .set('x-api-key', 'INBOUND-CLAUDE-TOKEN')
      .send({ model: 'deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

    const sent = capture[0];
    expect(sent.headers['x-api-key']).toBe('sk-test-deepseek');
    expect(sent.headers['x-api-key']).not.toBe('INBOUND-CLAUDE-TOKEN');
  });

  test('anthropic-version 透传；缺席则兜 2023-06-01', async () => {
    await request(app)
      .post('/v1/messages')
      .set('anthropic-version', '2024-10-22')
      .send({ model: 'deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(capture[0].headers['anthropic-version']).toBe('2024-10-22');

    capture.length = 0;
    await request(app)
      .post('/v1/messages')
      .send({ model: 'deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(capture[0].headers['anthropic-version']).toBe('2023-06-01');
  });

  test('入站带 Bearer（ANTHROPIC_AUTH_TOKEN 路径）→ 上游带同值 Bearer；不带则不造', async () => {
    await request(app)
      .post('/v1/messages')
      .set('authorization', 'Bearer INBOUND-CLAUDE-TOKEN')
      .send({ model: 'deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(capture[0].headers['authorization']).toBe('Bearer sk-test-deepseek');

    capture.length = 0;
    await request(app)
      .post('/v1/messages')
      .send({ model: 'deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(capture[0].headers['authorization']).toBeUndefined();
  });

  test('上游非 2xx → 原样透传状态码（不盖成 500）', async () => {
    global.fetch = jest.fn(async () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const r = await request(app)
      .post('/v1/messages')
      .send({ model: 'deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UPSTREAM_ERROR');
  });

  test('请求体原样透传（system 顶层 / max_tokens / content blocks 不被改写）', async () => {
    const payload = {
      model: 'deepseek-v4-pro',
      max_tokens: 1024,
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'shell', description: 'run', input_schema: { type: 'object' } }],
    };
    const r = await request(app).post('/v1/messages').send(payload);
    expect(r.status).toBe(200);
    const sent = capture[0].body;
    expect(sent.system).toBe('你是助手');
    expect(sent.max_tokens).toBe(1024);
    expect(sent.messages[0].content[0].type).toBe('text');
    // Anthropic 的 input_schema 是它自己的 schema 词汇，直通时**不得**被改成 OpenAI 的 parameters
    expect(sent.tools[0].input_schema).toBeDefined();
    expect(sent.tools[0].parameters).toBeUndefined();
  });
});
