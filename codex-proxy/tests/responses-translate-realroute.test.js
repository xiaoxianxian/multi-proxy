// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).

// 真实路由集成测试：require 真实 proxy.js（app），临时 HOME + 一个开启 responsesTranslate 的
// provider，mock global.fetch，验证 /v1/responses 真的走了翻译分支、把 Responses 翻成
// ChatCompletions 发给上游、再把上游响应翻回 Responses。与 config-leak-gate.test.js 同约定。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const request = require('supertest');

const ORIG_HOME = process.env.HOME;

describe('真实路由：/v1/responses 翻译分支激活', () => {
  let app;
  let fetchMock;
  beforeAll(() => {
    // 临时 HOME → 独立 DATA_DIR，避免污染真实 ~/.multi-proxy-manager
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-tr-'));
    const dataDir = path.join(tmp, '.multi-proxy-manager');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify([
      { provider_id: 'upchat', name: 'UpChat', base_url: 'https://up.test/v1', api_key: 'sk-up', models: ['translate-model'], responsesTranslate: true, responsesTarget: 'chat', enabled: true },
    ]), 'utf8');
    process.env.HOME = tmp;
    delete process.env.PROXY_AUTH_TOKEN; // fail-open

    fetchMock = jest.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ id: 'chatcmpl-r', model: 'translate-model', choices: [{ message: { role: 'assistant', content: 'translated-pong' } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
    }));
    global.fetch = fetchMock;
    // eslint-disable-next-line global-require
    app = require('../proxy.js').app;
  });

  afterAll(() => {
    delete global.fetch;
    process.env.HOME = ORIG_HOME;
    jest.resetModules();
  });

  test('开启翻译的 provider：上游收到 chat 形态，客户端收到 Responses 形态', async () => {
    const res = await request(app).post('/v1/responses').send({ model: 'translate-model', instructions: 'sys', input: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('response');
    expect(res.body.output[0].content[0]).toEqual({ type: 'output_text', text: 'translated-pong', annotations: [] });
    expect(res.body.usage).toEqual({ input_tokens: 4, output_tokens: 2, total_tokens: 6 });
    // 上游确实被翻译成 ChatCompletions 且打到 /chat/completions
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/chat/completions');
    const sent = JSON.parse(opts.body);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('未开启翻译的 provider（原生 responses）：仍走透传（上游收到 /responses）', async () => {
    // 用一个不在 providers.json 里、落到 legacy 分支的模型；legacy 无 responsesTranslate → 透传
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ object: 'response', output: [] }), body: Readable.toWeb(Readable.from([''])) }));
    const res = await request(app).post('/v1/responses').send({ model: 'deepseek-v4-flash', input: 'hi' });
    // legacy provider 走透传；上游 URL 应为 /responses（不翻译）
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/responses');
  });
});
