import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import { requestLogger, errorHandler, requireAdminAuth } from './middleware.js';
import { validateRequestBody, validateChatRequest } from './validation.js';
import { chatRoutes, adminRoutes, modelRoutes } from './routes/index.js';
import { registerDefaultProviders, ProviderRegistry } from '../providers/index.js';

// Register default providers at module load time
registerDefaultProviders(ProviderRegistry.getInstance());

const app = express();

// 1. 中间件
app.use(helmet());
app.use(compression());
// P0-4: CORS 收紧 —— 默认完全不挂 cors 中间件（浏览器同源策略生效，
// 不返回任何 CORS 头），仅在显式配置 CORS_ORIGIN 时放行指定来源
// （逗号分隔多个）。此前 cors() 等价于 Access-Control-Allow-Origin: *，
// 局域网内任意页面可调用 admin-api。
const corsOrigin = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (corsOrigin.length > 0) {
  app.use(cors({ origin: corsOrigin }));
}
app.use(requestLogger);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(validateRequestBody);

// 2. 路由
app.use('/v1', chatRoutes);
// P0-4: admin-api 挂载认证中间件（PROXY_AUTH_TOKEN 未设置时不启用）
app.use('/admin-api', requireAdminAuth, adminRoutes);
app.use('/v1/models', modelRoutes);

// 3. 健康检查
app.get('/health', (_req: any, res: any) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: process.env.PORT || 18794,
  });
});

// 4. 错误处理
app.use(errorHandler);

export default app;
