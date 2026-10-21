#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// responses-translate · OpenAI Responses API（/v1/responses）与 ChatCompletions / Anthropic Messages 的双向互译
//
// 背景：codex 客户端（Codex CLI / OpenAI SDK 新版本）默认走 /v1/responses。
//   很多上游（绝大多数 OpenAI 兼容网关、以及只提供 Anthropic 兼容面的上游）并不原生
//   支持 /v1/responses —— 直接透传会得到上游 404。本模块让 codex-proxy 在
//   provider.responsesTranslate 开启时，把 Responses 请求翻译成上游真支持的协议
//   （chat / messages），再把上游响应翻回 Responses 格式。
//
// 设计约束：
//   - 纯函数 + 无运行时依赖，jest 可直接 require，不依赖 proxy.js 的任何热路径符号。
//   - 只覆盖「文本 + 工具调用 + 流式」这一最常见、最必要的子集；图片 / file_search /
//     previous_response_id 连续对话等留到后续版本（input 里直接忽略，不会崩）。
//   - 字段映射对照 OpenAI Responses API 文档 schema（与 magpie 同层做法对齐）。

let _idc = 0;
function uid(prefix) {
  _idc += 1;
  return `${prefix || 'id'}_${Date.now().toString(36)}_${_idc}`;
}

function safeParse(str, fallback) {
  if (str == null) return fallback;
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

// input 可能是字符串或 item 数组；统一成数组
function normalizeInput(input) {
  if (input == null) return [];
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }];
  if (Array.isArray(input)) return input;
  return [input];
}

// 把 Responses 的 messages/tools 通用参数映射到目标协议
function mapCommonParams(src, dst, target) {
  if (src.temperature != null) dst.temperature = src.temperature;
  if (src.top_p != null) dst.top_p = src.top_p;
  if (src.max_output_tokens != null) {
    if (target === 'messages') dst.max_tokens = src.max_output_tokens; // Anthropic 必填
    else dst.max_tokens = src.max_output_tokens;
  }
  if (src.top_logprobs != null) dst.top_logprobs = src.top_logprobs;
  return dst;
}

// ============ 请求：Responses → ChatCompletions ============
function responsesToChatCompletions(body = {}) {
  const out = { model: body.model };
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });

  for (const it of normalizeInput(body.input)) {
    if (it.type === 'message') {
      if (Array.isArray(it.content)) {
        let text = '';
        const toolCalls = [];
        const toolResults = [];
        for (const part of it.content) {
          if (part.type === 'input_text' || part.type === 'output_text') text += part.text || '';
          else if (part.type === 'tool_call') toolCalls.push(part);
          else if (part.type === 'tool_call_output') toolResults.push(part);
        }
        if (it.role === 'user' && toolResults.length) {
          for (const tr of toolResults) messages.push({ role: 'tool', tool_call_id: tr.call_id, content: tr.output });
        } else {
          const msg = { role: it.role, content: text };
          if (toolCalls.length) {
            msg.tool_calls = toolCalls.map((tc) => ({
              id: tc.call_id || uid('call'),
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments || '' },
            }));
          }
          messages.push(msg);
        }
      } else {
        messages.push({ role: it.role, content: it.content });
      }
    } else if (it.type === 'function_call') {
      messages.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: it.call_id || uid('call'), type: 'function', function: { name: it.name, arguments: it.arguments || '' } }],
      });
    } else if (it.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: it.output });
    }
    // reasoning / 其它类型 → 忽略（不影响翻译）
  }

  out.messages = messages;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) => (t.type === 'function' ? t : { type: 'function', function: t }));
  }
  mapCommonParams(body, out, 'chat');
  out.stream = !!body.stream;
  return out;
}

