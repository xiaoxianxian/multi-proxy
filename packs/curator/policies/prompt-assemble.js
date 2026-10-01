'use strict';
// Curator pack handler · Prompt 面（onRequestAssemble）
// 初始 passthrough：不注入场景前缀，Curator 后续可改 scenePrefix 模板。
// 映射：Raven Prompt 面（系统提示/上岗手册组装）→ token-policy onRequestAssemble hook。

const { measureText } = require('../ledger.js');

const params = { scenePrefix: '' };

function handler(ctx, io) {
  const prefix = typeof params.scenePrefix === 'string' ? params.scenePrefix : '';
  const injected = measureText(prefix);
  return {
    messages: (ctx && ctx.messages) || [],
    systemPrompt: (ctx && ctx.systemPrompt) || '',
    scenePrefix: prefix,
    // C4：注入是**正成本**（本 handler 只声明注入，是否拼进 systemPrompt 由调用方决定）。
    // 没注入就不报数（null）而不是 0——0 会被读成「注入了但没花钱」，那是假数字。
    netTokenDelta: injected > 0 ? injected : null,
  };
}

// C4：声明本 policy 要注入什么，供 engine 喂进 context-fold 的第七类（skill）。
// 与 handler 的 netTokenDelta 同源，两处口径一致。
function injections() {
  const prefix = typeof params.scenePrefix === 'string' ? params.scenePrefix : '';
  return prefix ? [{ sink: 'skill', text: prefix }] : [];
}

module.exports = { handler, params, injections };
