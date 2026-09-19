---
type: adr
status: proposed
date: 2026-09-19
title: L2 MCP Bridge 设计（JSON-RPC over stdio）
---

# ADR-002 MCP Bridge 设计

## 背景
adapter-protocol.md §「协议分层」确定：

- 主流 agent（Codex/Cursor）→ **MCP（零改造）**
- 本地 Web 服务（h3web）→ HTTP
- 通用兜底 → 文件队列

现状：`l2/` 有 Agent Registry + Plugin Runtime + Route Engine + Orchestrator，
但缺 **MCP 服务端代码**——adapter-protocol.md 只定义了 HTTP/MCP/文件三种
传输层之一，尚未实现。

本 ADR 定义 MCP Bridge 的最小实现，把 RouteEngine 的能力声明与任务路由
暴露为 MCP JSON-RPC 2.0 接口。

## 设计决策

### 1. 传输层
- 默认 **stdio**（MCP 规范默认）：stdin 进 JSON-RPC request，stdout 出 JSON-RPC response。
- 支持 **内存注入**（`handleMessage(msg) → response`）供测试，无需真开管道。

### 2. 消息协议（JSON-RPC 2.0）
```jsonc
// 请求
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"h3web","arguments":{}}}
{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"clientName":"test"}}
{"jsonrpc":"2.0","id":4,"method":"ping"}

// 成功响应
{"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
{"jsonrpc":"2.0","id":3,"result":{"protocolVersion":"2025-03-26","capabilities":{...}}}

// 错误响应
{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"Method not found"}}
```

### 3. 路由映射
| MCP method   | RouteEngine 映射                              |
|--------------|----------------------------------------------|
| `tools/list` | `registry.list()` + `pluginRuntime.listCapabilities()` → 转 MCP tool schema |
| `tools/call` | `routeEngine.route()` → 选中 adapter → 执行（经 `_execute` 注入 executor，支持 shadow）|
| `initialize` | 返回 `protocolVersion` + `serverInfo`         |
| `ping`       | 返回 `null`（MCP 规范 health check）           |

### 4. 非侵入 + 门控
- `PROXY_L2_MCP` 默认 0，server 不暴露任何 HTTP 端口。
- 启动仅经 `PROXY_L2_MCP=1 node l2/mcp-server.js`（需显式开）。
- 不写 agent 文件，不触 adapter real 执行（shadow 默认）。
- 仅消费 AgentRegistry 只读视图 + RouteEngine 路由决策输出。

### 5. 零依赖
- 仅 `process.stdin/stdout` + `JSON`（Node stdlib），不引第三方 MCP SDK。
- JSON-RPC 2.0 消息格式内嵌于 `mcp-server.js`，约 150 行，测试覆盖。

## E2E 验证路径
1. `node l2/mcp-server.demo.js`（stdin 模拟 JSON-RPC 消息，断言 response shape + tool list）
2. `jest l2/mcp-server.test.js`（jest 测 `handleMessage` + `tools/list` + `tools/call`）
3. 门控关：`PROXY_L2_MCP!=1` 时 `startStdio()` 抛 `Error('mcp gate closed')`

## 后续
- P3b：加 `GET /adapter/health` HTTP 暴露（供 manager dashboard 探活）。
- P3c：支持真实 MCP stdio 管道 + 外部客户端（Hermes / Codex CLI 接入）。
- P3d：加 `tools/call` 的 retry/fallback 支持（接 orchestrator 的 `_execute` 链）。
