#!/usr/bin/env node
'use strict';

// L2 P3 · MCP Bridge（JSON-RPC 2.0 over stdio）
// ADR-0004-mcp-bridge：把 AgentRegistry 能力 + RouteEngine 路由暴露为标准 MCP 工具。
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

// ---- P3 option3 二期 · LLM 拆解真接线（镜像 routes/orchestration.js，非侵入）----
// 门控 PROXY_LLM_DECOMPOSE ∈ {1,true,on}：开 → MCP orchestrate 在「内置模板拆解」前先尝试
// LLM 拆解；缺省关 → 行为与既有 22 例完全一致（零 LLM 依赖、确定可复现、零回归）。
// 与 HTTP 路由同构：复用 l2/llm-decomposer.js 的 makeLlmDecomposer（内核内已带失败降级，
// LLM 不可达/坏 JSON/自环一律回退内置模板，绝不冒泡），LLM 拆解仅发生在 shadow 前置。
function isLlmDecomposeOpen() {
  const v = String(process.env.PROXY_LLM_DECOMPOSE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
// LLM 拆解连接配置（全部来自 env，缺省走内核默认 127.0.0.1:11434；与 HTTP 路由 buildLlmCfg 同款）
function buildMcpLlmCfg() {
  return {
    baseUrl: process.env.PROXY_LLM_BASE_URL || undefined,
    model: process.env.PROXY_LLM_MODEL || undefined,
    token: process.env.PROXY_LLM_TOKEN || undefined,
    timeoutMs: process.env.PROXY_LLM_TIMEOUT_MS ? Number(process.env.PROXY_LLM_TIMEOUT_MS) : undefined,
    };
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
        task:    { type: 'string', description: 'Task type (text/code/video/...)'},
      },
      required: [],
      },
    };
}

