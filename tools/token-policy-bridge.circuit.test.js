#!/usr/bin/env node
// token-policy-bridge · 熔断门控端到端测试（2026-10-08）
//
// 桩一个假上游，spawn 真实 bridge 进程，验证：
//   1) 门控关（默认）→ /health 无 circuit 或 enabled:false，请求全透传
//   2) block 模式 + 上游 500 → 连续失败后熔断 OPEN，后续请求返 503 circuit_breaker_open
//   3) block 模式 + 上游 200 → 熔断永不触发，请求全 200
//
// 运行：node tools/token-policy-bridge.circuit.test.js

'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

// 用当前运行的 node（process.execPath）：零配置、跨平台，且不把本机绝对路径写进公开仓。
// 需指定别的 node 时仍可用 MULTI_PROXY_NODE 覆盖。
const NODE = process.env.MULTI_PROXY_NODE || process.execPath;
const BRIDGE = path.join(__dirname, 'token-policy-bridge.js');

function startUpstream(mode) {
  // mode: 'ok' 返回 200；'fail' 返回 500
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (mode === 'fail') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'upstream_boom' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'fake', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function waitHealth(port, tries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      if (n <= 0) return reject(new Error('bridge /health timeout'));
      http.get({ host: '127.0.0.1', port, path: '/health' }, (r) => {
        if (r.statusCode === 200) { r.resume(); return resolve(); }
        r.resume(); setTimeout(() => attempt(n - 1), 50);
      }).on('error', () => setTimeout(() => attempt(n - 1), 50));
    };
    attempt(tries);
  });
}

function spawnBridge() {
  // bridge 不支持 PORT=0，统一用 runBridgeOnPort 传具体端口串起来
  throw new Error('use runBridgeOnPort');
}

// bridge 不支持 PORT=0，这里直接用具体端口串起来
async function runBridgeOnPort(upstreamPort, bridgePort, env) {
  const child = spawn(NODE, [BRIDGE], {
    env: {
      ...process.env,
      PORT: String(bridgePort),
      BINDING: '127.0.0.1',
      UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      BRIDGE_STUB: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[bridge:err] ${d}`));
  await waitHealth(bridgePort);
  return child;
}

function hit(port, expectStatus) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, signal: ac.signal }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => { clearTimeout(t); resolve({ status: r.statusCode, body: buf }); });
    });
    req.on('error', (e) => { clearTimeout(t); reject(e); });
    req.end(body);
  });
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health' }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => resolve(JSON.parse(buf)));
    }).on('error', reject);
  });
}

// teardown：kill 子进程 + 销毁其管道（否则父进程事件循环不空、进程卡死不退出）
function stopBridge(br) {
  try { br.kill('SIGKILL'); } catch {}
  try { br.stdout.destroy(); } catch {}
  try { br.stderr.destroy(); } catch {}
}
function stopUpstream(up) {
  return new Promise((resolve) => { try { up.close(() => resolve()); } catch { resolve(); } });
}
// 安全网：任何意外卡住都在 25s 后强退（node:test 不会自动杀残留子进程）
setTimeout(() => { console.error('[safety] forced exit after 25s'); process.exit(2); }, 25000).unref();

// 选三个不冲突的端口（避免与 18790/18795/18794/18796 撞）
const PORTS = { upA: 18820, brA: 18821, upB: 18822, brB: 18823, upC: 18824, brC: 18825 };

test('A · 门控关（默认）→ /health circuit.enabled=false，请求全透传', async () => {
  const up = await startUpstream('ok');
  const upPort = up.address().port;
  const br = await runBridgeOnPort(upPort, PORTS.brA, {}); // 不传 BRIDGE_CIRCUIT_BREAKER
  try {
    const h = await getHealth(PORTS.brA);
    assert.strictEqual(h.circuit.enabled, false, '默认应 circuit.enabled=false');
    const r = await hit(PORTS.brA);
    assert.strictEqual(r.status, 200, '透传应 200');
    assert.strictEqual(r.body.includes('ok'), true, '应透传上游响应');
  } finally {
    stopBridge(br); await stopUpstream(up);
  }
});

test('B · block 模式 + 上游 500 → 连续失败后返 503 circuit_breaker_open', async () => {
  const up = await startUpstream('fail');
  const upPort = up.address().port;
  const br = await runBridgeOnPort(upPort, PORTS.brB, {
    BRIDGE_CIRCUIT_BREAKER: 'recommended',
    BRIDGE_CIRCUIT_MODE: 'block',
  });
  try {
    const h0 = await getHealth(PORTS.brB);
    assert.strictEqual(h0.circuit.enabled, true, '应 circuit.enabled=true');
    let saw503 = false;
    for (let i = 0; i < 8; i++) {
      const r = await hit(PORTS.brB);
      if (r.status === 503) {
        saw503 = true;
        assert.strictEqual(JSON.parse(r.body).error, 'circuit_breaker_open', '503 应带 circuit_breaker_open');
        break;
      }
      assert.strictEqual(r.status, 500, `第 ${i + 1} 次上游 500 应透传 500（熔断前）`);
    }
    assert.strictEqual(saw503, true, '熔断后应出现 503');
  } finally {
    stopBridge(br); await stopUpstream(up);
  }
});

test('C · block 模式 + 上游 200 → 熔断永不触发，全 200', async () => {
  const up = await startUpstream('ok');
  const upPort = up.address().port;
  const br = await runBridgeOnPort(upPort, PORTS.brC, {
    BRIDGE_CIRCUIT_BREAKER: 'recommended',
    BRIDGE_CIRCUIT_MODE: 'block',
  });
  try {
    let sawNon200 = false;
    for (let i = 0; i < 8; i++) {
      const r = await hit(PORTS.brC);
      if (r.status !== 200) sawNon200 = true;
    }
    assert.strictEqual(sawNon200, false, '上游健康时不应有任何非 200');
  } finally {
    stopBridge(br); await stopUpstream(up);
  }
});