// ============ 请求：Responses → Anthropic Messages ============
function responsesToMessages(body = {}) {
  const out = { model: body.model };
  if (body.instructions) out.system = body.instructions;

  const messages = [];
  for (const it of normalizeInput(body.input)) {
    if (it.type === 'message') {
      if (Array.isArray(it.content)) {
        const content = [];
        for (const part of it.content) {
          if (part.type === 'input_text' || part.type === 'output_text') content.push({ type: 'text', text: part.text || '' });
          else if (part.type === 'tool_call') content.push({ type: 'tool_use', id: part.call_id || uid('call'), name: part.name, input: safeParse(part.arguments, {}) });
          else if (part.type === 'tool_call_output') content.push({ type: 'tool_result', tool_use_id: part.call_id, content: part.output });
        }
        messages.push({ role: it.role, content });
      } else {
        messages.push({ role: it.role, content: it.content });
      }
    } else if (it.type === 'function_call') {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: it.call_id || uid('call'), name: it.name, input: safeParse(it.arguments, {}) }] });
    } else if (it.type === 'function_call_output') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: it.call_id, content: it.output }] });
    }
  }

  out.messages = messages;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) => {
      const fn = t.type === 'function' ? t : t.function || t;
      return { name: fn.name, description: fn.description || '', input_schema: fn.parameters || {} };
    });
  }
  mapCommonParams(body, out, 'messages');
  // Anthropic 要求 max_tokens 必填；上游没给就给一个保守默认
  if (out.max_tokens == null) out.max_tokens = 4096;
  out.stream = !!body.stream;
  return out;
}

// ============ 通用：把 usage + output 组装成 Responses 顶层对象 ============
function buildResponsesObject(resp = {}, reqBody = {}, output) {
  const usage = resp.usage || {};
  return {
    id: resp.id || uid('resp'),
    object: 'response',
    created_at: resp.created != null ? resp.created : Math.floor(Date.now() / 1000),
    model: reqBody.model || resp.model,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: reqBody.instructions || null,
    tools: reqBody.tools || [],
    parallel_tool_calls: false,
    output,
    usage: {
      input_tokens: usage.prompt_tokens != null ? usage.prompt_tokens : (usage.input_tokens || 0),
      output_tokens: usage.completion_tokens != null ? usage.completion_tokens : (usage.output_tokens || 0),
      total_tokens: usage.total_tokens || 0,
    },
  };
}

function buildMessageItem(content) {
  return {
    id: uid('item'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content,
  };
}

// ============ 响应：ChatCompletions → Responses（非流式）============
function chatCompletionsToResponses(resp = {}, reqBody = {}) {
  const choice = (resp.choices && resp.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'output_text', text: msg.content, annotations: [] });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      content.push({ type: 'tool_call', call_id: tc.id || uid('call'), name: tc.function && tc.function.name, arguments: (tc.function && tc.function.arguments) || '' });
    }
  }
  const output = [buildMessageItem(content)];
  return buildResponsesObject(resp, reqBody, output);
}

// ============ 响应：Anthropic Messages → Responses（非流式）============
function messagesToResponses(resp = {}, reqBody = {}) {
  const usage = resp.usage || {};
  const content = [];
  const blocks = Array.isArray(resp.content) ? resp.content : [];
  for (const b of blocks) {
    if (b.type === 'text') content.push({ type: 'output_text', text: b.text, annotations: [] });
    else if (b.type === 'tool_use') content.push({ type: 'tool_call', call_id: b.id || uid('call'), name: b.name, arguments: JSON.stringify(b.input != null ? b.input : {}) });
  }
  const output = [buildMessageItem(content)];
  const wrapped = { id: resp.id, model: resp.model, created: typeof resp.created_at === 'number' ? resp.created_at : undefined, usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.input_tokens + usage.output_tokens || 0 } };
  return buildResponsesObject(wrapped, reqBody, output);
}

// ============ 流式：通用 Responses 事件发射器 ============
// 两条上游流（ChatCompletions SSE / Anthropic SSE）都喂进同一个发射器，
// 由它产出 OpenAI Responses 的 SSE 事件序列。
class ResponsesStreamEmitter {
  constructor(reqBody = {}) {
    this.seq = 0;
    this.itemId = uid('item');
    this.reqBody = reqBody || {};
    this.started = false;
    this.accText = '';
    this.toolAcc = new Map(); // index -> { call_id, name, args }
    this.usage = null;
    this.respId = uid('resp');
  }

