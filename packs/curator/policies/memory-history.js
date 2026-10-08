// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// Curator pack handler · Memory 面（onHistory）
// 映射：Raven Memory 面（轮可见记忆）→ token-policy onHistory hook。06-curator-pack.md §3。
//
// 两种压缩，语义不同，别混为一谈：
//   ① keepLastN：活跃窗口，超出的整条**丢弃**（既有语义，既有测试钉死了「只剩 N 条」）
//   ② maxMsgChars / foldToolOutput：**压缩内容本身，不改条数**（本次新增）
// ① 会丢线索（早期的约定被切掉就再也找不回来），② 保留线索且更省——
// 工具输出通常是单条最长的那类，折叠它收益最高。两种协议形态都认：
// chat 的 { role:'tool', content } 与 responses 的 { type:'function_call_output', output }。

const { measureMessages, measureText, headTail, isToolOutput, toolTextOf, setToolText, setText, thinkingTextOf, setThinkingText } = require('../ledger.js');

// 参数对象（M6 仅允许改这里的数值，不改结构；校验见 curator-engine.validateChange）。
// 默认全关 = passthrough，零行为变更（非侵入铁律④）。
const params = {
  keepLastN: null,       // null = 不切条数
  maxMsgChars: null,     // null = 不压缩单条内容
  foldToolOutput: false, // true = role=tool 的输出折叠成占位符
};

function handler(ctx, io) {
  if (!ctx || !Array.isArray(ctx.history)) return { history: ctx ? ctx.history : [] };
  const hist = ctx.history;

  // ① 活跃窗口：超出的整条丢弃。
  //    计量口径沿用既有——省的是「被丢弃那部分」，不是前后差
  //    （既有测试断言 delta === 被裁掉部分的 tokens，改口径会让它失败）。
  let droppedTokens = 0;
  let kept = hist;
  if (Number.isInteger(params.keepLastN) && params.keepLastN > 0 && hist.length > params.keepLastN) {
    const cut = hist.length - params.keepLastN;
    droppedTokens = measureMessages(hist.slice(0, cut));
    kept = hist.slice(cut);
  }

  // ② 内容级压缩：逐条算真实差额，走 ledger 同一把秤（不自报、不另起估算口径）
  let compressedTokens = 0;
  let out = kept;
  const doFold = params.foldToolOutput === true;
  const doTruncate = Number.isInteger(params.maxMsgChars) && params.maxMsgChars > 0;
  if (doFold || doTruncate) {
    out = kept.map((m) => {
      if (!m || typeof m !== 'object') return m; // 非消息对象（如测试里的数字）原样透传

      // ②-0 推理痕迹（Anthropic thinking）：**按块类型分账**。
      // 它占上下文也占输出预算，但压它是压「过程」不是压「结论」——最安全的那一档，
      // 而且模型 thinking 吃满输出预算时（真上游实测 max_tokens 全给 thinking、整条无 text 块），
      // 压它能替结论腾出空间。只认 TEXT_PART_TYPES 的话，这类消息永远判不出超长 ⇒ 压不掉。
      if (doTruncate) {
        const th = thinkingTextOf(m);
        if (typeof th === 'string' && th.length > params.maxMsgChars) {
          const r = headTail(th, params.maxMsgChars);
          if (r.changed) {
            compressedTokens += measureText(th) - measureText(r.text);
            m = setThinkingText(m, r.text);
          }
        }
      }

      // 走 toolTextOf 而不是 textOf：responses 协议的工具输出既没 role 也没 content，
      // 用 textOf 只能拿到 null → 折叠和截断在 codex 链路上双双静默吃零。
      const before = toolTextOf(m);

      if (doFold && isToolOutput(m) && typeof before === 'string' && before.length > 0) {
        const name = m.name || m.toolName || '-';
        const folded = `[工具输出已折叠 · 原 ${before.length} 字符 · 工具 ${name}]`;
        compressedTokens += measureText(before) - measureText(folded);
        return setToolText(m, folded);
      }

      if (doTruncate && typeof before === 'string') {
        const r = headTail(before, params.maxMsgChars);
        if (r.changed) {
          compressedTokens += measureText(before) - measureText(r.text);
          return setText(m, r.text);
        }
      }
      return m;
    });
  }

  const saved = droppedTokens + compressedTokens;
  return {
    history: out,
    // C4：裁剪是**节省**（负）。一段都没裁掉就报 null，不报 0——
    // 0 会被下游读成「跑了但确实没省」，那是假数字换个字段重犯。
    netTokenDelta: saved > 0 ? -saved : null,
  };
}

module.exports = { handler, params };
