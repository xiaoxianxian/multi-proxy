// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).

// 路由级集成测试（mirror 模式，与 integration.test.js 同约定）：
// 用真实的 l2/responses-translate.js，mock global.fetch 模拟上游，
// 验证「Responses → ChatCompletions/Messages 翻译 → 翻回 Responses」整条链路（含流式）。

const express = require('express');
const request = require('supertest');
const RT = require('../../l2/responses-translate.js');

// 复刻 proxy.js /v1/responses 的翻译分支逻辑（不含鉴权/策略，聚焦翻译接线）
function buildApp(upstreamHandler) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  // 一个开启翻译的 provider（chat 目标）
  const providerChat = { name: 'UpChat', baseUrl: 'https://up.test/v1', apiKey: 'sk-up', responsesTranslate: true, responsesTarget: 'chat' };
  const providerMsg = { name: 'UpMsg', baseUrl: 'https://up.test/v1', apiKey: 'sk-up', responsesTranslate: true, responsesTarget: 'messages' };
  const findProvider = (m) => (m.includes('chat') ? providerChat : providerMsg);

  app.post('/v1/responses', async (req, res) => {
    const { model } = req.body;
    const provider = findProvider(model);
    // —— 以下与 proxy.js handleTranslatedResponses 同逻辑 ——
    const target = provider.responsesTarget === 'messages' ? 'messages' : 'chat';
    const translated = target === 'messages' ? RT.responsesToMessages(req.body) : RT.responsesToChatCompletions(req.body);
    translated.stream = !!req.body.stream;
    const upstreamUrl = target === 'messages' ? 'https://up.test/v1/messages' : `${provider.baseUrl}/chat/completions`;
    const headers = target === 'messages'
      ? { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': provider.apiKey }
      : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` };
    const response = await fetch(upstreamUrl, { method: 'POST', headers, body: JSON.stringify(translated) });
    if (!response.ok) return res.status(response.status).json({ error: 'upstream' });
    if (!translated.stream) {
      const upstreamJson = await response.json();
      const resp = target === 'messages' ? RT.messagesToResponses(upstreamJson, req.body) : RT.chatCompletionsToResponses(upstreamJson, req.body);
      return res.json(resp);
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emitter = new RT.ResponsesStreamEmitter(req.body);
    const nodeStream = require('stream').Readable.fromWeb(response.body);
    let buf = '';
    const flush = (data) => {
      if (data === '[DONE]') return;
      let obj; try { obj = JSON.parse(data); } catch { return; }
      if (target === 'messages') return;
      const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
      if (d && d.content) { const s = emitter.pushText(d.content); if (s) res.write(s); }
      if (d && Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) { const s = emitter.pushTool(tc.index, tc); if (s) res.write(s); }
      if (obj.usage) upstreamHandler._lastUsage = obj.usage;
    };
    for await (const chunk of nodeStream) {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const t = l.trim(); if (t.startsWith('data:')) flush(t.slice(5).trim()); }
    }
    const s = emitter.end(upstreamHandler._lastUsage); if (s) res.write(s);
    res.end();
  });
  return app;
}

// 构造一个上游 ChatCompletions 非流式响应
function chatUpstreamJson() {
  return { id: 'chatcmpl-x', model: 'up', choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
}
function chatUpstreamStream() {
  const lines = [
    'data: {"choices":[{"delta":{"content":"p"}}]}',
    'data: {"choices":[{"delta":{"content":"ong"}}]}',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
    'data: [DONE]',
  ];
  return lines.join('\n') + '\n';
}

describe('route: Responses → ChatCompletions 翻译（非流式）', () => {
  let upstreamHandler;
  beforeAll(() => {
    upstreamHandler = { _lastUsage: null };
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => chatUpstreamJson() }));
  });
  afterAll(() => { delete global.fetch; });

  test('上游收到 ChatCompletions 形态，客户端收到 Responses 形态', async () => {
    const app = buildApp(upstreamHandler);
    const res = await request(app).post('/v1/responses').send({
      model: 'chat-model', instructions: 'sys', input: 'hi',
    });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('response');
    expect(res.body.output[0].content[0]).toEqual({ type: 'output_text', text: 'pong', annotations: [] });
    expect(res.body.usage).toEqual({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
    // 上游拿到的是 chat 形态，不是 responses 形态
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(global.fetch.mock.calls[0][0]).toContain('/chat/completions');
  });
});

describe('route: Responses → ChatCompletions 翻译（流式）', () => {
  beforeAll(() => {
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      body: require('stream').Readable.toWeb(require('stream').Readable.from([chatUpstreamStream()])),
    }));
  });
  afterAll(() => { delete global.fetch; });

  test('上游 SSE 被翻成 Responses SSE，文本聚合完整', async () => {
    const upstreamHandler = { _lastUsage: null };
    const app = buildApp(upstreamHandler);
    const res = await request(app).post('/v1/responses').send({ model: 'chat-model', input: 'hi', stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = [];
    for (const block of res.text.split('\n\n')) {
      const m = block.match(/event: ([\w.]+)/); if (m) events.push(m[1]);
    }
    expect(events).toContain('response.created');
    expect(events).toContain('response.completed');
    const completed = res.text.split('\n\n').map((b) => { const d = b.match(/data: (.*)/s); return d ? JSON.parse(d[1]) : null; }).find((e) => e && e.type === 'response.completed');
    const text = completed.response.output[0].content.find((c) => c.type === 'output_text');
    expect(text.text).toBe('pong');
  });
});
