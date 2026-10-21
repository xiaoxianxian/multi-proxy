// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// unified-ingress 端到端测试：纯路由判定 + 真转发（桩三个后端，spawn 真实 ingress 进程）。
//
// 为什么是 node:test 而不是 jest/supertest（2026-10-22 改写）：
//   仓库根目录没有 package.json、也没有 node_modules（jest 只装在 codex-proxy/ 与
//   cursor-proxy/ 下），`require('supertest')` 在根下直接 MODULE_NOT_FOUND，原测试一行也跑不起来。
//   改用 node 内置 `node:test` + `node:assert` + `http`：零依赖、零安装，与
//   tools/token-policy-bridge.circuit.test.js 同一套写法。
//
// 运行：node --test unified-ingress/server.test.js

'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');

// 用当前运行的 node（process.execPath）：零配置、跨平台，且不把本机绝对路径写进公开仓。
const NODE = process.env.MULTI_PROXY_NODE || process.execPath;
const SERVER = path.join(__dirname, 'server.js');

// ingress 只监听固定端口（INGRESS_PORT 不支持 0 后回读），挑一个不撞现网的口子。
// 后端用 listen(0) 拿临时端口，天然不冲突。
const INGRESS_PORT = 18843;

// 桩后端：记录被打到的 path / method / authorization，回 { hit: label }
function startBackend(label, captured) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured[label] = { path: req.url, method: req.method, auth: req.headers['authorization'] || null, body };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hit: label }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// 等 ingress 真的 listen：轮询 stdout 的 "listening on"（比盲 sleep 可靠）
function waitListening(child, tries = 60) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += String(d);
      if (buf.includes('listening on')) { done(); resolve(); }
    };
    const timer = setInterval(() => { if (--tries <= 0) done(reject); }, 100);
    function done(rej) {
      clearInterval(timer);
      child.stdout.off('data', onData);
      if (rej) rej(new Error(`ingress 未在预期时间内 listen，stdout=${buf}`));
    }
    child.stdout.on('data', onData);
  });
}

function spawnIngress(backends) {
  const child = spawn(NODE, [SERVER], {
    env: {
      ...process.env,
      INGRESS_PORT: String(INGRESS_PORT),
      INGRESS_BINDING: '127.0.0.1',
      BACKEND_CODEX: backends.codex,
      BACKEND_CLAUDE: backends.claude,
      BACKEND_MANAGER: backends.manager,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[ingress:err] ${d}`));
  return waitListening(child).then(() => child);
}

// 打 ingress 一发请求，返回 { status, body(已 JSON.parse) }
function hitIngress(pathname, { method = 'POST', headers = {}, body = { model: 'x' } } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const req = http.request({
      host: '127.0.0.1',
      port: INGRESS_PORT,
      path: pathname,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      signal: ac.signal,
    }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => {
        clearTimeout(t);
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* 非 JSON 保留 null */ }
        resolve({ status: r.statusCode, raw: buf, body: parsed });
      });
    });
    req.on('error', (e) => { clearTimeout(t); reject(e); });
    req.end(payload);
  });
}

// teardown：kill 子进程 + 销毁其管道（否则父进程事件循环不空、进程卡死不退出）
function stopIngress(child) {
  try { child.kill('SIGKILL'); } catch { /* noop */ }
  try { child.stdout.destroy(); } catch { /* noop */ }
  try { child.stderr.destroy(); } catch { /* noop */ }
}
function stopBackend(srv) {
  return new Promise((resolve) => { try { srv.close(() => resolve()); } catch { resolve(); } });
}
// 安全网：任何意外卡住都在 25s 后强退（node:test 不会自动杀残留子进程）
setTimeout(() => { console.error('[safety] forced exit after 25s'); process.exit(2); }, 25000).unref();

test('A · routeTarget 纯路由判定（默认后端 18790/18791/18792）', () => {
  const { routeTarget } = require('./server.js');
  // Anthropic 原生面 → claude-proxy
  assert.ok(routeTarget('/v1/messages').includes('18791'), '/v1/messages 应走 claude 18791');
  // OpenAI 面三个路径 → codex-proxy
  assert.ok(routeTarget('/v1/responses').includes('18790'), '/v1/responses 应走 codex 18790');
  assert.ok(routeTarget('/v1/chat/completions').includes('18790'), '/v1/chat/completions 应走 codex 18790');
  assert.ok(routeTarget('/v1/models').includes('18790'), '/v1/models 应走 codex 18790');
  // 治理面 → manager
  assert.ok(routeTarget('/api/cost/watchtower').includes('18792'), '/api/* 应走 manager 18792');
  assert.ok(routeTarget('/health').includes('18792'), '/health 应走 manager 18792');
  // 未知路径兜底 OpenAI 兼容面
  assert.ok(routeTarget('/something/else').includes('18790'), '未知路径应兜底 codex 18790');
});

test('B · 真转发：spawn 真实 ingress，按路径分发到对应后端', async () => {
  const captured = {};
  const codex = await startBackend('codex', captured);
  const claude = await startBackend('claude', captured);
  const manager = await startBackend('manager', captured);
  const ingress = await spawnIngress({
    codex: `http://127.0.0.1:${codex.address().port}`,
    claude: `http://127.0.0.1:${claude.address().port}`,
    manager: `http://127.0.0.1:${manager.address().port}`,
  });
  try {
    const m = await hitIngress('/v1/messages');
    assert.strictEqual(m.status, 200, '/v1/messages 应 200');
    assert.strictEqual(m.body.hit, 'claude', '/v1/messages 应打到 claude 后端');

    const c = await hitIngress('/v1/chat/completions');
    assert.strictEqual(c.body.hit, 'codex', '/v1/chat/completions 应打到 codex 后端');

    const r = await hitIngress('/v1/responses');
    assert.strictEqual(r.body.hit, 'codex', '/v1/responses 应打到 codex 后端');

    const a = await hitIngress('/api/cost/watchtower', { method: 'GET', body: '' });
    assert.strictEqual(a.body.hit, 'manager', '/api/* 应打到 manager 后端');
  } finally {
    stopIngress(ingress);
    await stopBackend(codex);
    await stopBackend(claude);
    await stopBackend(manager);
  }
});

test('C · 请求头（含 Authorization）原样透传，后端鉴权可用', async () => {
  const captured = {};
  const codex = await startBackend('codex', captured);
  const ingress = await spawnIngress({
    codex: `http://127.0.0.1:${codex.address().port}`,
    claude: 'http://127.0.0.1:1', // 故意指到不可达端口，确保本用例只可能打到 codex
    manager: 'http://127.0.0.1:1',
  });
  try {
    const res = await hitIngress('/v1/chat/completions', { headers: { Authorization: 'Bearer sk-secret' } });
    assert.strictEqual(res.status, 200, '应 200');
    assert.strictEqual(captured.codex.auth, 'Bearer sk-secret', 'Authorization 应原样透传给后端');
    assert.strictEqual(captured.codex.method, 'POST', 'method 应透传');
  } finally {
    stopIngress(ingress);
    await stopBackend(codex);
  }
});
