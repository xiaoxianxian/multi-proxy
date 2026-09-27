'use strict';
// Curator pack handler · Prompt 面（onRequestAssemble）
// 初始 passthrough：不注入场景前缀，Curator 后续可改 scenePrefix 模板。
// 映射：Raven Prompt 面（系统提示/上岗手册组装）→ token-policy onRequestAssemble hook。

const params = { scenePrefix: '' };

function handler(ctx, io) {
  return {
    messages: (ctx && ctx.messages) || [],
    systemPrompt: (ctx && ctx.systemPrompt) || '',
    scenePrefix: params.scenePrefix,
  };
}

module.exports = { handler, params };
