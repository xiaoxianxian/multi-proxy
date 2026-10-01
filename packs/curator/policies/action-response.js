'use strict';
// Curator pack handler · Action 面（onResponse）
// 初始 passthrough：不精简响应，Curator 后续可改精简规则。
// 映射：Raven Action 面（执行前检查/响应精简）→ token-policy onResponse hook。

const params = { simplify: 'pass' };

function handler(ctx, io) {
  // C4：simplify=pass 时不改响应文本 → 无 token 效应，报 null 不报 0。
  // 将来若实现真正的响应精简，必须在这里上报负值（裁掉了多少），并按 ledger 口径换算。
  return { response: (ctx && ctx.response) || '', simplify: params.simplify };
}

module.exports = { handler, params };
