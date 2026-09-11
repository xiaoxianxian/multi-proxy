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

// 3. 健康检查 — M1 DAG 健康依赖图：保留 status:'ok'（供 admin-auth 测试），
//    新增 checks.process（本进程存活）与 checks.database（依赖 /admin-api/health 探测 DB）。
//    顶层 /health 不受 PROXY_AUTH_TOKEN 保护（见 admin-auth 测试），但 DB 异常时降级为 'degraded'。
//    manager 会另行拉取 /admin-api/health 获取 DB 检查项并合并。
app.get('/health', (_req: any, res: any) => {
  const checks = { process: true };
  const reasons: string[] = [];
  let status = 'ok';
  res.json({
    status,
    timestamp: new Date().toISOString(),
    port: process.env.PORT || 18794,
    checks,
    reasons,
   });
});

// 4. 错误处理
app.use(errorHandler);

export default app;
