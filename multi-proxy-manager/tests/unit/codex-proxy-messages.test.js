/**
 * codex-proxy /v1/messages 路由回环测试（Anthropic wire）。
 *
 * 目标：锁住「Claude Code 把 ANTHROPIC_BASE_URL 指到 18790」这条路的关键事实：
 *   1. 🔴 上游路径必须按厂商正确构造 —— 2026-10-02 逐个实测发现**没有通用规律**：
 *        DeepSeek  /anthropic/v1/messages   （400 model-not-found）
 *        Kimi      /anthropic/v1/messages   （401；不存在路径是 404）
 *        Agnes     /v1/messages             （401；不存在路径是 403）
 *        Ollama    /v1/messages             （400；/anthropic 是 404）
 *      三级判定：显式 anthropicBaseUrl > 已知前缀型厂商(deepseek/moonshot) > 根路径。
 *   2. 🔴 鉴权必须**换成 provider 自己的 key**，绝不能把入站的 Claude Code token 透上去。
 *   3. anthropic-version 透传；入站缺省则兜 2023-06-01（Anthropic 必填头）。
 *   4. 入站是 Bearer 形态（ANTHROPIC_AUTH_TOKEN）时，上游也带一份同值 Bearer；
 *      入站没有就不带（不要凭空造一个 undefined Bearer）。
 *   5. 🔴 上游无 key（Ollama）时既不发 `x-api-key: undefined`（undici 会抛 Invalid value），
 *      也不把入站 token 顶上去。
 *   6. 上游非 2xx 原样透传状态码（不把真因盖成 500）。
 *
 * 用 supertest(app) + stub global.fetch，不发真实外网请求（不扣费）。
 */

// 必须在 require proxy.js 之前设 —— UPSTREAM_MODELS / DATA_DIR 都是模块加载时求值的常量。
//   ⚠️ HOME 必须指到临时目录：否则 loadProviders() 会读本机真实的
//      ~/.multi-proxy-manager/providers.json；那里若有个也声明了 deepseek-v4-pro 的自定义
//      provider，会**抢占内置 provider**（findProvider 的设计优先级，见 proxy.js:190-198），
//      断言就变成依赖运行环境了 —— 本文件首跑就是这么挂的（拿到的上游 key 是本机真 key，
//      而非 env 里的测试 key）。隔离后：providers.json 只含本测试声明的条目，确定性可控。
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.PROXY_AUTH_TOKEN;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-msg-test-'));
fs.mkdirSync(path.join(tmpHome, '.multi-proxy-manager'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, '.multi-proxy-manager', 'providers.json'), JSON.stringify([
  // 本地无 key 上游（实测形态：根路径 + 无鉴权）
  { id: 'prov_ollama', name: 'Ollama-Local', base_url: 'http://127.0.0.1:11434/v1', api_key: '', models: ['qwen3.8:27b-mlx'], enabled: true },
  // 显式 anthropicBaseUrl：应优先于任何厂商规则
  { id: 'prov_custom', name: 'Custom-Gateway', base_url: 'https://example.invalid/v1', api_key: 'sk-custom',
    models: ['custom-anthropic-model'], enabled: true, anthropicBaseUrl: 'https://example.invalid/special' },
]));
process.env.HOME = tmpHome;
process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
process.env.AGNES_API_KEY = 'sk-test-agnes';

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

const send = (model, extra = {}) => ({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], ...extra });

describe('POST /v1/messages', () => {
  test('不支持的模型 → 400 UNSUPPORTED_MODEL（不碰上游）', async () => {
    const r = await request(app).post('/v1/messages').send(send('totally-unknown-model'));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UNSUPPORTED_MODEL');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('🔴 DeepSeek 走 /anthropic 前缀型：{去/v1}/anthropic/v1/messages', async () => {
    await request(app).post('/v1/messages').send(send('deepseek-v4-pro'));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sent = capture[0];
    expect(sent.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(sent.url).not.toContain('/chat/completions');
    expect(sent.url).not.toContain('/responses');
  });

  test('🔴 Agnes 走根路径型：{base}/messages（实测它不是 /anthropic 前缀）', async () => {
    await request(app).post('/v1/messages').send(send('agnes-2.0-flash'));
    expect(capture[0].url).toBe('https://apihub.agnes-ai.com/v1/messages');
  });

  test('🔴 本地无 key 上游（Ollama）：根路径 + 不发 x-api-key（否则 undici Invalid value）', async () => {
    await request(app).post('/v1/messages').send(send('qwen3.8:27b-mlx'));
    expect(capture[0].url).toBe('http://127.0.0.1:11434/v1/messages');
    expect(capture[0].headers['x-api-key']).toBeUndefined();
    expect(capture[0].headers['authorization']).toBeUndefined();
  });

  test('显式 anthropicBaseUrl 优先于厂商规则', async () => {
    await request(app).post('/v1/messages').send(send('custom-anthropic-model'));
    expect(capture[0].url).toBe('https://example.invalid/special/v1/messages');
  });

  test('🔴 鉴权换成 provider 的 key（入站 token 绝不上游透传）', async () => {
    await request(app).post('/v1/messages').set('x-api-key', 'INBOUND-CLAUDE-TOKEN').send(send('deepseek-v4-pro'));
    const sent = capture[0];
    expect(sent.headers['x-api-key']).toBe('sk-test-deepseek');
    expect(sent.headers['x-api-key']).not.toBe('INBOUND-CLAUDE-TOKEN');
  });

  test('anthropic-version 透传；缺席则兜 2023-06-01', async () => {
    await request(app).post('/v1/messages').set('anthropic-version', '2024-10-22').send(send('deepseek-v4-pro'));
    expect(capture[0].headers['anthropic-version']).toBe('2024-10-22');

    capture.length = 0;
    await request(app).post('/v1/messages').send(send('deepseek-v4-pro'));
    expect(capture[0].headers['anthropic-version']).toBe('2023-06-01');
  });

  test('入站带 Bearer（ANTHROPIC_AUTH_TOKEN 路径）→ 上游带同值 Bearer；不带则不造', async () => {
    await request(app).post('/v1/messages').set('authorization', 'Bearer INBOUND-CLAUDE-TOKEN').send(send('deepseek-v4-pro'));
    expect(capture[0].headers['authorization']).toBe('Bearer sk-test-deepseek');

    capture.length = 0;
    await request(app).post('/v1/messages').send(send('deepseek-v4-pro'));
    expect(capture[0].headers['authorization']).toBeUndefined();
  });

  test('上游非 2xx → 原样透传状态码（不盖成 500）', async () => {
    global.fetch = jest.fn(async () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const r = await request(app).post('/v1/messages').send(send('deepseek-v4-pro'));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UPSTREAM_ERROR');
  });

  test('请求体原样透传（system 顶层 / max_tokens / content blocks 不被改写）', async () => {
    const payload = send('deepseek-v4-pro', {
      max_tokens: 1024,
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'shell', description: 'run', input_schema: { type: 'object' } }],
    });
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
