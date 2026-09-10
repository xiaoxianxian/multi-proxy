// Shared middleware for Express
import { Request, Response, NextFunction } from 'express';

const ADMIN_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || '';

/**
 * Admin API 认证（P0-4）：
 * 与 codex-proxy / hermes-proxy 的机制保持一致 —— 设置 PROXY_AUTH_TOKEN
 * 环境变量后，admin-api 请求必须携带 x-proxy-auth 头；未设置则不启用认证
 * （仅本机使用时的默认行为）。Manager 的 forwardProxy 已自动透传该头。
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_AUTH_TOKEN) return next(); // Auth disabled if no token set
  const headerToken = req.headers['x-proxy-auth'];
  if (typeof headerToken === 'string' && headerToken === ADMIN_AUTH_TOKEN) return next();
  res.status(401).json({ success: false, error: { message: 'Unauthorized' }, code: 'UNAUTHORIZED' });
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${req.method}] ${req.url} - ${res.statusCode} - ${duration}ms`);
  });
  next();
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[Error]', err.message);
  res.status(500).json({ error: { message: 'Internal server error' } });
}
