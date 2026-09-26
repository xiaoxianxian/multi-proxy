'use strict';

// L2 P3 · MCP Bridge 生产接线 — /api/mcp 把 l2/mcp-server.js 接上 manager。
//
// 设计（与 alert.js / orchestration.js 门控路由同构）：
//   门控 PROXY_L2_MCP 默认 0 → 全部路由 403，热路径零副作用。
//   开启 = 显式 opt-in：PROXY_L2_MCP=1 node server.js
//
// 非侵入铁律：
//    - 路由仅暴露 MCP bridge 的「只读查询 + 路由决策」（tools/list + tools/call shadow）。
//    - 不触 adapter real 执行（shadow 默认，ADR-0004-mcp-bridge 铁律），不写 agent 文件。
//    - 长寿命单例：模块加载时建一次 McpServer，跨请求复用。
//
// 路由面：
//   GET  /api/mcp          → 门控状态 + 已注册 MCP 工具列表（能力快照）
//   GET  /api/mcp/health   → 探活：{status, gate, protocolVersion, toolCount}
//   POST /api/mcp/call     → 调工具 {name, arguments?} → 转 mcp bridge callTool（shadow）
//   POST /api/mcp/rpc      → 透传一条 JSON-RPC 2.0 消息 → handleMessage（兼容外部 MCP 客户端）

const express = require('express');
const router = express.Router();

// 模块级长寿命单例（门控开时复用；403 时不暴露 server 细节）
let _server = null;
function server() {
  if (!_server) {
    const { McpServer } = require('../../l2/mcp-server.js');
    const { PluginRuntime } = require('../../l2/plugin-runtime.js');
    // Step 1：注入 registry.js 的进程级共享单例，不再自造 → 消除 registry 分裂。
    // getSharedRegistry() 在 count()===0 时幂等 seed（与 gateway.js 共用同一 seed 来源）。
    const { getSharedRegistry } = require('./registry');
    const reg = getSharedRegistry();
    // ④ P0→P1：promptCache 注入缝（门控 PROXY_PROMPT_CACHE 默认 off → 不注入 → 零回归）。
    // 注入后 McpServer.listTools() 暴露 cache_stats 工具 + orchestrate 附 cacheObservation sidecar。
    let promptCache = undefined;
    if (['1', 'true', 'on'].includes(String(process.env.PROXY_PROMPT_CACHE || '').toLowerCase())) {
      const { createPromptCache } = require('../../l2/prompt-cache.js');
      promptCache = createPromptCache({ gate: true });    // 门控开 = observe（不落盘）
      }
    _server = new McpServer({
      registry: reg,
      pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }),
      gate: String(process.env.PROXY_L2_MCP || '0'),
      promptCache,
      });
  }
  return _server;
}

// 测试隔离钩子
router._reset = () => { _server = null; };

// 门控守卫：关 → 403
function guard(req, res, next) {
  if (!server().isGateOpen()) {
    return res.status(403).json({ error: 'mcp gate closed', hint: 'set PROXY_L2_MCP=1 to enable' });
  }
  next();
}

router.use(guard);

// GET /api/mcp — 状态 + 工具列表
router.get('/', (req, res) => {
  const s = server();
  res.json({
    status: 'ok',
    gate: 'open',
    protocolVersion: s.protocolVersion,
    serverInfo: s.initialize().serverInfo,
    tools: s.listTools(),
  });
});

// GET /api/mcp/health — 轻量探活
router.get('/health', (req, res) => {
  const s = server();
  res.json({
    status: 'ok',
    gate: s.isGateOpen() ? 'open' : 'closed',
    protocolVersion: s.protocolVersion,
    toolCount: s.listTools().length,
  });
});

// POST /api/mcp/call — 调工具（shadow · Step 2 统一走 async 分派）
router.post('/call', async (req, res) => {
  const s = server();
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ error: 'missing tool name' });
  try {
    // Step 2：callToolAsync 对非 async 工具委托回同步 callTool（行为超集），
    // 对 orchestrate/decompose 走 async 路径（修复 -32602 P2-2）。
    const result = await s.callToolAsync(name, req.body.arguments);
    res.json({ ok: true, tool: name, result });
  } catch (e) {
    // error 带 JSON-RPC 错误码
    const code = (e && typeof e.code === 'number') ? e.code : -32603;
    res.status(422).json({ error: e && e.message || String(e), code, data: e && e.data });
  }
});

// POST /api/mcp/rpc — 透传一条 JSON-RPC 2.0 消息（兼容外部 MCP 客户端）
router.post('/rpc', async (req, res) => {
  const s = server();
  try {
    // Step 2：handleMessageAsync 是 handleMessage 的超集，tools/call 走 callToolAsync
    //（支持 orchestrate 等 async 工具），其余 method 行为与同步一致。
    const resp = await s.handleMessageAsync(req.body);
    if (resp === null) return res.status(204).send(); // notification
    res.json(resp);
  } catch (e) {
    if (/gate closed/.test((e && e.message) || '')) {
      return res.status(403).json({ error: 'mcp gate closed' });
     }
    res.status(400).json({ error: e && e.message || String(e) });
  }
});

module.exports = router;
