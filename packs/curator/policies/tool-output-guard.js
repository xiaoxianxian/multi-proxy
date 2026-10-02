'use strict';
// Curator pack handler · tool-output-guard（onToolOutput）
//
// 为什么要有这一个（跟 onHistory 的分工，别重复记账）：
//   onHistory 的 maxMsgChars / foldToolOutput 已经在压缩工具输出了（见 memory-history.js）。
//   两者都认 responses 协议的 { type:'function_call_output', output }（ledger 的 isToolOutput
//   同时认 role==='tool' 与 TOOL_OUTPUT_TYPES），所以**它们打的其实是同一个靶子**。
//   差别只在切法：
//     foldToolOutput  = 整条替身（留一行占位）→ 激进，内容全丢，代价小收益大；
//     maxMsgChars     = 对**所有消息**做头尾截断，工具输出只是其中一类；
//     本 handler       = 只动工具输出、只保留**头尾 + 省略说明** → 保留「开头结论 + 结尾收尾」，
//                        中间大段（日志、diff 中段、 blows-up 的中间行）才砍。
//   三条策略默认全关，同时开会互相重复记账（各自的 netTokenDelta 都算一遍同一批字符）。
//   要开就挑一条：要极限省 → foldToolOutput；要保留头尾 → 本 handler。
//
// 边界（诚实说明）：本 handler 在桥里的位置是**请求侧归一化之后**，
// 也就是上游已经把结果算进本次 prompt 之前的最后一次加工。它改的是「这一轮要发出去的
// 上下文」，不是模型调工具那一刻的返回值 —— 真正的 tool 执行回路（subagent / harness 内部）
// 在桥看不见的地方，那一段只能靠宿主 adapter，桥这里碰不到。
//
// 归一口径：一律用 ledger 的 measureText / headTail，不自起估算器，
// 免得同一个请求在不同 policy 里量出两个 token 数（58 号踩过）。

const { measureText, measureMessages, headTail, isToolOutput, toolTextOf, setToolText } = require('../ledger.js');

const hook = 'onToolOutput';
const name = 'tool-output-guard';

// 默认全关 = passthrough，零行为变更（非侵入铁律④）。
// ⚠️ 参数只加减数值，不加语义分支。校验见 curator-engine.validateChange。
const params = {
  maxOutputChars: null, // 单条工具输出字符上限，超过就 head+tail（默认不限）
  maxToolOutputs: null, // 最多保留这么多条真实工具输出，更早的折叠成占位（默认不限条数）
  keepLastN: null,      // 只处理最后 N 条工具输出（0/负/非整数 = 全量）
};

// ⚠️ 参数只认自己的 env（`applyPack` 不转发 params，见 tools/token-policy-bridge.js:65
// 的既有说明），与 tools-lazyload 的 ENV_OVERRIDE 同一套约定。
if (process.env.CURATOR_TOOL_GUARD_MAX_CHARS) params.maxOutputChars = Number(process.env.CURATOR_TOOL_GUARD_MAX_CHARS);
if (process.env.CURATOR_TOOL_GUARD_MAX_OUTPUTS) params.maxToolOutputs = Number(process.env.CURATOR_TOOL_GUARD_MAX_OUTPUTS);
if (process.env.CURATOR_TOOL_GUARD_KEEP_LAST) params.keepLastN = Number(process.env.CURATOR_TOOL_GUARD_KEEP_LAST);

function handler(ctx, io) {
  const msgs = ctx && Array.isArray(ctx.messages) ? ctx.messages : null;
  if (!msgs) return { messages: msgs || [], netTokenDelta: null, reason: 'no-messages' };
  const anyParam = Number.isInteger(params.maxOutputChars) && params.maxOutputChars > 0
    || Number.isInteger(params.maxToolOutputs) && params.maxToolOutputs > 0;
  if (!anyParam) return { messages: msgs, netTokenDelta: null, reason: 'off' };

  let truncated = 0;
  let folded = 0;
  let saved = 0;

  // ② 先按条数闸门：超出 maxToolOutputs 的那批折叠成占位符（保留条数=保留「调过哪些工具」的线索）
  let pool = msgs;
  if (Number.isInteger(params.maxToolOutputs) && params.maxToolOutputs > 0) {
    const idxs = [];
    msgs.forEach((m, i) => { if (isToolOutput(m)) idxs.push(i); });
    const overflow = idxs.length - params.maxToolOutputs;
    if (overflow > 0) {
      const cut = new Set(idxs.slice(0, overflow));
      pool = msgs.map((m, i) => {
        if (!cut.has(i)) return m;
        const before = toolTextOf(m);
        if (typeof before !== 'string' || before === '') return m;
        const nm = m.name || m.toolName || '-';
        const placeholder = `[工具输出已折叠 · 原 ${before.length} 字符 · 工具 ${nm}]`;
        saved += measureText(before) - measureText(placeholder);
        folded += 1;
        return setToolText(m, placeholder);
      });
    }
  }

  // ① 再按单条长度闸门：只过最后 keepLastN 条工具输出之后的那些（更早的已经算过账了）
  const toolIdx = [];
  pool.forEach((m, i) => { if (isToolOutput(m)) toolIdx.push(i); });
  const from = Number.isInteger(params.keepLastN) && params.keepLastN > 0
    ? Math.max(0, toolIdx.length - params.keepLastN) : 0;

  const out = pool.map((m, i) => {
    const isTool = toolIdx.indexOf(i) >= 0 && toolIdx.indexOf(i) >= from;
    if (!isTool || !isToolOutput(m)) return m;
    const before = toolTextOf(m);
    if (typeof before !== 'string') return m;
    if (Number.isInteger(params.maxOutputChars) && params.maxOutputChars > 0 && before.length > params.maxOutputChars) {
      const r = headTail(before, params.maxOutputChars);
      if (r.changed) {
        saved += measureText(before) - measureText(r.text);
        truncated += 1;
        return setToolText(m, r.text);
      }
    }
    return m;
  });

  const reason = truncated || folded
    ? `truncated:${truncated}/folded:${folded}`
    : 'all-passed';
  return {
    messages: out,
    // 裁剪是节省（负）；一段都没动就报 null，不报 0 —— 0 会被下游读成「跑了但确实没省」。
    netTokenDelta: saved > 0 ? -saved : null,
    truncated,
    folded,
    reason,
  };
}

module.exports = { handler, params, hook, name };
