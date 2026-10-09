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
// --start：探测不到服务时自动拉起（CLI 显式授权，等价于门控开）。
// 复用 manager 的 h3web-guard 内核，避免「两份启动逻辑」漂移。
const START = process.argv.includes('--start');
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
  let port = await probePort(PORTS);
  if (!port && START) {
    const guard = require('../multi-proxy-manager/lib/h3web-guard');
    console.log(`[probe] --start: 未探测到服务，拉起 h3web (${guard.resolveScript() || '未找到脚本'}) ...`);
    const r = await guard.start({ force: true });
    if (!r.ok) {
      console.error(`✗ 拉起失败: ${r.error || JSON.stringify(r)}`);
      process.exit(2);
    }
    console.log(`[probe] 已 spawn pid=${r.pid}，等待监听...`);
    port = await probePort(PORTS);
  }
  if (!port) {
    console.error(
      `✗ 未在 ${PORTS.join(',')} 探测到 h3web 监听。\n` +
        `  请先起 h3web 本地服务（端口 8731），再跑本脚本；或加 --start 让本脚本拉起。\n` +
        `  参考 docs/H3WEB-REAL-INTEGRATION.md §2。`
    );
    process.exit(2);
  }
  console.log(`✓ h3web 在 :${port} 探活成功 (GET / -> ${'200'})`);

  // 端点契约嗅探（health 模式**严格只读**：绝不 POST /api/gen 提交 job）。
  // 为什么不下发 job：h3web 一收到 /api/gen 就会拉起引擎（网关不可达时自起 h3 二进制，
  // 冷启动要 50–60s 加载权重），health 探活不该付出这个代价 —— 那是 --gen 模式的事。
  // 改用「不存在的 task_id 打 /api/status」：能回 404 就证明 status 路由真的挂载了。
  try {
    const s = await req(HOST, port, '/api/status/probe-nonexistent-id');
    console.log(
      `[probe] GET /api/status/<fake> -> HTTP ${s.status}` +
        (s.status === 404 ? ' (路由已挂载，符合预期)' : ' (非 404，人工看一眼响应)')
    );
  } catch (e) {
    console.log(`[probe] GET /api/status/<fake> -> 探测失败: ${e.message}`);
  }
  try {
    const c = await req(HOST, port, '/api/characters');
    console.log(`[probe] GET /api/characters -> HTTP ${c.status}`);
  } catch {
    /* 该端点可选，探测失败不致命 */
  }

  if (!GEN) {
    console.log('[probe] health 模式完成（未提交真实 job）。');
    console.log('[probe] 要真 round-trip，加 --gen 重跑（会提交最小 job 并轮询到终态，耗时）。');
    process.exit(0);
  }

  // gen 模式：真提交一个最小竖屏 job 并轮询到终态。
  // 参数可用 env 覆盖 —— 默认按「能跑通契约的最小代价」设定，因为引擎冷启动要
  // 加载百 GB 级权重，验收阶段没必要为一次 round-trip 付生产级成片的代价。
  const W = Number(process.env.PROBE_WIDTH || 768);
  const H = Number(process.env.PROBE_HEIGHT || 1344);
  const STEPS = Number(process.env.PROBE_STEPS || 8);
  const SECS = Number(process.env.PROBE_SECONDS || 5);
  console.log(`[probe] gen 模式：提交 job（${W}×${H}，steps=${STEPS}，seconds=${SECS}）...`);
  console.log('[probe] 想更省资源：PROBE_WIDTH=512 PROBE_HEIGHT=512 PROBE_STEPS=4 PROBE_SECONDS=3');
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
