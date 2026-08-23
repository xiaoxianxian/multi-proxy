import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import { requestLogger, errorHandler } from './middleware.js';
import { validateRequestBody, validateChatRequest } from './validation.js';
import { chatRoutes, adminRoutes, modelRoutes } from './routes/index.js';
import { registerDefaultProviders, ProviderRegistry } from '../providers/index.js';

// Register default providers at module load time
registerDefaultProviders(ProviderRegistry.getInstance());

const app = express();

// 1. 中间件
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(validateRequestBody);

// 2. 路由
app.use('/v1', chatRoutes);
app.use('/admin-api', adminRoutes);
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
