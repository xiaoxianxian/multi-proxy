#!/usr/bin/env node
// Multi-Proxy Manager Shell — 组装层。
// 业务实现拆分在 lib/（auth/logger/process-manager/forward）与 routes/ 下，
// 本文件只负责 express 应用组装：中间件顺序 + 路由挂载 + 错误处理 + SPA fallback。
const express = require('express');
const path = require('path');

const pm = require('./lib/process-manager');

const authRoutes = require('./routes/auth');
const controlRoutes = require('./routes/proxy-control');
const registryRoutes = require('./routes/registry');
const apiRoutes = require('./routes/proxy-api');
const metaRoutes = require('./routes/meta');
const sessionsRoutes = require('./routes/sessions');

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
// L2 P0 Registry：必须挂在代理 wildcard（apiRoutes 的 /:proxy/*）之前，
// 否则 /api/registry/agents 会被 :proxy=registry 误捕获并被白名单 404。
app.use('/api/registry', registryRoutes);
// L2 P2：orchestration — 编排引擎接线（门控 PROXY_ORCHESTRATION 默认关，shadow 默认开）
const orchestrationRoutes = require('./routes/orchestration');
app.use('/api/orchestration', orchestrationRoutes);
// M7 Sessions：挂在代理 wildcard 之前，确保 /api/sessions/* 不被误捕获
app.use('/api/sessions', sessionsRoutes);
// M2 Provider Health：只读展示层，挂在代理 wildcard 之前（与 registry/sessions 同模式）
app.use('/api/provider-health', require('./routes/provider-health'));
// L2 P2 告警生产接线：/api/alert 把 alert.js 内核接上真实信号源（门控 PROXY_HEALTH_ALERT 默认关）
const alertRoutes = require('./routes/alert');
app.use('/api/alert', alertRoutes);
// L2 P3：skill-service + memory-merge 生产接线（门控 PROXY_L2_SKILL / PROXY_L2_MEMORY 默认关，非侵入）
// 与 orchestration/sessions/alert 同模式，挂在代理 wildcard（apiRoutes）之前。
const skillServiceRoutes = require('./routes/skill-service');
app.use('/api/skill-service', skillServiceRoutes);
const memoryMergeRoutes = require('./routes/memory-merge');
app.use('/api/memory-merge', memoryMergeRoutes);
// L2 P3 · MCP Bridge 生产接线：/api/mcp 把 l2/mcp-server.js（JSON-RPC 2.0）接上 manager
// 门控 PROXY_L2_MCP 默认关（非侵入，与 skill/memory 同模式），只暴露只读查询 + 路由决策（shadow）。
const mcpRoutes = require('./routes/mcp');
app.use('/api/mcp', mcpRoutes);
// L2 P0 · knowledge-base（RAG 知识库）生产接线：/api/knowledge 把 l2/knowledge-base 接上 manager
// 门控 PROXY_L2_KNOWLEDGE 默认关（非侵入，与 skill/memory/mcp 同模式）；拉模式：读不鉴权、写鉴权（requireAuth）
const knowledgeRoutes = require('./routes/knowledge-base');
app.use('/api/knowledge', knowledgeRoutes);
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
      '/sessions': 'sessions.html',
    };
    const page = routeMap[req.path] || 'dashboard.html';
    return res.sendFile(path.join(__dirname, 'public', page));
  }
  next();
});

// L2 P2 cost 启动期接线（全非侵入，门控默认关 = 零副作用）：
//   1. loadPricingFromEnv：读 PROXY_PRICING_<proxy> env 注入 cost-track 单价
//      （无此 env 时 no-op；仅 PROXY_PRICING_* 存在时才建 state）。
//   2. alertRoutes.startCostScheduler：PROXY_COST_SCHEDULE 门控（默认关 → 返回 null 不建 timer）；
//     开 = 定时跑 runAllCollects（3 路：provider-health + error-patterns + cost × 预算）。
//     unref 不阻塞进程退出；单次 tick 崩 best-effort 不影响后续。
const costTrack = require('./lib/cost-track');

// 启动服务（跳过测试环境）
if (process.env.NODE_ENV !== "test") {
  costTrack.loadPricingFromEnv();
  const costScheduler = alertRoutes.startCostScheduler();
  // 管理面板默认只绑本回环 127.0.0.1（安全收紧：面板带 JWT 但不应全网卡可达）；
  // Docker/跨机部署显式设 BIND_HOST=0.0.0.0，沿用 hermes-proxy 的 BIND_HOST 惯例。
  const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
  app.listen(PORT, BIND_HOST, () => {
    console.log('\n========================================');
    console.log('  Multi-Proxy Manager Shell');
    console.log(`  Access: http://${BIND_HOST}:${PORT}`);
    console.log(`  Managed proxies: ${Object.keys(pm.getProxyConfigs()).join(', ') || 'none'}`);
    console.log('========================================\n');
    if (costScheduler) {
      console.log(`[cost] alert scheduler started every ${costScheduler.intervalMs}ms (PROXY_COST_SCHEDULE=on)`);
     }
   });
}


module.exports = app;
