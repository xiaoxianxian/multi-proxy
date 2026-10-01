'use strict';
// Curator pack handler · Action 面（onResponse）
// 映射：Raven Action 面（执行前检查/响应精简）→ token-policy onResponse hook。
//
// simplify='whitespace' 只做两件不改变语义的事：去掉行尾空白、把 3 个以上连续
// 空行压成 2 个。收益不大但风险极小——**不去词、不改句、不动代码块内容**。
// 更激进的精简（砍客套话、压缩解释）会改变用户看到的东西，本 pack 不做。

const { measureText } = require('../ledger.js');

// pass = 不改；whitespace = 空白归一化
const params = { simplify: 'pass' };

function normalizeWhitespace(s) {
  // 顺序不能反：先去行尾空白，否则「只有空格的行」会被当成非空行，压不动空行
  return String(s).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
}

function handler(ctx, io) {
  const response = (ctx && ctx.response) || '';
  if (params.simplify !== 'whitespace' || typeof response !== 'string' || response === '') {
    // C4：simplify=pass 时不改响应文本 → 无 token 效应，报 null 不报 0。
    // 0 会被读成「跑了精简但确实没省」，那是假数字。
    return { response, simplify: params.simplify };
  }
  const after = normalizeWhitespace(response);
  const saved = measureText(response) - measureText(after);
  return {
    response: after,
    simplify: params.simplify,
    // 裁掉多少报多少；没裁掉报 null（延续 C3 纪律：null ≠ 0）
    netTokenDelta: saved > 0 ? -saved : null,
  };
}

module.exports = { handler, params };
