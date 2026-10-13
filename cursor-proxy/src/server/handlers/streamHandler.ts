// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

import { Request, Response } from 'express';
import { forwardToProvider, findProviderConfig, applyRouting } from './chatHandler.js';

/**
 * 流式聊天请求处理
 * 复用 chatHandler 的核心逻辑
 */
export async function handleChatStream(req: Request, res: Response): Promise<void> {
  const { model, messages, stream } = req.body;

  if (!model || !messages || !Array.isArray(messages)) {
    res.status(400).json({ error: { message: 'Invalid request: model and messages are required' } });
    return;
  }

  const providerConfig = findProviderConfig(model);
  if (!providerConfig) {
    res.status(404).json({ error: { message: `No enabled provider found for model: ${model}` } });
    return;
  }

  try {
    // 2026-10-12 修：流式入口原先直发，完全绕过 override 与 shadow 采样。
    // Cursor 的主流式请求 ⇒ 不补这一步，override 灰度与 M6 观测数据就是脏的。
    const routing = await applyRouting(req.body, model, messages as any[], providerConfig);
    await forwardToProvider(req.body, providerConfig, res, stream, req, routing.feedbackRowId);
  } catch (e: any) {
    res.status(502).json({ error: { message: `Proxy error: ${e.message}` } });
  }
}
