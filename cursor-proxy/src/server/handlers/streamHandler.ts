import { Request, Response } from 'express';
import { forwardToProvider, findProviderConfig } from './chatHandler.js';

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
    await forwardToProvider(req.body, providerConfig, res, stream);
  } catch (e: any) {
    res.status(502).json({ error: { message: `Proxy error: ${e.message}` } });
  }
}
