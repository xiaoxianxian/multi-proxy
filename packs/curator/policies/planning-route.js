'use strict';
// Curator pack handler · Planning 面（onRoute）
// 初始 passthrough：不改路由分级，Curator 后续可改 architectTrigger / tiering 参数。
// 映射：Raven Planning 面（任务拆解/路由顺序）→ token-policy onRoute hook。

const params = { architectTrigger: null, tiering: 'pass' }; // 全部 passthrough

function handler(ctx, io) {
  // 不改路由：返回 taskMeta 原样 + planMode:pass（Curator 后续可改）
  // C4：本面只产出路由元数据，不改任何进入模型的文本 → 无 token 效应，按纪律报 null 不报 0。
  return { taskMeta: (ctx && ctx.taskMeta) || {}, planMode: params.tiering, architectTrigger: params.architectTrigger };
}

module.exports = { handler, params };
