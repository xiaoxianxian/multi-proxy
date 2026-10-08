// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// Curator pack · token 记账（28 号文档 C4「pack 注入单列」）
//
// 为什么单独抽这一层：5 个 policy 里会真正改动 token 量的只有 3 个（Prompt 注入 / Memory 裁剪 /
// Capability 裁剪），三者都要「把文本变化换算成 token」。换算口径必须只有一份，否则同一个 pack
// 内部会出现两套数字——那是 C0-3 假数字的老路换个地方重犯。
//
// 语义（28 号 §七.2 第 2 条）：注入是成本（正），裁剪才是节省（负）。**分别记账，不许先加总**——
// 净额会掩盖「注入花 40、压缩省 30」这种真相，而那正是我们最需要看见的东西。
//
// 口径：复用 l2/context-fold.js 的同一把秤，不另造估算器（AGENTS §3 红线）。

const { createContextFold } = require('../../l2/context-fold.js');

const _fold = createContextFold();

/** 一段文本的 token 数。空/非字符串 = 0。 */
function measureText(s) {
  if (typeof s !== 'string' || s === '') { return 0; }
  return _fold.fold({ messages: [{ role: 'user', content: s }] }).estimate.total;
}

/** 一组被裁掉的历史消息的 token 数。走同一把秤，role 归类与请求体折叠保持一致。 */
function measureMessages(msgs) {
  if (!Array.isArray(msgs) || !msgs.length) { return 0; }
  return _fold.fold({ messages: msgs }).estimate.total;
}

/**
 * 头尾保留式截断。
 * 为什么不是直接 slice(0, max)：工具输出里最有用的往往在**尾部**——错误堆栈、
 * 命令的最后几行结果、日志的最新条目。只留头部会把真正要看的东西切掉，
 * 省了 token 却让 agent 失去判断依据，那是负收益。
 *
 * @returns {{ text:string, changed:boolean, omitted:number }} 未超长时原样返回（changed=false）
 */
function headTail(s, maxChars) {
  if (typeof s !== 'string') return { text: s, changed: false, omitted: 0 };
  if (!(Number.isInteger(maxChars) && maxChars > 0)) return { text: s, changed: false, omitted: 0 };
  if (s.length <= maxChars) return { text: s, changed: false, omitted: 0 };
  const head = Math.ceil(maxChars * 0.6);
  const tail = Math.max(0, maxChars - head);
  const omitted = s.length - head - tail;
  const mark = `\n…[已省略 ${omitted} 字符]…\n`;
  const text = tail > 0 ? s.slice(0, head) + mark + s.slice(s.length - tail) : s.slice(0, head) + mark;
  return { text, changed: true, omitted };
}

// /v1/responses 协议（codex 走的这条）里文本 part 不叫 'text'：
//   用户 / 开发者侧 = input_text，助手侧 = output_text，只有 chat 协议才叫 'text'。
// 只认 'text' 的后果不是报错，是**静默失效**：filter 出空数组 → join 出空串 →
// 长度 0 → 下游判定「这条没超长」→ 压缩恒等于零、零报错。
// 实测本机真实语料 18/18 条 input item 全部取不到文本（(p.text)||'' 那版更是把非字符串也吞成空串）。
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);

function isTextPart(p) {
  return !!p && typeof p === 'object' && TEXT_PART_TYPES.has(p.type);
}

/**
 * 取一条消息的文本。认字符串 content 与三类文本 part；
 * 图片等非文本 part 不参与压缩（压缩它们等于丢信息，且本 pack 无权决定）。
 */
function textOf(m) {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter(isTextPart)
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('\n');
  }
  return null;
}

// /v1/messages（Anthropic wire）线上助手消息还多一种 part：**thinking**（推理痕迹）。
// 它既占上下文也占输出预算，但**不是结论**（下面 TEXT_PART_TYPES 那三类才是）。
// 2026-10-02 真付费上游实测：max_tokens=16 时，16 个 token 全被 thinking 吃掉，
// 整条响应一个 text 块都没有；Kimi 一例 output=27 里 thinking 就占 23。
// ⇒ 只认 TEXT_PART_TYPES 的后果：thinking 永远判不出「超长」⇒ 压不掉，
//   就算压了 text，账本也少算一整块 —— 又一次静默少算，和 input_text 那条是同病。
const THINKING_PART_TYPES = new Set(['thinking']);

