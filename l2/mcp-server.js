#!/usr/bin/env node
'use strict';

// L2 P3 · MCP Bridge（JSON-RPC 2.0 over stdio）
// ADR-002：把 AgentRegistry 能力 + RouteEngine 路由暴露为标准 MCP 工具。
// 零依赖：仅 process.stdin/stdout + JSON，不引第三方 MCP SDK。
// 门控：PROXY_L2_MCP!=1 时 startStdio() 抛出 'mcp gate closed'。

const { AgentRegistry } = require('./agent-registry.js');
const { PluginRuntime } = require('./plugin-runtime.js');
const { RouteEngine } = require('./route-engine.js');

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'l2-mcp-bridge', version: '0.1.0' };

// MCP JSON-RPC 2.0 error codes
function rpcError(code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return err;
}

function okResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function errResponse(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: rpcError(code, message, data) };
}

// 把 AgentRegistry 的能力映射为 MCP tool schema
function toMcpTool(adapter, registry) {
  const profile = registry.get(adapter.adapterId);
  return {
    name: adapter.adapterId,
    description: (profile && profile.description) || `Agent profile: ${adapter.adapterId}`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task prompt or input text' },
        task:   { type: 'string', description: 'Task type (text/code/video/...)'},
      },
      required: [],
    },
  };
}

class McpServer {
  // 门控默认关（非侵入铁律）：gate 缺省时读 PROXY_L2_MCP，再缺省 '0'（关）。
  // 只有显式 gate='1' 或 env=1 才开；构造器不再默认 '1'。
  constructor({ registry, routeEngine, gate } = {}) {
    this.registry = registry || new AgentRegistry();
    this.routeEngine = routeEngine || new RouteEngine({
      registry: this.registry,
      pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }),
      shadowMode: true,
     });
    this.gate = (gate !== undefined) ? gate : String(process.env.PROXY_L2_MCP || '0');
    this.protocolVersion = PROTOCOL_VERSION;
    this.initialized = false;
  }

  // 门控检查
  isGateOpen() {
    return this.gate === '1';
  }

  // MCP 生命周期
  initialize(params) {
    this.initialized = true;
    return {
      protocolVersion: this.protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: {},
      },
      serverInfo: SERVER_INFO,
    };
  }

  // 列出全部工具（能力声明）
  listTools() {
    const adapters = this.registry.list();
    const tools = adapters.map(a => toMcpTool(a, this.registry));
    // 加上 L2 原生工具：routeTask（暴露路由决策能力）
    tools.push({
      name: 'routeTask',
      description: 'Route a task to the best agent via L2 RouteEngine. Returns routing decision.',
      inputSchema: {
        type: 'object',
        properties: {
          type:   { type: 'string', description: 'Task type: text/code/video/audio/image' },
          prompt: { type: 'string', description: 'Task prompt' },
          agent:  { type: 'string', description: 'Prefer agent (optional)' },
          complexity: { type: 'string', enum: ['low','medium','high','trivial','complex'] },
        },
        required: ['type'],
      },
    });
    return tools;
  }

  // 调用工具
  callTool(name, args) {
    const a = args || {};
    if (name === 'routeTask') {
      const task = {
        id: a.id || 'mcp-call',
        type: a.type,
        prompt: a.prompt || '',
        agent: a.agent,
        complexity: a.complexity,
      };
      // 非 shadow 时不真执行（ADR-002 铁律：adapter real 须单独授权），仅返回路由决策
      const decision = this.routeEngine.route(task);
      const chosen = decision && decision.chosen;
      return {
        task: task.id,
        shadow: true,
        route: {
          chosen: chosen ? {
            adapterId: chosen.adapterId,
            source: chosen.source,
            confidence: chosen.confidence,
          } : null,
          candidates: (decision && decision.candidates || []).map(c => ({
            adapterId: c.adapterId,
            source: c.source,
            confidence: c.confidence,
            tierMatch: c.tierMatch,
            modelTypeMatch: c.modelTypeMatch,
          })),
          fallback: !!(chosen && chosen.fallback),
          reason: chosen ? chosen.reason : decision.message,
        },
      };
    }
    // 其他 tool：返回 adapter 能力快照（不真执行）。
    // registry.get 对未知 key 会抛，需兜住转 -32602（带 available 列表）。
    let adapter;
    try {
     adapter = this.registry.get(name);
    } catch (_) {
     throw rpcError(
        -32602,
        `Tool not found: ${name}`,
        { available: this.registry.list().map(a => a.adapterId) }
      );
    }
    if (!adapter) {
     throw rpcError(
        -32602,
        `Tool not found: ${name}`,
        { available: this.registry.list().map(a => a.adapterId) }
      );
    }
    return {
      adapter: name,
      shadow: true,
      capability: adapter,
      note: 'Shadow mode: no real execution. Enable PROXY_ADAPTER_REAL for real run.',
    };
  }

  // 主分发：一条 MCP JSON-RPC 消息进，一条响应出
  handleMessage(msg) {
    // 门控关闭时拒绝所有消息
    if (!this.isGateOpen()) {
      throw new Error('mcp gate closed: set PROXY_L2_MCP=1 to enable');
    }

    if (!msg || msg.jsonrpc !== '2.0') {
      const id = (msg && msg.id) || null;
      return errResponse(id, -32600, 'Invalid Request: missing jsonrpc=2.0');
    }

    const { id, method, params } = msg;
    // Notification（无 id）不返回响应，仅初始化/日志
    if (method === 'notifications/initialized' || method === 'initialized') return null;

    switch (method) {
      case 'initialize':
        return okResponse(id, this.initialize(params));

      case 'ping':
        return okResponse(id, null);  // MCP 规范：ping 回 null result

      case 'tools/list':
        return okResponse(id, { tools: this.listTools() });

      case 'tools/call': {
        const name = params && params.name;
        const args = params && params.arguments;
        if (!name) return errResponse(id, -32602, 'Missing tool name');
        try {
          const result = this.callTool(name, args);
          return okResponse(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
          if (e && typeof e.code === 'number') {
            return errResponse(id, e.code, e.message, e.data);
          }
          return errResponse(id, -32603, 'Tool execution failed: ' + (e && e.message || String(e)));
        }
      }

      default:
        return errResponse(id, -32601, `Method not found: ${method}`);
    }
  }

  // stdio 入口（生产用）
  startStdio() {
   if (!this.isGateOpen()) {
     throw new Error('mcp gate closed: set PROXY_L2_MCP=1 to enable');
    }
    // 从 stdin 逐行读 JSON-RPC 消息
   const readline = require('readline');
   const rl = readline.createInterface({ input: process.stdin });
   rl.on('line', line => {
     if (!line.trim()) return;
     try {
       const msg = JSON.parse(line);
       const resp = this.handleMessage(msg);
       if (resp !== null) {
         process.stdout.write(JSON.stringify(resp) + '\n');
         process.stdout.flush();
        }
      } catch (e) {
        // 解析失败的行输出 -32700 parse error
       const id = null;
       try { const m = JSON.parse(line); id = m && m.id; } catch (_) { /* 保持 null */ }
       process.stdout.write(
         JSON.stringify(errResponse(id, -32700, 'Parse error: ' + (e && e.message || String(e)))) + '\n'
        );
      }
    });
   return rl; // 返回接口以便调用方/单测关闭 stdin（避免 main 进程挂起）
   }
}

