#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// Multi-Proxy Manager Shell — 组装层。
// 业务实现拆分在 lib/（auth/logger/process-manager/forward）与 routes/ 下，
// 本文件只负责 express 应用组装：中间件顺序 + 路由挂载 + 错误处理 + SPA fallback。
const express = require('express');
const path = require('path');
const os = require('os');

const pm = require('./lib/process-manager');

const auth = require('./lib/auth');
const authRoutes = require('./routes/auth');
const controlRoutes = require('./routes/proxy-control');
const registryRoutes = require('./routes/registry');
const apiRoutes = require('./routes/proxy-api');
const metaRoutes = require('./routes/meta');
const sessionsRoutes = require('./routes/sessions');
const guardBusinessRoutes = require('./routes/side-effect-guard');

// 跨进程写账机器凭据：mint（或读回）~/.multi-proxy-manager/agent-token 并注入自身 env。
// 关键在下文 —— process-manager 的 spawnProxy 用 `{ ...process.env }` 拉代理子进程，
// 这行让所有经 manager 拉起的代理自动带上 x-agent-token，第三方代理复制同一串即可。
process.env.MANAGER_AGENT_TOKEN = auth.getOrGenerateAgentToken();

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
// 首启同意门（默认拦管理页；CI/测试口子：MP_CONSENT_BYPASS 或 NODE_ENV=test 全放行）。
// 状态基座 lib/consent.js（纯文件标记，非侵入）；端点在下方 /api/consent* 挂出。
const consent = require('./lib/consent');
const legalLib = require('./lib/legal');
function consentBypass(req) {
  // CI / 自动化 / 单测默认放行，避免挡住既有 1529 测试；真实首启由 isConsented() 判定。
  const bypass = /1|true|yes/i.test(process.env.MP_CONSENT_BYPASS || '') || (process.env.NODE_ENV === 'test');
  if (bypass) return true;
  return consent.isConsented();
}
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
// B 类链路业务侧端点（独立存储 guard-business，供外部项目如审核平台经 HTTP 接入）
app.use('/api/guard', guardBusinessRoutes);
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
// L2 P3 · skill-hosts 宿主 adapter 生产接线：/api/skill-hosts 把 l2/skill-hosts.js 接上 manager。
// 门控 PROXY_L2_SKILLHOSTS 默认关（同 skill/memory/mcp 模式），**只读面**（scan + plan dry-run，绝不写 agent 目录）。
const skillHostsRoutes = require('./routes/skill-hosts');
app.use('/api/skill-hosts', skillHostsRoutes);
// L2 P3 · MCP Bridge 生产接线：/api/mcp 把 l2/mcp-server.js（JSON-RPC 2.0）接上 manager
// 门控 PROXY_L2_MCP 默认关（非侵入，与 skill/memory 同模式），只暴露只读查询 + 路由决策（shadow）。
const mcpRoutes = require('./routes/mcp');
app.use('/api/mcp', mcpRoutes);
// L2 P0 · knowledge-base（RAG 知识库）生产接线：/api/knowledge 把 l2/knowledge-base 接上 manager
// 门控 PROXY_KNOWLEDGE_BASE 默认关（非侵入，与 skill/memory/mcp 同模式）；拉模式：读不鉴权、写鉴权（requireAuth）
const knowledgeRoutes = require('./routes/knowledge-base');
app.use('/api/knowledge', knowledgeRoutes);
// L2 影子能力可视化（只读端点，l2/observe-shadow-run.js 那张 capability 表的实时版；零下游）。
const l2Routes = require('./routes/l2');
app.use('/api/l2', l2Routes);
// 代理面 floor view：只读聚合（cost-track + provider-health），挂在代理 wildcard 之前。
// 与 registry/provider-health/sessions 同模式；纯只读展示，零副作用、无门控。
app.use('/api/floor', require('./routes/floor'));
// 跨进程 usage 上报面：代理进程（如 codex-proxy）把上游 usage 报进来，与 floor 同挂此层。
// 接入规范见 routes/cost-report.js 头注释 —— 接入方只需贴 raw + agent，解析由 usage-probe 自动做。
app.use('/api/cost', require('./routes/cost-report'));
// context-breakdown：lane 上报 + 面板查询（门控 PROXY_CONTEXT_TRACK 默认关；口径 docs/context-breakdown-口径.md）
app.use('/api/context', require('./routes/context'));
// P7 本地预算闸门：只读判级（GET）+ 越限采集发告警（POST collect，复用 alert 内核规则）。
// 没配 budget.json ⇒ enabled:false，零行为变更。边界见 routes/budget.js 头注释：
// 单租户本地能力，不碰账号/余额/代持（那层等公司 + 商业/法务 feasibility）。
app.use('/api/budget', require('./routes/budget'));
// h3web Guard：外部本地服务（h3web :8731）检测 / 提醒 / 可选一键开启。
// 与 provider-health/sessions 同模式，挂在代理 wildcard 之前（否则 /api/h3web 被 :proxy=h3web 误捕获）。
// 分工（维护者 2026-10-10）：不替 h3web 配 launchd 常驻，只在使用侧「发现没起就提醒」+ 留门控一键开启。
app.use('/api/h3web', require('./routes/h3web-guard'));
// L2 P4 · IM 入站通道：把 IM 平台（飞书/Telegram/…）的消息接进本地 agent 执行并回投。
// 门控 PROXY_IM_INBOUND 默认关（非侵入，与 orchestration/alert 同模式），
// 真执行另受 PROXY_EXECUTOR_BIND 门控（缺省 0）→ 不开不触下游、不花钱。
app.use('/api/im-inbound', require('./routes/im-inbound'));
// 首启同意门端点：必须挂在代理 wildcard（apiRoutes 的 /:proxy/*）之前，
// 否则 /api/consent 会被 :proxy=consent 误捕获。本机单人面，读写均不加 requireAuth。
app.get('/api/consent', (_req, res) => {
  const st = consent.consentState();
  res.json(Object.assign({ success: true }, st));
 });
