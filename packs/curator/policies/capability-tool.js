'use strict';
// Curator pack handler · Capability 面（onToolOutput）
// 初始 passthrough：不裁剪工具输出，Curator 后续可改 maxOutputChars / 工具闸门。
// 映射：Raven Capability 面（工具闸门）→ token-policy onToolOutput hook。

const { measureText } = require('../ledger.js');

const params = { maxOutputChars: null, toolGate: 'pass' };

function handler(ctx, io) {
  if (!ctx || !ctx.rawOutput) return { rawOutput: (ctx && ctx.rawOutput) || '', toolName: (ctx && ctx.toolName) || '' };
  // 注意：未设 maxOutputChars 时原样返回（不 String 化），保持 passthrough 零行为变更。
  const out = params.maxOutputChars == null ? ctx.rawOutput : String(ctx.rawOutput).slice(0, params.maxOutputChars);
  const dropped = params.maxOutputChars == null ? '' : String(ctx.rawOutput).slice(params.maxOutputChars);
  const trimmed = measureText(dropped);
  return {
    rawOutput: out,
    toolName: ctx.toolName || '',
    toolGate: params.toolGate,
    // C4：裁掉的工具输出是**节省**（负）。没裁掉就不报数（null）。
    netTokenDelta: trimmed > 0 ? -trimmed : null,
  };
}

module.exports = { handler, params };
