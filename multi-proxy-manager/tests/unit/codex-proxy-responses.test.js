// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * codex-proxy /v1/responses 路由回环测试。
 *
 * 目标：锁住 2026-10-02 真链路踩出的三个坑（纯函数对了但没接线的同类）：
 *   1. normalizeTools 返回 { body, changed, from } 包装，漏解构 → 上游报
 *      "model name cannot be empty"。必须断言「发给上游的 body.model 还在」。
 *   2. 真实 codex 形态包（namespace / custom / tool_search / web_search）必须被归一化：
 *      namespace 摊平、custom 与 tool_search 剔除（客户端执行能力，压壳=假工具）、
 *      web_search → web_search_preview。
 *   3. agnes 的 /v1/responses 不吃「没有 stream 字段」的包（漏带必 500），
 *      路由须兜底补 stream=false（请求自带 stream 时不覆盖）。
 *
 * 用 supertest(app) + stub global.fetch，不发真实外网请求。
 */

// 必须在 require proxy.js 之前清掉 token，否则 requireAuth 读成模块常量会 401。
delete process.env.PROXY_AUTH_TOKEN;

const request = require('supertest');
const { app } = require('../../../codex-proxy/proxy.js');

const capture = [];

beforeEach(() => {
  capture.length = 0;
  global.fetch = jest.fn(async (url, opts) => {
    capture.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    return new Response(
      JSON.stringify({ ok: true, id: 'stub-up', output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
});

afterEach(() => { jest.restoreAllMocks(); });

describe('POST /v1/responses', () => {
  test('不支持的模型 → 400 UNSUPPORTED_MODEL（不碰上游）', async () => {
    const r = await request(app)
      .post('/v1/responses')
      .send({ model: 'totally-unknown-model', input: 'hi' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UNSUPPORTED_MODEL');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('🔴 model 不丢：归一化包装被解构后，发给上游的 body.model 仍在', async () => {
    await request(app)
      .post('/v1/responses')
      .send({ model: 'agnes-3.0-flash', stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sent = capture[0];
    expect(sent.url).toContain('/responses');
    expect(sent.body.model).toBe('agnes-3.0-flash'); // 这条就是之前漏解构会丢的
  });

  test('真实 codex 形态（namespace/custom/tool_search/web_search）被归一化', async () => {
    const tools = [
      { type: 'function', name: 'shell', parameters: { type: 'object' } },
      { type: 'function', name: 'read', parameters: { type: 'object' } },
      { type: 'namespace', name: 'tasks', tools: [{ type: 'function', name: 'task_create', parameters: { type: 'object' } }] },
      { type: 'web_search' },
      { type: 'custom', name: 'apply_patch', format: { type: 'lark' } },
      { type: 'tool_search', execution: 'client' },
    ];
    await request(app)
      .post('/v1/responses')
      .send({ model: 'agnes-3.0-flash', stream: false, input: 'x', tools });

    const sent = capture[0];
    const types = sent.body.tools.map((t) => t.type);
    // 容器摊平 + 客户端能力剔除 + 映射
    expect(types).not.toContain('namespace');
    expect(types).not.toContain('custom');
    expect(types).not.toContain('tool_search');
    expect(types).toContain('web_search_preview');
    // function 一个不少：原本 2 个顶层 + namespace 里 1 个 = 3
    expect(types.filter((t) => t === 'function')).toHaveLength(3);
    // namespace 的子工具被摊平成顶层 function 且 name 保留
    expect(sent.body.tools.find((t) => t.name === 'task_create')).toBeDefined();
  });

  test('请求自带 stream=true 不被兜底覆盖', async () => {
    await request(app)
      .post('/v1/responses')
      .send({ model: 'agnes-3.0-flash', stream: true, input: 'x' });
    expect(capture[0].body.stream).toBe(true);
  });

  test('请求缺 stream 字段 → 路由兜底补 false（否则 agnes 必 500）', async () => {
    await request(app)
      .post('/v1/responses')
      .send({ model: 'agnes-3.0-flash', input: 'x' }); // 无 stream
    expect(capture[0].body.stream).toBe(false);
  });

  test('上游非 2xx → 原样透传状态码（不把真因盖掉）', async () => {
    global.fetch = jest.fn(async () => new Response(
      JSON.stringify({ error: 'bad model' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const r = await request(app)
      .post('/v1/responses')
      .send({ model: 'agnes-3.0-flash', stream: false, input: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UPSTREAM_ERROR');
  });

  test('无 tools 的纯对话包不炸、照常转发', async () => {
    const r = await request(app)
      .post('/v1/responses')
      .send({ model: 'agnes-3.0-flash', stream: false, input: '只回两个字：收到' });
    expect(r.status).toBe(200);
    expect(capture[0].body.model).toBe('agnes-3.0-flash');
  });
});
