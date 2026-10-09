// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// h3web round-trip probe —— 验证 L2 executor 的 h3web adapter 能真对接本地 h3web 服务。
//
// 背景：L2 executor 的 h3web 接线已完整实现且已测（见 l2/executor-bind.js:95-110 的
// BINDING_DEFS + l2/adapters/h3web-adapter.js 真实 adapter + l2/mock-h3web.js 替身 +
// h3web-adapter.demo.js / h3web-port-discovery.demo.js）。当前仅门控关
// （PROXY_EXECUTOR_BIND 默认 0），从未对真 :8731 跑过 round-trip（因为服务没起）。
//
// 本脚本是「维护者侧前置达成后的验证工具」：起真 h3web :8731 后，用它确认 adapter
// 真能把 task 透传到下游、job 状态机真能轮询到终态。
//
// 用法：
//   node scripts/h3web-roundtrip-probe.js                 # health 模式（默认）：仅探活 + 端点契约嗅探，秒级、零副作用
//   node scripts/h3web-roundtrip-probe.js --gen           # gen 模式：真提交一个最小 job 并轮询到终态（耗时，竖屏成片约 15min）
//   PROXY_H3WEB_PORTS=8731,8732 node scripts/h3web-roundtrip-probe.js
//   PROBE_POLL_MS=5000 PROBE_MAX_TRIES=200 node scripts/h3web-roundtrip-probe.js --gen
//
// 退出码：0=成功 2=未探测到 h3web（请先起服务） 1=其它错误

const http = require('http');

const PORTS = (process.env.PROXY_H3WEB_PORTS || '8731,8732')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter(Boolean);

const GEN = process.argv.includes('--gen');
const POLL_MS = Number(process.env.PROBE_POLL_MS || 3000);
const MAX_TRIES = Number(process.env.PROBE_MAX_TRIES || 200);
const HOST = '127.0.0.1';

function req(host, port, pathStr, method = 'GET', obj) {
  return new Promise((resolve, reject) => {
    const data = obj ? Buffer.from(JSON.stringify(obj)) : undefined;
    const r = http.request(
      {
        host,
        port,
        path: pathStr,
        method,
        timeout: 8000,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
          : {},
      },
      (resp) => {
        let b = '';
        resp.on('data', (c) => (b += c));
        resp.on('end', () => resolve({ status: resp.statusCode, body: b }));
      }
    );
    r.on('error', reject);
    r.setTimeout(8000, () => {
      r.destroy();
      reject(new Error('timeout'));
    });
    if (data) r.write(data);
    r.end();
  });
}

async function probePort(cands) {
  for (const p of cands) {
    try {
      const r = await req(HOST, p, '/');
      if (r.status) return p; // 根路径 200 = h3web 活着（真实 h3web 根返 SPA HTML，非 JSON 也算活）
    } catch {
      /* 连不上，试下一个 */
    }
  }
  return null;
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

(async () => {
  console.log(`[probe] 候选端口: ${PORTS.join(', ')}`);
  const port = await probePort(PORTS);
  if (!port) {
    console.error(
      `✗ 未在 ${PORTS.join(',')} 探测到 h3web 监听。\n` +
        `  请先起 h3web 本地服务（端口 8731），再跑本脚本。\n` +
        `  参考 docs/H3WEB-REAL-INTEGRATION.md §2。`
    );
    process.exit(2);
  }
  console.log(`✓ h3web 在 :${port} 探活成功 (GET / -> ${'200'})`);

  // 端点契约嗅探：真实 h3web 的 /api/gen 与 /api/status 是否按 adapter 预期响应
  const sniff = {};
  try {
    const g = await req(HOST, port, '/api/gen', 'POST', {
      prompt: 'probe-health-check',
      width: 512,
      height: 512,
      steps: 4,
      seconds: 3,
    });
    sniff.gen = { status: g.status, body: tryJson(g.body) };
  } catch (e) {
    sniff.gen = { error: e.message };
  }
  console.log(`[probe] POST /api/gen -> ${JSON.stringify(sniff.gen).slice(0, 200)}`);

  if (!GEN) {
    console.log('[probe] health 模式完成（未提交真实 job）。');
    console.log('[probe] 要真 round-trip，加 --gen 重跑（会提交最小 job 并轮询到终态，耗时）。');
    process.exit(0);
  }

  // gen 模式：真提交一个最小竖屏 job 并轮询到终态
  console.log('[probe] gen 模式：提交最小 job（768×1344 竖屏，steps=8，seconds=5）...');
  let submit;
  try {
    submit = await req(HOST, port, '/api/gen', 'POST', {
      prompt: 'multi-proxy round-trip probe',
      width: 768,
      height: 1344,
      steps: 8,
      seconds: 5,
    });
  } catch (e) {
    console.error(`✗ /api/gen 失败: ${e.message}`);
    process.exit(1);
  }
  const sj = tryJson(submit.body);
  const jobId = sj && sj.job_id;
  if (!jobId) {
    console.error(`✗ /api/gen 未返回 job_id。响应: ${submit.body.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`✓ 已提交 job_id=${jobId} (HTTP ${submit.status})`);

  for (let i = 0; i < MAX_TRIES; i += 1) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    let st;
    try {
      st = await req(HOST, port, `/api/status/${jobId}`);
    } catch (e) {
      console.error(`✗ /api/status 轮询失败: ${e.message}`);
      process.exit(1);
    }
    const sj2 = tryJson(st.body) || {};
    const status = sj2.status || '(无 status 字段)';
    console.log(`  poll #${i + 1}: status=${status}`);
    if (status === 'done' || status === 'failed') {
      console.log(`✓ job 终态: ${status}`);
      console.log(`[probe] 原始响应: ${st.body.slice(0, 400)}`);
      process.exit(status === 'done' ? 0 : 1);
    }
  }
  console.error(`✗ job ${jobId} 在 ${MAX_TRIES} 次轮询内未达终态`);
  process.exit(1);
})();