  _ev(type, data) {
    this.seq += 1;
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq, ...data })}\n\n`;
  }

  _item(content) {
    return { id: this.itemId, type: 'message', status: 'completed', role: 'assistant', content };
  }

  _begin() {
    const init = {
      id: this.respId, object: 'response', created_at: Math.floor(Date.now() / 1000),
      model: this.reqBody.model, status: 'in_progress', error: null, incomplete_details: null,
      instructions: this.reqBody.instructions || null, tools: this.reqBody.tools || [], parallel_tool_calls: false,
      output: [],
    };
    let s = this._ev('response.created', { response: init });
    s += this._ev('response.in_progress', { response: init });
    s += this._ev('response.output_item.added', { output_index: 0, item: this._item([]) });
    s += this._ev('response.content_part.added', { item_id: this.itemId, output_index: 0, content_index: 0, part: { type: 'text', text: '' } });
    this.started = true;
    return s;
  }

  // 喂一段文本增量
  pushText(delta) {
    let s = '';
    if (!this.started) s += this._begin();
    if (delta) {
      this.accText += delta;
      s += this._ev('response.output_text.delta', { item_id: this.itemId, output_index: 0, content_index: 0, delta });
    }
    return s;
  }

  // 喂一个工具调用增量（index 用于聚合多个并行 tool_call）
  pushTool(index, tc) {
    let s = '';
    if (!this.started) s += this._begin();
    if (!this.toolAcc.has(index)) this.toolAcc.set(index, { call_id: tc.id || uid('call'), name: (tc.function && tc.function.name) || '', args: '' });
    const t = this.toolAcc.get(index);
    if (tc.id) t.call_id = tc.id;
    if (tc.function && tc.function.name) t.name = tc.function.name;
    if (tc.function && tc.function.arguments) {
      t.args += tc.function.arguments;
      s += this._ev('response.function_call_arguments.delta', { item_id: this.itemId, output_index: 0, name: t.name, call_id: t.call_id, delta: tc.function.arguments });
    }
    return s;
  }

  // 结束：产出 done 事件 + completed（带 usage）
  end(usage) {
    let s = '';
    if (!this.started) s += this._begin();
    if (usage) this.usage = usage;
    s += this._ev('response.output_text.done', { item_id: this.itemId, output_index: 0, content_index: 0, text: this.accText });
    s += this._ev('response.content_part.done', { item_id: this.itemId, output_index: 0, content_index: 0, part: { type: 'text', text: this.accText } });
    const content = [{ type: 'output_text', text: this.accText, annotations: [] }];
    for (const t of this.toolAcc.values()) content.push({ type: 'tool_call', call_id: t.call_id, name: t.name, arguments: t.args });
    const item = this._item(content);
    s += this._ev('response.output_item.done', { output_index: 0, item });
    const u = this.usage || {};
    const finalResp = {
      id: this.respId, object: 'response', created_at: Math.floor(Date.now() / 1000),
      model: this.reqBody.model, status: 'completed', error: null, incomplete_details: null,
      instructions: this.reqBody.instructions || null, tools: this.reqBody.tools || [], parallel_tool_calls: false,
      output: [item],
      usage: {
        input_tokens: u.prompt_tokens != null ? u.prompt_tokens : (u.input_tokens || 0),
        output_tokens: u.completion_tokens != null ? u.completion_tokens : (u.output_tokens || 0),
        total_tokens: u.total_tokens || 0,
      },
    };
    s += this._ev('response.completed', { response: finalResp });
    return s;
  }
}

// 把 ChatCompletions SSE 文本切成 data 行并解析（供 route 调用）
function parseSseLines(text) {
  const lines = [];
  let buf = text;
  // 逐行切分，保留未完成的行在调用方缓冲
  const parts = buf.split('\n');
  for (const line of parts) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) lines.push(trimmed.slice(5).trim());
  }
  return lines;
}

module.exports = {
  uid,
  safeParse,
  normalizeInput,
  responsesToChatCompletions,
  responsesToMessages,
  chatCompletionsToResponses,
  messagesToResponses,
  ResponsesStreamEmitter,
  buildResponsesObject,
  parseSseLines,
};