app.post('/api/consent/accept', (_req, res) => {
  try {
    consent.markConsented();
    res.json({ success: true, consented: true, marker: consent.consentState().markerPath });
   } catch (e) {
    res.status(500).json({ success: false, error: String((e && e.message) || e) });
   }
});
app.post('/api/consent/revoke', (_req, res) => {
  try {
    consent.revokeConsent();
    res.json({ success: true, consented: consent.isConsented() });
   } catch (e) {
    res.status(500).json({ success: false, error: String((e && e.message) || e) });
   }
});
app.get('/consent', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'consent.html')));
// 法务文本可达页（D1，2026-10-19 首启信任页评审 §3-P2#6 / §6-P1#1）：本地 docs/legal 定稿文本
// + 服务端安全渲染（零网络、零第三方读）。/api/legal 在 :proxy wildcard 前挂载避免被误捕获；
// /legal 经下方 routeMap 在同意门内可达。type 非法/缺文件 → 200 + fallback，不 500、不抛。
app.get('/api/legal', (req, res) => {
  res.json(legalLib.legalDoc(String((req.query || {}).type || 'terms')));
});
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
      '/knowledge': 'knowledge.html',
      '/floor': 'floor.html',
      // context-breakdown 面板页（只读聚合，与 /floor 同模式）
      '/context': 'context.html',
      // P0 修：dashboard 侧栏跳 /skills，routeMap 缺此项 ⇒ 点击被回落成 dashboard（无反应）。
      '/skills': 'skills.html',
      // 法务文本可达页（D1）：首启页「法务条款」链接指向此页，与 /consent 同处同意门内
      '/legal':    'legal.html',
      // v1.0 补 settings 页：外观/关于/更新与备份（本地优先，内嵌在管理组路由）
      '/settings': 'settings.html',
      };
    // 首启同意门：默认拦管理页（未同意 → 跳 /consent overlay）；
   // CI/测试经 consentBypass() 全放行（1529 测试不受影响）；/login 入口不拦。
   if (req.path !== '/login' && !consentBypass(req)) {
    return res.redirect('/consent');
   }
  const page = routeMap[req.path] || 'dashboard.html';
  return res.sendFile(path.join(__dirname, 'public', page));
  }
  next();
});

