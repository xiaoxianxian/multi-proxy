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

module.exports = { measureText, measureMessages };