module.exports = {
  McpServer,
  PROTOCOL_VERSION,
  SERVER_INFO,
  rpcError,
  okResponse,
  errResponse,
};

// 直接 node l2/mcp-server.js 时以 stdio 模式启动（门控 PROXY_L2_MCP=1）
if (require.main === module) {
  const { AgentRegistry } = require('./agent-registry.js');
  const { PluginRuntime } = require('./plugin-runtime.js');
  // 默认 seed 本地 h3web + codex 能力，使 routeTask / tools/call 能路由到真实 adapter
  const reg = new AgentRegistry();
  reg.create({ id: 'h3web',  name: 'H3Web', type: 'custom', adapterId: 'h3web',
               capabilityTags: ['video', 'text2video', 'image'], description: 'H3Web 文/图/视频本地引擎' });
  reg.create({ id: 'codex',  name: 'Codex', type: 'codex',  adapterId: 'codex',
               capabilityTags: ['code', 'review'],              description: 'Codex 代码 agent' });
  const server = new McpServer({ gate: process.env.PROXY_L2_MCP || '0', registry: reg,
      pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }), shadowMode: true });
  const rl = server.startStdio();
  rl.on('close', () => process.exit(0)); // stdin EOF（客户端断开）即退出
  process.stderr.write('[l2-mcp] bridge started on stdio\n');
}
