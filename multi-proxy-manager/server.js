#!/usr/bin/env node
// Multi-Proxy Manager Shell — 组装层。
// 业务实现拆分在 lib/（auth/logger/process-manager/forward）与 routes/ 下，
// 本文件只负责 express 应用组装：中间件顺序 + 路由挂载 + 错误处理 + SPA fallback。
const express = require('express');
const path = require('path');

const pm = require('./lib/process-manager');

const authRoutes = require('./routes/auth');
const controlRoutes = require('./routes/proxy-control');
const apiRoutes = require('./routes/proxy-api');
const metaRoutes = require('./routes/meta');

const app = express();
const PORT = parseInt(process.env.PORT) || 18792;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:18792';
console.log('[CORS] Origin: ' + CORS_ORIGIN);

app.use(require('cors')({ origin: CORS_ORIGIN }));

// A11: Per-route payload limits — /v1/chat/completions allows up to 50MB for large requests,
// all other endpoints use 10MB limit.
app.use((req, res, next) => {
  if (req.path === '/v1/chat/completions' || req.path.startsWith('/v1/chat/completions/')) {
    express.json({ limit: '50mb' })(req, res, next);
  } else {
    express.json({ limit: '10mb' })(req, res, next);
  }
});

// Disable caching for HTML so browser always gets latest version
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-cache');
  }
  next();
});

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net unpkg.com; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net unpkg.com; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ==================== 路由挂载（顺序敏感） ====================
// - /api/auth/*   认证（login/status）
// - /api/*        代理生命周期、日志、供应商 API、转发白名单（wildcard 最后）
// - /api/*        元信息（autostart/version/installed/env-check；health 在根级单独挂）
app.use('/api/auth', authRoutes);
app.use('/api', controlRoutes);
app.use('/api', apiRoutes);
app.get('/health', (_req, res) => { res.json({ status: 'ok', timestamp: new Date().toISOString() }); });
app.use('/api', (req, res, next) => { if (req.path === '/health') return next(); next(); }, metaRoutes);

// Error-handling middleware: JSON body 解析失败（非法 JSON）等错误统一返回
// 简洁文案，不把 Node 堆栈/内部路径暴露给客户端。
app.use((err, _req, res, _next) => {
  const isBodyParse = err.type === 'entity.parse.failed' || err instanceof SyntaxError;
  if (!res.headersSent) {
    res.status(isBodyParse ? 400 : 500).json({
      success: false,
      error: isBodyParse ? 'Invalid request body: malformed JSON' : 'Internal server error',
    });
  }
});

// SPA fallback: serve correct HTML page based on route
// Placed AFTER all route handlers so explicit routes like /health take priority
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && req.path.indexOf('.') === -1) {
    // Map routes to HTML files
    const routeMap = {
      '/': 'dashboard.html',
      '/dashboard': 'dashboard.html',
      '/logs': 'logs.html',
      '/proxy-config': 'proxy-config.html',
    };
    const page = routeMap[req.path] || 'dashboard.html';
    return res.sendFile(path.join(__dirname, 'public', page));
  }
  next();
});

// 启动服务（跳过测试环境）
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log('\n========================================');
    console.log('  Multi-Proxy Manager Shell');
    console.log(`  Access: http://localhost:${PORT}`);
    console.log(`  Managed proxies: ${Object.keys(pm.getProxyConfigs()).join(', ') || 'none'}`);
    console.log('========================================\n');
});
}


module.exports = app;
