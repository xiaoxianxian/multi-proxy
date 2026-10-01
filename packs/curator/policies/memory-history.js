'use strict';
// Curator pack handler · Memory 面（onHistory）
// 初始 passthrough：保留全部历史，Curator 后续可改 keepLastN 参数（M6 受限变更集）。
// 映射：Raven Memory 面（轮可见记忆）→ token-policy onHistory hook。
// 06-curator-pack.md §3。

const { measureMessages } = require('../ledger.js');

// 参数对象（M6 仅允许改这里的数值，不改结构；校验见 curator-engine.validateChange）。
const params = { keepLastN: null }; // null = 全部保留（passthrough）

// passthrough handler：不改 ctx，返回等价对象。
function handler(ctx, io) {
  if (!ctx || !Array.isArray(ctx.history)) return { history: ctx ? ctx.history : [] };
  if (params.keepLastN == null) return { history: ctx.history };
  const kept = ctx.history.slice(-params.keepLastN);
  const dropped = ctx.history.slice(0, Math.max(0, ctx.history.length - params.keepLastN));
  const trimmed = measureMessages(dropped);
  return {
    history: kept,
    // C4：裁剪掉的历史是**节省**（负）。一段都没裁掉就不报数（null），不报 0。
    netTokenDelta: trimmed > 0 ? -trimmed : null,
  };
}

module.exports = { handler, params };
