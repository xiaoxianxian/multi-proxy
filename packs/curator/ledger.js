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

/**
 * 取一条消息的文本。只认字符串 content 与 text part 数组；
 * 图片等非文本 part 不参与压缩（压缩它们等于丢信息，且本 pack 无权决定）。
 */
function textOf(m) {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter((p) => p && p.type === 'text').map((p) => (p && p.text) || '').join('\n');
  }
  return null;
}

/** 写回文本，保留原消息的其他字段与非文本 part（只替换第一个 text part）。 */
function setText(m, text) {
  if (!m || typeof m !== 'object') return m;
  if (typeof m.content === 'string') return Object.assign({}, m, { content: text });
  if (Array.isArray(m.content)) {
    let done = false;
    const parts = m.content.map((p) => {
      if (!done && p && p.type === 'text') { done = true; return Object.assign({}, p, { text }); }
      return p;
    });
    if (!done) parts.push({ type: 'text', text });
    return Object.assign({}, m, { content: parts });
  }
  return Object.assign({}, m, { content: text });
}

module.exports = { measureText, measureMessages, headTail, textOf, setText };