function isThinkingPart(p) {
  return !!p && typeof p === 'object' && THINKING_PART_TYPES.has(p.type);
}

/** 一条消息里的推理痕迹文本（只取 thinking part）。 */
function thinkingTextOf(m) {
  if (!m || typeof m !== 'object') return null;
  if (Array.isArray(m.content)) {
    return m.content.filter(isThinkingPart)
      .map((p) => (typeof p.thinking === 'string' ? p.thinking : ''))
      .join('\n');
  }
  return null;
}

/** 写回 thinking part：保住 part 类型，text / 图片等其它 part 原样不动。 */
function setThinkingText(m, text) {
  if (!m || typeof m !== 'object') return m;
  if (Array.isArray(m.content)) {
    let done = false;
    const parts = m.content.map((p) => {
      if (!done && isThinkingPart(p)) { done = true; return Object.assign({}, p, { thinking: text }); }
      return p;
    });
    if (done) return Object.assign({}, m, { content: parts });
  }
  return m;
}

// 工具输出的两种协议形态，长得完全不一样：
//   chat 协议   = { role:'tool', name, content }            ← 老形态
//   responses  = { type:'function_call_output', call_id, output }  ← codex 走的这条
// responses 那条**既没有 role 也没有 content**，靠 textOf 只能拿到 null，
// 于是「折叠工具输出」这条最肥的杠杆（实测省 53.7%）在 codex 链路上静默吃零。
const TOOL_OUTPUT_TYPES = new Set(['function_call_output']);

function isToolOutput(m) {
  return !!m && typeof m === 'object' && (m.role === 'tool' || TOOL_OUTPUT_TYPES.has(m.type));
}

/** 工具输出里的文本。chat 走 content，responses 走 output（字符串或 part 数组）。 */
function toolTextOf(m) {
  if (!m || typeof m !== 'object') return null;
  if (TOOL_OUTPUT_TYPES.has(m.type)) {
    const v = m.output;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      return v.filter(isTextPart).map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n');
    }
    return null;
  }
  return textOf(m);
}

function setToolText(m, text) {
  if (!m || typeof m !== 'object') return m;
  if (TOOL_OUTPUT_TYPES.has(m.type)) {
    if (typeof m.output === 'string') return Object.assign({}, m, { output: text });
    if (Array.isArray(m.output)) {
      let done = false;
      const parts = m.output.map((p) => {
        if (!done && isTextPart(p)) { done = true; return Object.assign({}, p, { text }); }
        return p;
      });
      // 同 setText：没有文本 part 就不硬塞，宁可不压也别往请求体注入协议不认的 type
      if (done) return Object.assign({}, m, { output: parts });
    }
    return m;
  }
  return setText(m, text);
}

/**
 * 写回文本，保留原消息的其他字段与非文本 part。
 *
 * 关键：**保留原 part 的 type**。把 input_text 改写成 text 会让上游按 chat 协议去读，
 * 那是把请求体换了个协议，不是压缩。
 */
function setText(m, text) {
  if (!m || typeof m !== 'object') return m;
  if (typeof m.content === 'string') return Object.assign({}, m, { content: text });
  if (Array.isArray(m.content)) {
    let done = false;
    const parts = m.content.map((p) => {
      if (!done && isTextPart(p)) { done = true; return Object.assign({}, p, { text }); }
      return p;
    });
    // 一个文本 part 都没有（纯图片 / 空 content）：不硬塞一个 part 进去——
    // 那等于往请求体里注入协议不认的 type，比不压这条更糟。返回原对象，静默不压。
    if (done) return Object.assign({}, m, { content: parts });
    return m;
  }
  return Object.assign({}, m, { content: text });
}

module.exports = {
  measureText, measureMessages, headTail,
  textOf, setText,
  isThinkingPart, thinkingTextOf, setThinkingText,
  isToolOutput, toolTextOf, setToolText,
};
