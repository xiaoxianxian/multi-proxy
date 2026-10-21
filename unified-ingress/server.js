#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// unified-ingress · 单端点接入层（设计文档 94-OOBE §O8）
//
// 动机：multi-proxy 当前是「N 个服务 N 个端口」（codex 18790 / claude 18791 / manager 18792 / …）。
//   对每个 agent 逐个配 base_url 是认知与运维负担。本层在 18880 收口所有协议，按路径把请求
//   分发到对应后端 proxy，让 agent 只记一个 endpoint：
//     /v1/messages          → claude-proxy   (Anthropic 原生，Claude Code)
//     /v1/responses         → codex-proxy    (OpenAI Responses，Codex 默认)
//     /v1/chat/completions  → codex-proxy    (OpenAI 兼容)
//     /v1/models            → codex-proxy    (模型目录)
//     /api/* , /health      → manager        (面板与治理 API)
//
// 设计纪律：
//   - 纯粹转发层，**不改变**任何协议语义（不翻译、不解析 body）——翻译是各后端 proxy 的职责。
//     这样 ingress 永远不会因为协议演进而过时，也不重复造轮子。
//   - 默认 SHADOW / 可选启用：不替换现有服务，不合并架构（守「不早合并」铁律）。
//     现有端口继续可用；要统一入口时才起本进程。
//   - 透传客户端请求头（含 Authorization），后端若设了 PROXY_AUTH_TOKEN 也能正确鉴权。

const http = require('http');
const { URL } = require('url');

// 🔴 默认是 18880，不是 18800：18800 已被 opencode-free 占用（`lsof -nP -iTCP:18800`
//    实测有 node LISTEN），本进程默认起 18800 会 EADDRINUSE。
//    现网与 docs/quickstart.md:53 都是 18880；要换用 INGRESS_PORT 显式覆盖。
const PORT = Number(process.env.INGRESS_PORT || 18880);
const BINDING = process.env.INGRESS_BINDING || '127.0.0.1';
const BACKENDS = {
  codex: process.env.BACKEND_CODEX || 'http://127.0.0.1:18790',
  claude: process.env.BACKEND_CLAUDE || 'http://127.0.0.1:18791',
  manager: process.env.BACKEND_MANAGER || 'http://127.0.0.1:18792',
};

// 纯函数：按路径决定上游。便于单测，不依赖请求对象其它字段。
function routeTarget(pathname) {
  if (pathname === '/v1/messages') return BACKENDS.claude;
  if (pathname === '/v1/responses' || pathname === '/v1/chat/completions' || pathname === '/v1/models') return BACKENDS.codex;
  if (pathname.startsWith('/api/') || pathname === '/health') return BACKENDS.manager;
  // 默认走 OpenAI 兼容面（绝大多数 agent 走这条）
  return BACKENDS.codex;
}

function proxyRequest(req, res) {
  const pathname = req.url.split('?')[0];
  const target = routeTarget(pathname);
  const u = new URL(target);
  const options = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port,
    method: req.method,
    path: req.url,
    // 透传客户端头（含 Authorization）；host 改写为后端，避免虚拟主机误判
    headers: { ...req.headers, host: u.host },
  };

  const upstream = http.request(options, (upRes) => {
    // 直接透传状态码 + 头 + 体（含 SSE 流式：不缓冲）
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'bad_gateway', detail: e.message }));
  });

  req.on('error', () => { try { upstream.destroy(); } catch { /* noop */ } });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  try {
    proxyRequest(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'ingress_error', detail: e.message }));
  }
});

if (require.main === module) {
  server.listen(PORT, BINDING, () => {
    console.log(`[unified-ingress] listening on ${BINDING}:${PORT}`);
    console.log(`[unified-ingress] backends: codex=${BACKENDS.codex} claude=${BACKENDS.claude} manager=${BACKENDS.manager}`);
  });
}

module.exports = { server, routeTarget, BACKENDS, PORT };
