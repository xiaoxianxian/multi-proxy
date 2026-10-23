#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// messages-translate · Anthropic Messages API（/v1/messages）与 OpenAI ChatCompletions 双向互译
//
// 背景：Claude Code 只说 Anthropic Messages 协议（POST /v1/messages）。免费模型池
//   （Kilo 匿名池等）只提供 OpenAI 兼容的 /v1/chat/completions —— 把 Messages 请求
//   直接透传过去，上游必返 404。本模块让 claude-proxy 在 provider.messagesTranslate
//   开启时，把 Messages 请求翻成 ChatCompletions 发给上游，再把上游响应（含流式 SSE）
//   翻回 Messages 格式，于是 Claude Code 无需 Claude key 也能用免费模型。
//
// 设计约束（与 l2/responses-translate.js 同层同纪律）：
//   - 纯函数 + 无运行时依赖，jest 可直接 require，不依赖 proxy.js 的任何热路径符号。
//   - 只覆盖「文本 + 工具调用 + 流式」这一最常见、最必要的子集；thinking / 图片等
//     非文本块按类型跳过，不崩。
//   - 与 responses-translate 共用调用方的 SSE 逐行解析，本模块不重复实现解析器。
//
// 实测（2026-10-23，Kilo 匿名池 kilo-auto/free，真请求非 mock）：
//   - 非流式、流式、工具调用三条链路全部跑通；工具调用真回了
//     {"type":"tool_use","name":"get_weather","input":{"city":"北京"}}。
//   - 上游若是 reasoning 模型，thinking 内容在 message.reasoning 字段——本层只取
//     content，不伪造 Anthropic thinking 块（signature 无法伪造，造了反而是假账）。
//     副作用：max_tokens 给太小时额度会被思考吃光，content 变空。故免费 reasoning
//     模型务必给足 max_tokens（实测 48 → 空，1024 → 正常）。

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

// 取 content blocks 里的纯文本（非文本块忽略）
function textOnly(blocks) {
  if (!Array.isArray(blocks)) return '';
  let s = '';
  for (const b of blocks) if (b && b.type === 'text' && b.text) s += b.text;
  return s;
}

// OpenAI finish_reason → Anthropic stop_reason
const STOP_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
};

// ============ 请求：Anthropic Messages → ChatCompletions ============
function messagesToChatCompletions(body = {}) {
  const out = { model: body.model, messages: [] };

  // system 可能是字符串，也可能是 content block 数组
  if (body.system != null) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? textOnly(body.system) : '');
    if (sysText) out.messages.push({ role: 'system', content: sysText });
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      out.messages.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    // role=user 的 tool_result：OpenAI 要求单独成条（role=tool + tool_call_id）
    if (role === 'user' && m.content.some((b) => b && b.type === 'tool_result')) {
      for (const tr of m.content) {
        if (!tr || tr.type !== 'tool_result') continue;
        const c = typeof tr.content === 'string'
          ? tr.content
          : (Array.isArray(tr.content) ? textOnly(tr.content) : String(tr.content == null ? '' : tr.content));
        out.messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: c });
      }
      continue;
    }

    // role=assistant 的 tool_use：转成 OpenAI 的 tool_calls
    if (role === 'assistant' && m.content.some((b) => b && b.type === 'tool_use')) {
      const text = textOnly(m.content);
      out.messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: m.content
          .filter((b) => b && b.type === 'tool_use')
          .map((tu) => ({
            id: tu.id || uid('call'),
            type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input != null ? tu.input : {}) },
          })),
      });
      continue;
    }

    out.messages.push({ role, content: textOnly(m.content) });
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        // Anthropic 的 input_schema 就是 OpenAI 的 parameters，直接搬
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  out.stream = !!body.stream;
  return out;
}

// ============ 响应：ChatCompletions → Anthropic Messages（非流式）============
function chatCompletionsToMessages(resp = {}, reqBody = {}) {
  const choice = (resp.choices && resp.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id || uid('toolu'),
        name: (tc.function && tc.function.name) || '',
        input: safeParse(tc.function && tc.function.arguments, {}),
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const u = resp.usage || {};
  return {
    id: resp.id || uid('msg'),
    type: 'message',
    role: 'assistant',
    model: reqBody.model || resp.model,
    content,
    stop_reason: STOP_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
  };
}

// ============ 流式：ChatCompletions SSE → Anthropic Messages SSE ============
// 文本块固定占 index 0，工具块从 1 起依次递增（Anthropic 要求 index 连续唯一）。
class MessagesStreamEmitter {
  constructor(reqBody = {}) {
    this.model = (reqBody && reqBody.model) || '';
    this.id = uid('msg');
    this.started = false;
    this.accText = '';
    this.textOpen = false;
    this.nextIndex = 1;
    this.toolAcc = new Map(); // OpenAI index -> { id, name, blockIndex, args }
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  _ev(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }

  _begin() {
    const s = this._ev('message_start', {
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 1 },
      },
    }) + this._ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    this.textOpen = true;
    this.started = true;
    return s;
  }

  // 喂一段文本增量
  pushText(delta) {
    let s = '';
    if (!this.started) s += this._begin();
    if (delta) {
      this.accText += delta;
      s += this._ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: delta } });
    }
    return s;
  }

  // 喂一个工具调用增量（index 用于聚合并行 tool_call 的分片）
  pushTool(index, tc) {
    let s = '';
    if (!this.started) s += this._begin();
    const key = Number.isInteger(index) ? index : 0;

    if (!this.toolAcc.has(key)) {
      // 工具块必须开在文本块之后：先收掉文本块
      if (this.textOpen) { s += this._ev('content_block_stop', { index: 0 }); this.textOpen = false; }
      const id = (tc && tc.id) || uid('toolu');
      const name = (tc && tc.function && tc.function.name) || '';
      const blockIndex = this.nextIndex;
      this.nextIndex += 1;
      this.toolAcc.set(key, { id, name, args: '', blockIndex });
      s += this._ev('content_block_start', {
        index: blockIndex,
        content_block: { type: 'tool_use', id, name, input: {} },
      });
    }

    const t = this.toolAcc.get(key);
    if (tc && tc.id) t.id = tc.id;
    if (tc && tc.function && tc.function.name) t.name = tc.function.name;
    if (tc && tc.function && tc.function.arguments) {
      t.args += tc.function.arguments;
      s += this._ev('content_block_delta', {
        index: t.blockIndex,
        delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
      });
    }
    return s;
  }

  // 结束：收尾所有块 + message_delta（带 stop_reason / usage）+ message_stop
  end(usage, finishReason) {
    let s = '';
    if (!this.started) s += this._begin();
    if (this.textOpen) { s += this._ev('content_block_stop', { index: 0 }); this.textOpen = false; }
    for (const t of this.toolAcc.values()) s += this._ev('content_block_stop', { index: t.blockIndex });

    const u = usage || {};
    if (u.prompt_tokens != null) this.inputTokens = u.prompt_tokens;
    if (u.completion_tokens != null) this.outputTokens = u.completion_tokens;

    s += this._ev('message_delta', {
      delta: { stop_reason: STOP_MAP[finishReason] || 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    s += this._ev('message_stop', {});
    return s;
  }
}

module.exports = {
  uid,
  safeParse,
  textOnly,
  STOP_MAP,
  messagesToChatCompletions,
  chatCompletionsToMessages,
  MessagesStreamEmitter,
};
