'use strict';
// Curator pack handler · Capability 面（onToolOutput）
// 映射：Raven Capability 面（工具闸门）→ token-policy onToolOutput hook。
//
// 两种裁剪模式：
//   ① maxOutputChars：硬截断，只留头部（既有语义，既有测试钉死了「长度精确等于 N」）
//   ② headChars + tailChars：头尾保留，中间省略（本次新增，需两者都设才生效）
// 为什么要有 ②：工具输出里最值钱的常在**尾部**——错误堆栈、命令结果最后几行、
// 日志的最新条目。只留头部省了 token 却让 agent 失去判断依据，是负收益。

const { measureText, headTail } = require('../ledger.js');

const params = {
  maxOutputChars: null, // 硬截断上限（只留头部）
  headChars: null,      // 头尾模式：头部保留字符数
  tailChars: null,      // 头尾模式：尾部保留字符数
  toolGate: 'pass',
};

function handler(ctx, io) {
  if (!ctx || !ctx.rawOutput) return { rawOutput: (ctx && ctx.rawOutput) || '', toolName: (ctx && ctx.toolName) || '' };

  // 未设任何裁剪参数时原样返回（不 String 化），保持 passthrough 零行为变更。
  const headTailMode = Number.isInteger(params.headChars) && params.headChars > 0
    && Number.isInteger(params.tailChars) && params.tailChars > 0;

  let out = ctx.rawOutput;
  let trimmed = 0;

  if (headTailMode) {
    // 头尾保留：预算是两者之和，跟硬截断的口径对齐（都是「保留多少字符」）
    const r = headTail(String(ctx.rawOutput), params.headChars + params.tailChars);
    if (r.changed) {
      out = r.text;
      // 计量按真实差额，不按字符数换算——估算器口径只有 ledger 一份
      trimmed = measureText(String(ctx.rawOutput)) - measureText(r.text);
    }
  } else if (Number.isInteger(params.maxOutputChars) && params.maxOutputChars > 0) {
    const raw = String(ctx.rawOutput);
    out = raw.slice(0, params.maxOutputChars);
    // 既有口径：省的是「被切掉那部分」
    trimmed = measureText(raw.slice(params.maxOutputChars));
  }

  return {
    rawOutput: out,
    toolName: ctx.toolName || '',
    toolGate: params.toolGate,
    // C4：裁掉的工具输出是**节省**（负）。没裁掉就不报数（null），不报 0。
    netTokenDelta: trimmed > 0 ? -trimmed : null,
  };
}

module.exports = { handler, params };
