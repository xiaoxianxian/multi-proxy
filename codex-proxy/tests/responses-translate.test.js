// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).

// 纯函数单测：l2/responses-translate.js
// 覆盖 Responses ⇄ ChatCompletions / Messages 的请求与响应（含流式）双向翻译。

const RT = require('../../l2/responses-translate.js');

function parseSSE(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    let evType, data;
    for (const l of lines) {
      if (l.startsWith('event:')) evType = l.slice(6).trim();
      else if (l.startsWith('data:')) data = l.slice(5).trim();
    }
    if (evType && data) events.push({ type: evType, ...JSON.parse(data) });
  }
  return events;
}

describe('responsesToChatCompletions', () => {
  test('字符串 input → 单条 user 消息', () => {
    const out = RT.responsesToChatCompletions({ model: 'm', input: 'hi' });
    expect(out.model).toBe('m');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('instructions → system 消息且置顶', () => {
    const out = RT.responsesToChatCompletions({ model: 'm', instructions: 'sys', input: [{ type: 'message', role: 'user', content: 'hi' }] });
    expect(out.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('content 数组（input_text）→ 文本拼接', () => {
    const out = RT.responsesToChatCompletions({
      model: 'm',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }],
    });
    expect(out.messages[0].content).toBe('ab');
  });

  test('tool_call(新) + tool_call_output → assistant tool_calls + tool 消息', () => {
    const out = RT.responsesToChatCompletions({
      model: 'm',
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'tool_call', call_id: 'c1', name: 'f', arguments: '{"x":1}' }] },
        { type: 'message', role: 'user', content: [{ type: 'tool_call_output', call_id: 'c1', output: '42' }] },
      ],
    });
    const asst = out.messages.find((m) => m.role === 'assistant');
    const tool = out.messages.find((m) => m.role === 'tool');
    expect(asst.tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } });
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: '42' });
  });

  test('function_call(旧) → assistant tool_calls', () => {
    const out = RT.responsesToChatCompletions({
      model: 'm',
      input: [{ type: 'function_call', call_id: 'c2', name: 'g', arguments: '{}' }],
    });
    expect(out.messages[0].tool_calls[0].function.name).toBe('g');
    expect(out.messages[0].content).toBeNull();
  });

  test('tools 映射（function 类型透传）+ 通用参数映射', () => {
    const out = RT.responsesToChatCompletions({
      model: 'm', input: 'hi',
      tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
      temperature: 0.3, top_p: 0.9, max_output_tokens: 500, stream: true,
    });
    expect(out.tools[0]).toEqual({ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } });
    expect(out.temperature).toBe(0.3);
    expect(out.top_p).toBe(0.9);
    expect(out.max_tokens).toBe(500);
    expect(out.stream).toBe(true);
  });

  test('reasoning 等未知类型被忽略，不崩', () => {
    const out = RT.responsesToChatCompletions({
      model: 'm',
      input: [{ type: 'reasoning', summary: '...' }, { type: 'message', role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('responsesToMessages', () => {
  test('instructions → 顶层 system；其余带进 messages', () => {
    const out = RT.responsesToMessages({ model: 'm', instructions: 'sys', input: [{ type: 'message', role: 'user', content: 'hi' }] });
    expect(out.system).toBe('sys');
    expect(out.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  test('tool_use / tool_result 内容块映射', () => {
    const out = RT.responsesToMessages({
      model: 'm',
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'tool_call', call_id: 'u1', name: 'f', arguments: '{"a":1}' }] },
        { type: 'message', role: 'user', content: [{ type: 'tool_call_output', call_id: 'u1', output: 'ok' }] },
      ],
    });
    expect(out.messages[0].content[0]).toMatchObject({ type: 'tool_use', id: 'u1', name: 'f' });
    expect(out.messages[1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'u1', content: 'ok' });
  });

  test('tools → Anthropic input_schema', () => {
    const out = RT.responsesToMessages({
      model: 'm', input: 'hi',
      tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }],
    });
    expect(out.tools[0]).toEqual({ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } });
  });

  test('max_tokens 缺失时给保守默认（Anthropic 必填）', () => {
    const out = RT.responsesToMessages({ model: 'm', input: 'hi' });
    expect(out.max_tokens).toBe(4096);
  });
});

describe('chatCompletionsToResponses', () => {
  test('文本 + usage 映射为 Responses 顶层对象', () => {
    const out = RT.chatCompletionsToResponses(
      { id: 'chatcmpl-1', model: 'm', choices: [{ message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      { model: 'm' },
    );
    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.output[0].type).toBe('message');
    expect(out.output[0].content[0]).toEqual({ type: 'output_text', text: 'hello', annotations: [] });
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  test('tool_calls → content 里的 tool_call 项', () => {
    const out = RT.chatCompletionsToResponses(
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] } }], usage: {} },
      { model: 'm' },
    );
    const tool = out.output[0].content.find((c) => c.type === 'tool_call');
    expect(tool).toMatchObject({ call_id: 'c1', name: 'f', arguments: '{}' });
  });
});

describe('messagesToResponses', () => {
  test('text 块 + tool_use 块 + usage 映射', () => {
    const out = RT.messagesToResponses(
      { id: 'msg-1', model: 'm', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'u1', name: 'f', input: { a: 1 } }], usage: { input_tokens: 7, output_tokens: 3 } },
      { model: 'm' },
    );
    const textItem = out.output[0].content.find((c) => c.type === 'output_text');
    const toolItem = out.output[0].content.find((c) => c.type === 'tool_call');
    expect(textItem.text).toBe('hi');
    expect(toolItem).toMatchObject({ call_id: 'u1', name: 'f', arguments: JSON.stringify({ a: 1 }) });
    expect(out.usage).toEqual({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
  });
});

describe('ResponsesStreamEmitter（流式）', () => {
  test('文本增量 → 完整 SSE 事件序列', () => {
    const em = new RT.ResponsesStreamEmitter({ model: 'm' });
    let s = em.pushText('He'); s += em.pushText('llo'); s += em.end({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
    const evs = parseSSE(s).map((e) => e.type);
    expect(evs).toEqual([
      'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
      'response.output_text.delta', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed',
    ]);
    const completed = parseSSE(s).find((e) => e.type === 'response.completed');
    expect(completed.response.output[0].content[0]).toMatchObject({ type: 'output_text', text: 'Hello' });
    expect(completed.response.usage).toEqual({ input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  });

  test('工具调用增量 → function_call_arguments.delta 且最终 arguments 聚合完整', () => {
    const em = new RT.ResponsesStreamEmitter({ model: 'm' });
    let s = '';
    s += em.pushTool(0, { id: 'c1', function: { name: 'f' } });
    s += em.pushTool(0, { function: { arguments: '{"a":' } });
    s += em.pushTool(0, { function: { arguments: '1}' } });
    s += em.end();
    const evs = parseSSE(s);
    expect(evs.some((e) => e.type === 'response.function_call_arguments.delta')).toBe(true);
    const completed = evs.find((e) => e.type === 'response.completed');
    const tool = completed.response.output[0].content.find((c) => c.type === 'tool_call');
    expect(tool.call_id).toBe('c1');
    expect(tool.name).toBe('f');
    expect(tool.arguments).toBe('{"a":1}');
  });
});