// L2 P2 cost 启动期接线（全非侵入，门控默认关 = 零副作用）：
//   1. loadPricingFromEnv：读 PROXY_PRICING_<proxy> env 注入 cost-track 单价
//      （无此 env 时 no-op；仅 PROXY_PRICING_* 存在时才建 state）。
//   1b. loadLedger：读回上次进程落的历史账（cost-ledger.jsonl）合并进内存态，
//       进程重启不丢账。读回用**行内冻结的 cost**，不按现价重算（价表改了历史账单不能漂）。
//       必须在 loadPricingFromEnv 之后 —— 历史行里的模型要先有 pricing 才拆得出账。
//   2. alertRoutes.startCostScheduler：PROXY_COST_SCHEDULE 门控（默认关 → 返回 null 不建 timer）；
//     开 = 定时跑 runAllCollects（3 路：provider-health + error-patterns + cost × 预算）。
//     unref 不阻塞进程退出；单次 tick 崩 best-effort 不影响后续。
const costTrack = require('./lib/cost-track');
// M2 自动隔离执行层接线（门控 PROXY_HEALTH_ISOLATE 默认关 = observe 零副作用）。
// 门控开 = 显式 opt-in：注册内置 writeMarkers 进活跃表 → runAllCollects 第 1b 路真写隔离 sidecar
// （flippedEnabled 仍默认 null = 不 flip providers.json/路由，仅写 sidecar；.tmp→rename 原子+backup）。
const isolationExecutor = require('./lib/provider-isolation-executor');
// B 类副作用故障处置链路（门控 MULTI_PROXY_SIDE_EFFECT_GUARD 默认关 = 零副作用）。
// 这里 require 只是为了启动时把门控状态打出来；**实际生效的实例由 routes/sessions.js
// 自行 lazy 创建**，两者指向同一账本文件，不存在状态分裂。
const { SideEffectGuard } = require('./lib/side-effect-guard');

