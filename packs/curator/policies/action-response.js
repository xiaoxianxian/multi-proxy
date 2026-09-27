'use strict';
// Curator pack handler · Action 面（onResponse）
// 初始 passthrough：不精简响应，Curator 后续可改精简规则。
// 映射：Raven Action 面（执行前检查/响应精简）→ token-policy onResponse hook。

const params = { simplify: 'pass' };

function handler(ctx, io) {
  return { response: (ctx && ctx.response) || '', simplify: params.simplify };
}

module.exports = { handler, params };
