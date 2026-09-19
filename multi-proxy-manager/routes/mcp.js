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
    const { AgentRegistry } = require('../../l2/agent-registry.js');
    const { PluginRuntime } = require('../../l2/plugin-runtime.js');
    const reg = new AgentRegistry();
    // seed 本地默认能力，使 tools/call 能路由到真实 adapter（与 mcp-server.js require.main 一致）
    reg.create({ id: 'h3web',  name: 'H3Web', type: 'custom', adapterId: 'h3web',
                 capabilityTags: ['video', 'text2video', 'image'], description: 'H3Web 文/图/视频本地引擎' });
    reg.create({ id: 'codex',  name: 'Codex', type: 'codex', adapterId: 'codex',
                 capabilityTags: ['code', 'review'],              description: 'Codex 代码 agent' });
    _server = new McpServer({
      registry: reg,
      pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }),
      gate: String(process.env.PROXY_L2_MCP || '0'),
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

// POST /api/mcp/call — 调工具（shadow）
router.post('/call', (req, res) => {
  const s = server();
  const name = req.body && req.body.name;
  if (!name) return res.status(400).json({ error: 'missing tool name' });
  try {
    const result = s.callTool(name, req.body.arguments);
    res.json({ ok: true, tool: name, result });
  } catch (e) {
    // error 带 JSON-RPC 错误码
    const code = (e && typeof e.code === 'number') ? e.code : -32603;
    res.status(422).json({ error: e && e.message || String(e), code, data: e && e.data });
  }
});

// POST /api/mcp/rpc — 透传一条 JSON-RPC 2.0 消息（兼容外部 MCP 客户端）
router.post('/rpc', (req, res) => {
  const s = server();
  try {
    const resp = s.handleMessage(req.body);
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
