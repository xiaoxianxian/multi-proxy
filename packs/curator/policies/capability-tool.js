'use strict';
// Curator pack handler · Capability 面（onToolOutput）
// 初始 passthrough：不裁剪工具输出，Curator 后续可改 maxOutputChars / 工具闸门。
// 映射：Raven Capability 面（工具闸门）→ token-policy onToolOutput hook。

const params = { maxOutputChars: null, toolGate: 'pass' };

function handler(ctx, io) {
  if (!ctx || !ctx.rawOutput) return { rawOutput: (ctx && ctx.rawOutput) || '', toolName: (ctx && ctx.toolName) || '' };
  const out = params.maxOutputChars == null ? ctx.rawOutput : String(ctx.rawOutput).slice(0, params.maxOutputChars);
  return { rawOutput: out, toolName: ctx.toolName || '', toolGate: params.toolGate };
}

module.exports = { handler, params };