// 启动服务（跳过测试环境）
if (process.env.NODE_ENV !== "test") {
  costTrack.loadPricingFromEnv();
  // P2（2026-10-12）：建 **model 级**价表。
  // 必须在 loadPricingFromEnv 之后（proxy 级是它的 fallback 兜底档）、loadLedger 之前
  // （历史行里的模型要先有价才拆得出账）。读失败只打一行，不阻塞启动。
  //
  // 🔴 读**两个**文件（顺序决定覆盖优先级）：
  //   ① providers.json —— manager UI 的 provider 注册表，实测**没有 models[]**（loaded=0），
  //      但保不准哪天 UI 加上了，所以照读（0 条也正常，不算错）。
  //   ② pricing.json   —— 专门的价表（扁平形状），**它才是真正在用的那份**。
  //      之所以不直接往 providers.json 里补 models[]：那是 manager UI 的产出，随时被覆写。
  const stateDir = path.join(os.homedir(), '.multi-proxy-manager');
  const pricingLoaded = costTrack.loadPricingFromProviders([
    path.join(stateDir, 'providers.json'),
    path.join(stateDir, 'pricing.json'),
  ]);
  if (pricingLoaded.loaded) {
    console.log(`[cost] model pricing loaded: ${pricingLoaded.loaded} models`);
  } else {
    const why = (pricingLoaded.errors || []).map((e) => `${path.basename(e.file)}: ${e.reason}`).join(' | ');
    console.log(`[cost] model pricing 未加载（${why}）—— 取价回落到 per-proxy / unknown`);
  }
  // P3：分时档配置体检。运行期对畸形一律 fail-safe 走标准价（安全），但**畸形必须
  // 报出来** —— 「配了却静默不生效」是最难查的一类错账（与「宁可留个明处的缺口」同纪律）。
  const schedProblems = costTrack.validatePricingSchedule();
  for (const p of schedProblems) {
    console.warn(`[cost] ⚠️ 分时档配置有问题（model=${p.model}），将恒收标准价：`);
    for (const msg of p.problems) console.warn(`        - ${msg}`);
  }
  // 持久账本：读回历史（无账本文件 / 门控关 / 读失败都返回 0，不算错，不阻塞启动）
  const ledgerRows = costTrack.loadLedger();
  if (ledgerRows) console.log(`[cost] ledger loaded: ${ledgerRows} rows from ${costTrack.ledgerFile()}`);
  // M2：门控开时把内置 writeMarkers 注册进活跃表 → 真执行写隔离 sidecar；门控关保持默认 observe（executors=[] 不真动作）。
  if (isolationExecutor.isolationEnabled()) {
    isolationExecutor.registerExecutor('writeMarkers');
    console.log('[isolation] M2 executor active: writeMarkers registered (PROXY_HEALTH_ISOLATE=on; flipEnabled=null → 不flip providers.json)');
  }
  // B 类链路启动自检：把门控状态打出来，避免「接线了但没人知道开没开」。
  const guardProbe = new SideEffectGuard({ enabled: null });
  if (guardProbe.enabled) {
    console.log('[side-effect-guard] ACTIVE — step/resume 走权限门禁 + 幂等查证；对账端点 /api/sessions/reconcile*');
    if (guardProbe.audit.enabled) {
      console.log(`[side-effect-guard] audit ledger: ${guardProbe.audit.file}`);
    } else {
      // ⚠️ 配置陷阱：编排层开、账本关 → record 全部 no-op → 幂等查证永远查不到历史、
      //    对账无据可查。链路看起来在跑，实际形同虚设，且不报错。必须显式喊出来。
      console.log('[side-effect-guard] ⚠️ 账本未开（MULTI_PROXY_ACTION_AUDIT≠1）→ 幂等查证查不到历史、对账无据，链路形同虚设；请改开: MULTI_PROXY_ACTION_AUDIT=1');
    }
  } else {
    console.log('[side-effect-guard] off（默认）— step/resume 与接线前一致；开: npm run start:guard');
  }
  // 业务侧端点总是挂载（before/record 受同一门控，pending/reconcile 只读不受控）
  console.log(`[side-effect-guard-business] endpoints mounted at /api/guard（ledger: ${guardBusinessRoutes.BUSINESS_GUARD_DIR}；门控 MULTI_PROXY_SIDE_EFFECT_GUARD 同控）`);
  // h3web Guard 启动期自检：下游本地服务没起就**喊出来**（这是「提醒我」的落地）。
  // 严格只读（只 GET /，绝不 /api/gen），异步不阻塞启动；探活失败也只是不提醒，不影响面板。
  const h3webGuard = require('./lib/h3web-guard');
  h3webGuard.snapshot().then(function (s) {
    if (s.up) {
      console.log(`[h3web-guard] h3web up on 127.0.0.1:${s.port}（L2 executor 通道可用）`);
    } else {
      console.log(`[h3web-guard] ⚠️ ${s.advice.message}`);
      if (s.advice.action) {
        console.log(`[h3web-guard]    手动起: ${s.advice.action.command}`);
        console.log(`[h3web-guard]    一键起: PROXY_H3WEB_AUTOSTART=1 启动本面板 → POST /api/h3web/start`);
      }
    }
  }).catch(function () { /* 探活失败不算启动错误 */ });
  const costScheduler = alertRoutes.startCostScheduler();
  // 管理面板默认只绑本回环 127.0.0.1（安全收紧：面板带 JWT 但不应全网卡可达）；
  // Docker/跨机部署显式设 BIND_HOST=0.0.0.0，沿用 hermes-proxy 的 BIND_HOST 惯例。
  const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
  app.listen(PORT, BIND_HOST, () => {
    if (!['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(BIND_HOST)) {
      console.warn(`[security] BIND_HOST=${BIND_HOST} 非回环地址：管理台将对该网络可达方开放。` +
        '请确认 MANAGER_PASSWORD 已设置、且防火墙/反向代理已加访问控制。');
    }
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
