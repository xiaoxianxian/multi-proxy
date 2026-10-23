// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).

// Messages 协议翻译测试（P9）：Anthropic Messages ⇄ OpenAI ChatCompletions。
// 与 responses-translate-realroute.test.js 同约定：临时 HOME + 独立 DATA_DIR，
// 不污染真实 ~/.multi-proxy-manager。
//
// 分两层：
//   ① 纯函数层（l2/messages-translate.js）—— 不依赖 proxy.js，直接 require 单测；
//   ② 真实路由层 —— require 真实 app，mock global.fetch，验证 /v1/messages 在
//      provider.messagesTranslate 开启时真的走了翻译分支（门控默认关则维持透传）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const request = require('supertest');

const MT = require('../../l2/messages-translate.js');

// 把 SSE 文本里某个事件类型的数据行全部取出来
function sseData(text, type) {
  const out = [];
  for (const raw of text.split('\n\n')) {
    const m = raw.match(/^event: (\S+)\ndata: ([\s\S]+)$/);
    if (m && m[1] === type) { try { out.push(JSON.parse(m[2])); } catch { /* noop */ } }
  }
  return out;
}

describe('L2 纯函数：messagesToChatCompletions（请求方向）', () => {
  test('system 字符串 + 普通对话 → system 消息在前', () => {
    const out = MT.messagesToChatCompletions({
      model: 'm1', max_tokens: 64, system: '你是助手', messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out.max_tokens).toBe(64);
    expect(out.stream).toBe(false);
  });

  test('system 是 content block 数组 → 也抽成一条 system 文本', () => {
    const out = MT.messagesToChatCompletions({ model: 'm1', system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], messages: [] });
    expect(out.messages[0]).toEqual({ role: 'system', content: 'AB' });
  });

  test('assistant 的 tool_use → OpenAI tool_calls（arguments 是 JSON 字符串）', () => {
    const out = MT.messagesToChatCompletions({
      model: 'm1',
      messages: [
        { role: 'user', content: '天气' },
        { role: 'assistant', content: [{ type: 'text', text: '查一下' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'BJ' } }] },
      ],
    });
    const assistant = out.messages[out.messages.length - 1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('查一下');
    expect(assistant.tool_calls).toEqual([{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"BJ"}' } }]);
  });

  test('user 的 tool_result → role=tool + tool_call_id（OpenAI 要求单独成条）', () => {
    const out = MT.messagesToChatCompletions({
      model: 'm1',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 28℃' }] }],
    });
    expect(out.messages[0]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: '晴 28℃' });
  });

  test('Anthropic tools（input_schema）→ OpenAI tools（function.parameters）', () => {
    const out = MT.messagesToChatCompletions({
      model: 'm1',
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      messages: [],
    });
    expect(out.tools).toEqual([{
      type: 'function',
      function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    }]);
  });
});

describe('L2 纯函数：chatCompletionsToMessages（响应方向）', () => {
  test('纯文本响应 → Messages 形态 + stop_reason / usage 映射', () => {
    const out = MT.chatCompletionsToMessages(
      { id: 'chatcmpl-1', model: 'm1', choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
      { model: 'm1' },
    );
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
  });

  test('tool_calls 响应 → tool_use 块 + stop_reason=tool_use', () => {
    const out = MT.chatCompletionsToMessages({
      id: 'chatcmpl-2', model: 'm1',
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', function: { name: 'get_weather', arguments: '{"city":"BJ"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 8 },
    }, { model: 'm1' });
    expect(out.content).toEqual([{ type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: 'BJ' } }]);
    expect(out.stop_reason).toBe('tool_use');
  });

  test('finish_reason=length → max_tokens；空内容不崩', () => {
    const out = MT.chatCompletionsToMessages({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }, { model: 'm1' });
    expect(out.stop_reason).toBe('max_tokens');
    expect(out.content).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('L2 纯函数：MessagesStreamEmitter（流式）', () => {
  test('文本流：message_start → content_block_start → delta → stop → message_delta → message_stop', () => {
    const em = new MT.MessagesStreamEmitter({ model: 'm1' });
    let s = em.pushText('Hel') + em.pushText('lo');
    s += em.end({ prompt_tokens: 5, completion_tokens: 2 }, 'stop');
    expect(sseData(s, 'message_start')).toHaveLength(1);
    expect(sseData(s, 'content_block_start')[0].content_block).toEqual({ type: 'text', text: '' });
    const deltas = sseData(s, 'content_block_delta');
    expect(deltas.map((d) => d.delta.text)).toEqual(['Hel', 'lo']);
    expect(sseData(s, 'message_delta')[0].delta.stop_reason).toBe('end_turn');
    expect(sseData(s, 'message_delta')[0].usage).toEqual({ output_tokens: 2 });
    expect(sseData(s, 'message_stop')).toHaveLength(1);
  });

  test('工具调用流：工具块开在文本块之后（index 1），input_json_delta 可拼回完整 JSON', () => {
    const em = new MT.MessagesStreamEmitter({ model: 'm1' });
    let s = em.pushText('查一下');
    s += em.pushTool(0, { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } });
    s += em.pushTool(0, { index: 0, function: { arguments: '"BJ"}' } });
    s += em.end({ prompt_tokens: 10, completion_tokens: 8 }, 'tool_calls');

    const starts = sseData(s, 'content_block_start');
    expect(starts[0].content_block.type).toBe('text');
    expect(starts[1]).toMatchObject({ index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather' } });

    const json = sseData(s, 'content_block_delta')
      .filter((d) => d.delta.type === 'input_json_delta')
      .map((d) => d.delta.partial_json)
      .join('');
    expect(json).toBe('{"city":"BJ"}');
    expect(JSON.parse(json)).toEqual({ city: 'BJ' });
    expect(sseData(s, 'message_delta')[0].delta.stop_reason).toBe('tool_use');
  });

  test('空流也不崩（无 delta 直接 end）', () => {
    const em = new MT.MessagesStreamEmitter({ model: 'm1' });
    const s = em.end(null, null);
    expect(sseData(s, 'message_start')).toHaveLength(1);
    expect(sseData(s, 'message_stop')).toHaveLength(1);
  });
});

describe('真实路由：/v1/messages 走 Messages 翻译分支', () => {
  const ORIG_HOME = process.env.HOME;
  let app;
  let fetchMock;

  beforeAll(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-mt-'));
    const dataDir = path.join(tmp, '.multi-proxy-manager');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify([
      { provider_id: 'kiloanon', name: 'KiloAnon', base_url: 'https://api.kilo.ai/api/gateway', api_key: '', models: ['free-model'], messagesTranslate: true, enabled: true },
      { provider_id: 'native', name: 'Native', base_url: 'https://native.test', api_key: 'sk-n', models: ['native-model'], enabled: true },
    ]), 'utf8');
    process.env.HOME = tmp;
    delete process.env.PROXY_AUTH_TOKEN; // fail-open

    fetchMock = jest.fn();
    global.fetch = fetchMock;
    // eslint-disable-next-line global-require
    app = require('../proxy.js').app;
  });

  afterAll(() => {
    delete global.fetch;
    process.env.HOME = ORIG_HOME;
    jest.resetModules();
  });

  test('非流式：上游收到 chat 形态且打到 /chat/completions，客户端收到 Messages 形态', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ id: 'chatcmpl-x', model: 'free-model', choices: [{ message: { role: 'assistant', content: 'free-pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    }));
    const res = await request(app).post('/v1/messages')
      .send({ model: 'free-model', max_tokens: 64, system: 'sys', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('message');
    expect(res.body.content).toEqual([{ type: 'text', text: 'free-pong' }]);
    expect(res.body.stop_reason).toBe('end_turn');
    expect(res.body.usage).toEqual({ input_tokens: 7, output_tokens: 3 });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.kilo.ai/api/gateway/chat/completions');
    const sent = JSON.parse(opts.body);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(sent.max_tokens).toBe(64);
  });

  test('匿名池无 key：绝不带 Authorization 头（空 api_key 不发出 Bearer undefined）', async () => {
    fetchMock.mockClear();
    const res = await request(app).post('/v1/messages')
      .send({ model: 'free-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    // 末端还有一笔用量上报的 fetch，故按 URL 精确定位上游那一次
    const [, opts] = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'));
    expect(opts.headers.Authorization).toBeUndefined();
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  test('工具调用请求：上游收到 OpenAI tools，响应翻回 tool_use 块', async () => {
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({
        id: 'chatcmpl-t', model: 'free-model',
        choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_t', function: { name: 'get_weather', arguments: '{"city":"BJ"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 12, completion_tokens: 9 },
      }),
    }));
    const res = await request(app).post('/v1/messages').send({
      model: 'free-model', max_tokens: 128,
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      messages: [{ role: 'user', content: '北京天气' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.content).toEqual([{ type: 'tool_use', id: 'call_t', name: 'get_weather', input: { city: 'BJ' } }]);
    expect(res.body.stop_reason).toBe('tool_use');

    const [, opts] = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'));
    const sent = JSON.parse(opts.body);
    expect(sent.tools[0].function.name).toBe('get_weather');
    expect(sent.tools[0].function.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
  });

  test('流式：上游 SSE → 客户端收到 Anthropic Messages SSE 事件序列', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":2,"total_tokens":8}}',
      'data: [DONE]',
    ].join('\n') + '\n';
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200, body: Readable.toWeb(Readable.from([sse])),
    }));
    const res = await request(app).post('/v1/messages')
      .send({ model: 'free-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const text = typeof res.text === 'string' ? res.text : (res.body || '').toString();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    // SSE 是分块投递的，文本增量各自成事件，不会拼成连续串
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('"text":"lo"');
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('event: message_stop');
    expect(sseData(text, 'message_delta')[0].usage).toEqual({ output_tokens: 2 });
  });

  test('门控默认关（native provider 无 messagesTranslate）：仍走原透传（上游收到 /v1/messages）', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ id: 'msg_n', type: 'message', content: [{ type: 'text', text: 'native' }], usage: { input_tokens: 1, output_tokens: 1 } }),
    }));
    const res = await request(app).post('/v1/messages')
      .send({ model: 'native-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls.find((c) => String(c[0]).includes('/messages'));
    expect(url).toBe('https://native.test/messages');
    expect(url).not.toContain('/chat/completions');
  });
});
