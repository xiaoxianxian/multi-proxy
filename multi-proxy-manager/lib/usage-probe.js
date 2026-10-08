// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * usage 探针 —— 把各家上游的 usage 形状归一成 cost-track 吃的
 * { prompt, completion, cacheHit, thinking }。
 *
 * 设计原则（维护者 2026-10-02 拍板：「开盒即用」+ 对接入方友好）:
 *   接入方（任何 agent 的代理：codex / cursor / hermes / 未来第三方）**一行解析代码都不用写**，
 *   只需上报两件事：
 *     1. `raw` —— 上游返回的 usage **原样**（对象，或流式时 SSE 拼接文本）
 *     2. `wire`（可选）—— 已知就声明，不知道就由 detectWire() 自动认
 *   解析与归一在这里按 wire 自动生成 ⇒ 新增 provider / 新增 agent 代理，
 *   不需要改接入侧，也不需要往本仓库提解析补丁。
 *
 * 为什么不只是「对象直接透传」：流式响应里 usage 藏在最后一个 SSE 事件（Anthropic 的
 * `message_delta` / OpenAI 的最后一个 chat.completion chunk），代理层不解析就拿不到；
 * 而让它解析就等于把 SSE 协议知识扩散到每个接入方。所以由本模块**单点吃掉**。
 */

// ---------- wire 自动识别（接入方可以不声明） ----------
function detectWire(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return fromSse(raw) ? 'sse' : detectWire(fromJsonText(raw));
  if (typeof raw !== 'object') return null;
  if (raw.usage && typeof raw.usage === 'object') return detectWire(raw.usage); // 包一层 { usage: {...} }
  if ('output_tokens_details' in raw || 'input_tokens' in raw) return 'anthropic';
  if ('prompt_tokens' in raw || 'completion_tokens' in raw) return 'openai';
  if ('usage_metadata' in raw) return 'gemini';
  return 'custom';
}

// ---------- SSE 文本 → usage ----------
// 流式响应的 usage 只在末尾事件里。逐条 `data: {...}` 取**最后一个能 parse 的 JSON**：
// 中途的 chunk 常常是半个 JSON，parse 失败就跳过（下一个事件会补齐）。
function fromSse(text) {
  if (typeof text !== 'string' || !text.includes('data:')) return null;
  const re = /data:\s*(\{[\s\S]*?\})\s*(?:\n|$)/g;
  let m;
  let last = null;
    while ((m = re.exec(text))) {
    try {
      // Anthropic 的 message_delta / OpenAI 的末 chunk 都把 usage 嵌在 `usage` 子对象下，
      // 不往里挖一层就只能拿到空壳（实测踩到：流式下 thinking 恒 0）。
      const o = JSON.parse(m[1]);
      last = o && o.usage ? o.usage : o;
    } catch (e) { /* 半截 chunk，忽略 */ }
  }
  return last;
}

// ---------- 整段 JSON 文本 → usage ----------
// 非流式响应：上游返回的一整段就是 JSON，Anthropic 线把 usage 包在 `.usage` 子对象下
// （实测：{"usage":{"input_tokens":31,...,"output_tokens_details":{"thinking_tokens":38}}}）。
// 只认 SSE 会让这条路径退化成全 0 空账（2026-10-02 e2e 实测踩到）。返回**去掉包装**的 usage。
function fromJsonText(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  let o;
  try { o = JSON.parse(s); } catch (e) { return null; } // 半截 / 非 JSON → 认不出来
  if (!o || typeof o !== 'object') return null;
  if (o.usage && typeof o.usage === 'object') return o.usage;
  if ('usage_metadata' in o || 'output_tokens' in o || 'prompt_tokens' in o) return o;
  return null;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

/** 归一：认 Anthropic / OpenAI / Gemini 三种原生形状，unknown 一律 0（不猜、不折算）。 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { prompt: 0, completion: 0, cacheHit: 0, thinking: 0, wire: 'unknown' };
  // 允许直接喂「包了一层的响应体」，归一后再看字段 —— 接入方贴什么形状都不用挑。
  if (raw.usage && typeof raw.usage === 'object') return normalize(raw.usage);

  // Gemini：usage_metadata.{prompt_token_count, candidates_token_count, cached_content_token_count, thoughts_token_count}
  const gm = raw.usage_metadata;
  if (gm && typeof gm === 'object') {
    return {
      prompt: num(gm.prompt_token_count),
      completion: num(gm.candidates_token_count),
      cacheHit: num(gm.cached_content_token_count),
      thinking: num(gm.thoughts_token_count),
      wire: 'gemini',
    };
  }

  // Anthropic：input_tokens / output_tokens / output_tokens_details.{thinking_tokens, cache_read_input_tokens}
  // OpenAI：prompt_tokens / completion_tokens / prompt_tokens_details.{cached_tokens}
  // 两者字段名不同但都带 thinking（Anthropic 在 details 里、OpenAI 偶见裸 thinking_tokens）
  // Anthropic：output_tokens_details.{thinking_tokens, cache_read_input_tokens}
  // OpenAI：prompt_tokens_details.{cached_tokens}（偶见裸 thinking_tokens）
  const td = raw.output_tokens_details;
  const cacheRead = num(raw.cache_read_input_tokens) || num(raw.prompt_tokens_details && raw.prompt_tokens_details.cached_tokens);
  const thinking = td && typeof td.thinking_tokens === 'number' ? td.thinking_tokens
                 : num(raw.thinking_tokens);

  return {
    prompt: num(raw.input_tokens) || num(raw.prompt_tokens),
    completion: num(raw.output_tokens) || num(raw.completion_tokens),
    cacheHit: cacheRead,
    thinking,
    wire: 'chat',
  };
}

/**
 * 归一入口。吃两种 raw：
 *   - 对象（非流式，可以是响应体本身 or 裸 usage）
 *   - SSE 拼接文本（流式）
 *   - 整段 JSON 文本（非流式；Anthropic 把 usage 包在 .usage 里）
 * 返回 { prompt, completion, cacheHit, thinking, wire }；**一个 token 都认不出来就全 0**（宁可空账，不虚账）。
 */
function toUsage(raw) {
  if (typeof raw === 'string') {
    // 流式优先（usage 在末事件），认不出再退到整段 JSON。
    const obj = fromSse(raw) || fromJsonText(raw);
    if (!obj) return { prompt: 0, completion: 0, cacheHit: 0, thinking: 0, wire: 'raw-unparsed' };
    const out = normalize(obj);
    out.wire = detectWire(obj) || out.wire;
    return out;
  }
  const out = normalize(raw);
  out.wire = detectWire(raw) || out.wire;
  return out;
}

module.exports = { detectWire, fromSse, fromJsonText, normalize, toUsage };