class McpServer {
  // 门控默认关（非侵入铁律）：gate 缺省时读 PROXY_L2_MCP，再缺省 '0'（关）。
  // 只有显式 gate='1' 或 env=1 才开；构造器不再默认 '1'。
  constructor({ registry, routeEngine, gate, executor = null, realGate } = {}) {
    this.registry = registry || new AgentRegistry();
    this.routeEngine = routeEngine || new RouteEngine({
      registry: this.registry,
      pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }),
      shadowMode: true,
      });
    this.gate = (gate !== undefined) ? gate : String(process.env.PROXY_L2_MCP || '0');
    // 二级门控 PROXY_ADAPTER_REAL（默认 0=关）：orchestrate 真执行（真调 adapter / 注入 executor）须显式开。
    // 非侵入铁律：缺省保持 shadow（不触碰下游 adapter），与 PROXY_L2_MCP（bridge 开/关）解耦。
    this.realGate = (realGate !== undefined) ? realGate : String(process.env.PROXY_ADAPTER_REAL || '0');
    // 真执行器（注入缝）：(subtask, ctx) => 结果。缺省 null → orchestrate 始终 shadow（零行为变更）；
    // 生产/standalone 由 require.main 按 PROXY_ADAPTER_REAL 用 _realExecutor 注入（路由选中 adapter）。
    this.executor = (typeof executor === 'function') ? executor : null;
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
          type:    { type: 'string', description: 'Task type: text/code/video/audio/image' },
          prompt: { type: 'string', description: 'Task prompt' },
          agent:   { type: 'string', description: 'Prefer agent (optional)' },
          // 复杂度词表与 l2/COMPLEXITY-MODE.md §2.2 / decomposer.js 对齐：low/medium/high
          // （_mapTier 只认这三值，high→large / low→small / 其余→medium；不声明无实际语义的 trivial/complex）
          complexity: { type: 'string', enum: ['low','medium','high'],
                       description: 'Task complexity, drives model-tier selection: low→small, medium→medium, high→large' },
          },
        required: ['type'],
        },
      });
    // L2 编排能力暴露为 MCP 工具（ADR-0004-mcp-bridge：只读查询 + 决策，默认 shadow 不真执行）
    //   decompose：把一个请求拆解成子任务 DAG（同步、确定性、零 LLM）—— 暴露 decomposer 能力。
    //   orchestrate：跑一个 DAG（或先拆解再跑）—— 暴露 orchestrator 能力。默认 shadowMode=true，
    //   只产出调度/路由决策，不触碰真实 adapter（非侵入铁律 + ADR-0004 shadow 默认开）。
    //   注意：orchestrate 本质 async（DAG 并发调度），故经 callToolAsync/handleMessageAsync 暴露；
    //   同步 callTool/handleMessage 保持纯同步、不回归（见下）。
    tools.push({
      name: 'decompose',
      description: 'Decompose a request into a subtask DAG (nodes + dependency edges) via L2 Decomposer. Synchronous, deterministic, rule-based; no LLM. Returns {template, subtasks, edges}.',
      inputSchema: {
        type: 'object',
        properties: {
          input:   { type: 'string', description: 'User request to decompose (e.g. "做一个视频短片" / "jwt 认证")' },
          },
        required: ['input'],
        },
      });
    tools.push({
      name: 'orchestrate',
      description: 'Run a subtask DAG (or decompose a request first) via L2 Orchestrator. Shadow-only: produces scheduling/routing decisions without executing real adapters. Returns {template, subtasks, report}. Async (concurrent DAG schedule).',
      inputSchema: {
        type: 'object',
        properties: {
          input:       { type: 'string',  description: 'Request to decompose+run (omit if dag given)' },
          dag:         { type: 'object',  description: 'Pre-built DAG {input, template, subtasks, edges} (skips decomposition)' },
          shadowMode: { type: 'boolean', description: 'Shadow mode. Default true unless PROXY_ADAPTER_REAL gate is enabled; can be forced per-call.' },
          maxRetries: { type: 'number',  description: 'Retry count per subtask on failure (default 1)' },
          llm:         { type: 'boolean',  description: 'LLM decompose this request first. Effective only when gate PROXY_LLM_DECOMPOSE is on (or per-call true); otherwise falls back to built-in template. LLM failure degrades to template silently.' },
          },
        required: [],
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
      // 非 shadow 时不真执行（ADR-0004-mcp-bridge 铁律：adapter real 须单独授权），仅返回路由决策
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
    const real = this.realGate === '1';
    return {
      adapter: name,
      shadow: !real,
      capability: adapter,
      // 二级门控 PROXY_ADAPTER_REAL 开启时，真执行器经 _realExecutor 路由选中 adapter（非侵入：只算「该谁来跑」，不触下游）；
      // 缺省关 → 仅路由决策、不触下游。
      note: real
        ? 'Real execution enabled (PROXY_ADAPTER_REAL=1): subtask routed to an adapter via the gate.'
        : 'Shadow mode: no real execution. Enable PROXY_ADAPTER_REAL for real run.',
        };
  }

  // 真执行器（注入缝）：非侵入——经 routeEngine.route 路由选中该子任务的 adapter 后，
  // 委托 this.executor 执行；无 executor 时退化为「仅路由、记录选中 adapter」（不触下游）。
  // 由 require.main 在 PROXY_ADAPTER_REAL 开启时注入；测试可注入任意 executor 做 E2E。
  _realExecutor() {
   const self = this;
   return async function (subtask, ctx) {
     const decision = self.routeEngine.route({ ...subtask });
     const chosen = decision && decision.chosen;
     const base = { subtaskId: subtask.id, routedAdapterId: chosen ? chosen.adapterId : null };
     if (typeof self.executor === 'function') {
       try {
         const value = await self.executor(chosen ? chosen.adapterId : null, subtask, ctx);
         return Object.assign(base, { status: 'executed', value });
         } catch (e) {
         return Object.assign(base, { status: 'failed', error: e && e.message || String(e) });
         }
       }
      return Object.assign(base, { status: 'routed' });
     };
    }

  // 异步工具分发：orchestrate 本质 async（DAG 并发调度），其余工具委托同步 callTool（行为不变）。
  // 与 callTool/handleMessage 并存：同步路径纯同步、零回归；本路径只承载 async 工具。
  async callToolAsync(name, args) {
    const a = args || {};
    if (name === 'orchestrate') {
      const { Orchestrator } = require('./orchestrator.js');
      // 二级门控 PROXY_ADAPTER_REAL（默认关，非侵入）是真执行的唯一权威：
      //   门控关 → 恒 shadow（不触下游 adapter；per-call shadowMode 不可绕过门控）。
      //   门控开 → 缺省真执行（缺省 shadowMode=false），per-call shadowMode:true 可强制回 shadow。
      const gateOn = this.realGate === '1';
      const shadowMode = gateOn
         ? (a.shadowMode !== undefined ? (a.shadowMode === true) : false)
         : true;
      const orch = new Orchestrator({
      shadowMode,
      executor: shadowMode ? undefined : this._realExecutor(),
        });
      // P3 option3 二期 · LLM 拆解真接线：门控 PROXY_LLM_DECOMPOSE（env）或 per-call a.llm===true 才介入；
      //   缺省关 → 走内置模板拆解（既有行为、零 LLM 依赖、零回归）。与 PROXY_ADAPTER_REAL 正交
      //   （后者管 adapter 真执行，前者管拆解器）；LLM 拆解只产 DAG（数据），shadow 前置，绝不触碰下游。
      const useLlm = isLlmDecomposeOpen() || (a.llm === true);
      // 有预置 dag → 直供（跳过拆解；LLM 不介入）；否则按门控选 LLM 拆解 / 内置模板拆解
      const maxRetries = (a.maxRetries != null) ? Number(a.maxRetries) : undefined;
      const input = a.input || a.prompt || '';
      let out;
      let decomposeSource = null;     // 仅 LLM 路径填充：'llm' / 'template(<reason>)'(失败降级时)
      if (a.dag && Array.isArray(a.dag.subtasks) && a.dag.subtasks.length > 0) {
       out = await orch.run(a.dag, { maxRetries, ctx: a.ctx });
       } else if (useLlm) {
         // 镜像 routes/orchestration.js：makeLlmDecomposer cfg 从 env，内核内已带失败降级
         //（LLM 不可达 / 坏 JSON / 自环一律回退 templateDecompose，绝不冒泡）
       const { makeLlmDecomposer } = require('./llm-decomposer.js');
       const llmDecompose = makeLlmDecomposer(buildMcpLlmCfg());
       const dag = await llmDecompose(input, { input });
       decomposeSource = (dag && dag.meta) ? dag.meta.source : 'llm';
       out = await orch.run(dag, { maxRetries, ctx: a.ctx });
       } else {
         // 默认：内置模板拆解（确定性、零 LLM 依赖）
       out = await orch.runFromInput(input, { maxRetries, ctx: a.ctx });
       }
      const result = {
       shadow: shadowMode,
       template: out.history ? out.history.template : null,
       subtasks: (out.history ? out.history.subtasks : []).map((s) => ({ id: s.id, type: s.type, status: s.status })),
       report: out.report ? out.report.json : null,
         };
      if (decomposeSource !== null) {
        // 观测：实际走的是 LLM 还是降级回模板；LLM 成功 → 'llm'，失败 → 'template(<reason>)'。
        // 直供 dag 路径 LLM 不介入 → decomposeSource 恒 null → 不发射该字段（保持 UC4 直供语义）。
        result.decomposeSource = decomposeSource;
        }
      return result;
      }
    if (name === 'decompose') {
      const { templateDecompose } = require('./decomposer.js');
      const input = a.input || a.prompt || '';
      if (!String(input).length) {
        throw rpcError(-32602, 'decompose: missing input',
           { hint: 'pass arguments.input (the request text to decompose)' });
        }
      return { shadow: true, ...templateDecompose(input, { templates: a.templates }) };
     }
    // 其余工具（adapter 能力 + routeTask）同步执行路径不变
    return this.callTool(name, args);
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
        return okResponse(id, null);   // MCP 规范：ping 回 null result

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

  // 异步主分发：与 handleMessage 同构，但 tools/call 走 callToolAsync（承载 orchestrate 等 async 工具）。
  // 其余方法（initialize/ping/tools/list/notification）与同步路径行为完全一致。
  async handleMessageAsync(msg) {
    // 门控关闭时拒绝所有消息（与 handleMessage 同）
    if (!this.isGateOpen()) {
      throw new Error('mcp gate closed: set PROXY_L2_MCP=1 to enable');
      }
    if (!msg || msg.jsonrpc !== '2.0') {
      const id = (msg && msg.id) || null;
      return errResponse(id, -32600, 'Invalid Request: missing jsonrpc=2.0');
      }
    const { id, method, params } = msg;
    if (method === 'notifications/initialized' || method === 'initialized') return null;
    switch (method) {
      case 'initialize':
        return okResponse(id, this.initialize(params));
      case 'ping':
        return okResponse(id, null);
      case 'tools/list':
        return okResponse(id, { tools: this.listTools() });
      case 'tools/call': {
        const name = params && params.name;
        const args = params && params.arguments;
        if (!name) return errResponse(id, -32602, 'Missing tool name');
        try {
          const result = await this.callToolAsync(name, args);
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
         if (typeof process.stdout.flush === 'function') process.stdout.flush();
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

  // 异步 stdio 入口：与 startStdio 同构，但每行消息走 handleMessageAsync。
  // 承载 orchestrate 等 async 工具（initialize/ping/tools/list/notification 行为与同步路径完全一致，
  // handleMessageAsync 是其超集，故不回归；仅新增 async 工具可用）。
  //
  // drain-on-EOF（关键）：async 工具的响应要等异步 round-trip 才写出；若 stdin EOF 立刻
  // process.exit(0)，在飞的响应还没写出就被强杀 → 丢响应（UC2/UC3 现象）。用 pending 集合跟踪
  // 在飞处理，stdin EOF 时等其全部 settle 再 exit；同步 EOF 场景集合恒空 → 立即 exit（行为不变）。
  // 注意：exit 必须由「本入口独占」——调用方（require.main / 测试）不可再挂 eager 的
  // rl.on('close', () => process.exit())，否则 eager exit 会在 drain 的 microtask 之前杀掉进程。
  startStdioAsync() {
   if (!this.isGateOpen()) {
     throw new Error('mcp gate closed: set PROXY_L2_MCP=1 to enable');
     }
   const readline = require('readline');
   const rl = readline.createInterface({ input: process.stdin });
   const pending = new Set();
   rl.on('line', (line) => {
     if (!line.trim()) return;
     const p = (async () => {
       try {
         const msg = JSON.parse(line);
         const resp = await this.handleMessageAsync(msg);
         if (resp !== null) {
           process.stdout.write(JSON.stringify(resp) + '\n');
           if (typeof process.stdout.flush === 'function') process.stdout.flush();
            }
          } catch (e) {
         // 解析失败的行输出 -32700 parse error
         const id = null;
         try { const m = JSON.parse(line); id = m && m.id; } catch (_) { /* 保持 null */ }
         process.stdout.write(
           JSON.stringify(errResponse(id, -32700, 'Parse error: ' + (e && e.message || String(e)))) + '\n'
           );
         }
       })().finally(() => pending.delete(p));
     pending.add(p);
     });
     // stdin EOF：先在飞 async 响应全部 flush 落地，再 exit（不丢响应）；集合空则立即 exit（与原行为一致）。
     rl.on('close', () => {
       Promise.all([...pending])
         .then(() => process.exit(0))
         .catch(() => process.exit(1));
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
  const { seedDefaultProfiles } = require('./mcp-default-seed.js');
   // 默认 seed 本地 adapter（h3web/codex）+ 三档 text-tier profile（complexity 路由落点），
   // 与 manager 接线 routes/mcp.js 共用同一 seed（l2/mcp-default-seed.js 单一来源）。
  const reg = new AgentRegistry();
  seedDefaultProfiles(reg);
  const server = new McpServer({ gate: process.env.PROXY_L2_MCP || '0', registry: reg,
      pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }), shadowMode: true });
   // 二级门控 PROXY_ADAPTER_REAL：开启时编排真执行——非侵入的 _realExecutor 经 routeEngine 路由选中
   // adapter（无注入下游 executor 时退化为「仅路由记录选中 adapter」，绝不触下游/不写 agent 文件）。
   // 缺省关 → orchestrate 保持 shadow。
  if (String(process.env.PROXY_ADAPTER_REAL || '0') === '1') {
    server.executor = undefined;        // 真路由但无下游 executor → _realExecutor 走「仅路由」退化分支
    server.realGate = '1';
   }
  // exit 由 startStdioAsync 的 drain-on-EOF 独占（stdin EOF → 等在飞 async 响应 flush 落地再 exit）。
  // 此处**不再**挂 eager 的 rl.on('close', () => process.exit(0))：它与 drain 是同一 'close' 上的
  // 两个 listener，eager exit(0) 会抢在 drain 的 Promise.all microtask 之前把进程杀掉 → 丢响应。
  const rl = server.startStdioAsync();
  // exit 由 startStdioAsync 的 drain-on-EOF 独占（stdin EOF → 等在飞 async 响应 flush 落地再 exit）。
  // 关键：此处**不注册** rl.on('close', () => process.exit(0))——它与 drain 是同一 'close' 事件上的
  // 两个 listener，eager exit(0) 会抢在 drain 的 Promise.all microtask 之前把进程杀掉 → UC2/UC3 丢响应。
  // readline 已接管 stdin 读取，进程在 drain 完成前由 in-flight 工作 + drain 保活。
  process.stderr.write('[l2-mcp] bridge started on stdio\n');
}
