#!/usr/bin/env node
/**
 * multi-proxy 熔断状态一览（2026-10-09）
 *
 * 存在的理由：熔断现在是 observe（只记账不拦），要决定能不能切 block 得先看账。
 * 但「看账」这件事原先是瞎的——18790 的 /health 只报主实例（default），
 * 而真实记账全在 per-provider sibling 上，主实例永远 CLOSED、outcomes 永远 0。
 * 这个脚本把三层的账一次性摊平，并单列 18790 的 per-provider 明细。
 *
 * 用法：
 *   node tools/circuit-status.js            # 人读的表格
 *   node tools/circuit-status.js --json     # 原始 JSON（给别的脚本吃）
 *   node tools/circuit-status.js --watch 10 # 每 10s 刷一次（Ctrl-C 退出）
 *
 * 只读：不发任何业务请求，只 GET /health。鉴权：env PROXY_AUTH_TOKEN → 头 x-proxy-auth。
 *
 * multi-proxy — Copyright © 2026 xiaoxian (Jason)
 * Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
 */
'use strict';

const http = require('http');

const TARGETS = [
  { port: 18790, name: 'codex-proxy', note: 'Codex 直连 · 唯一 per-provider 路由层' },
  { port: 18795, name: 'token-policy-bridge', note: '透明转发器 · 单一 UPSTREAM' },
  { port: 18796, name: 'savings-gateway', note: '省钱账 + failover · 当前零真实流量' },
];

function getHealth(port) {
  return new Promise((resolve) => {
    const headers = {};
    if (process.env.PROXY_AUTH_TOKEN) headers['x-proxy-auth'] = process.env.PROXY_AUTH_TOKEN;
    const req = http.get({ host: '127.0.0.1', port, path: '/health', headers, timeout: 3000 }, (r) => {
      let buf = '';
      r.on('data', (c) => { buf += c; });
      r.on('end', () => {
        try { resolve({ ok: true, json: JSON.parse(buf) }); }
        catch { resolve({ ok: false, error: `非 JSON 响应: ${buf.slice(0, 80)}` }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时 3s' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

/** 把一层的 /health.circuit 摊平成一行表格数据 */
function flatten(port, name, note, res) {
  if (!res.ok) {
    return { port, name, note, enabled: '-', mode: '-', state: 'DOWN', outcomes: '-', worst: '-', error: res.error };
  }
  const c = res.json.circuit || {};
  if (!c.enabled) return { port, name, note, enabled: 'off', mode: '-', state: '-', outcomes: '-', worst: '-' };

  const t = c.totals || {};
  const hasTotals = typeof t.tracked === 'number';
  const outcomes = hasTotals ? t.outcomes : (c.outcomes ?? 0);
  const worst = hasTotals ? t.worstErrorRate : (c.errorRate ?? 0);
  return {
    port,
    name,
    note,
    enabled: 'on',
    mode: c.mode || '-',
    state: hasTotals ? summarizeStates(t) : (c.state || '-'),
    outcomes: String(outcomes || 0),
    worst: (worst || 0).toFixed(2),
    raw: c,
  };
}

function summarizeStates(t) {
  if (t.open && t.open.length) return `OPEN(${t.open.join(',')})`;
  if (t.halfOpen && t.halfOpen.length) return `HALF_OPEN(${t.halfOpen.join(',')})`;
  return t.tracked ? `CLOSED×${t.tracked}` : 'CLOSED';
}

function pad(s, n) {
  const str = String(s);
  const width = n - [...str].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, width));
}

async function collect() {
  return Promise.all(TARGETS.map(async (t) => {
    const res = await getHealth(t.port);
    return flatten(t.port, t.name, t.note, res);
  }));
}

function render(rows) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const lines = [];
  lines.push(`multi-proxy 熔断状态   ${now}`);
  lines.push('─'.repeat(88));
  lines.push(`${pad('端口', 8)}${pad('服务', 22)}${pad('门控', 6)}${pad('模式', 10)}${pad('状态', 26)}${pad('样本', 6)}最差错误率`);
  for (const r of rows) {
    lines.push(`${pad(r.port, 8)}${pad(r.name, 22)}${pad(r.enabled, 6)}${pad(r.mode, 10)}${pad(r.state, 26)}${pad(r.outcomes, 6)}${r.worst}${r.error ? `  ← ${r.error}` : ''}`);
  }

  const main = rows.find((r) => r.port === 18790);
  if (main && main.raw && main.raw.providers) {
    const names = Object.keys(main.raw.providers);
    lines.push('');
    lines.push('18790 per-provider 明细（真实记账在这里；主实例恒 CLOSED，别只看它）：');
    if (!names.length) {
      lines.push('  （空：provider 要接过一次真实请求才会建账。observe 期间先攒量，别急着切 block）');
    } else {
      for (const n of names) {
        const s = main.raw.providers[n];
        const rate = s.errorRate === undefined ? '-' : (s.errorRate || 0).toFixed(2);
        lines.push(`  ${pad(n, 14)}${pad(s.state, 12)}失败 ${pad(s.failureCount ?? 0, 5)}样本 ${pad(s.outcomes ?? 0, 5)}错误率 ${rate}`);
      }
    }
  }
  lines.push('');
  lines.push('判读：样本 < 4（minRequests）时错误率不生效；错误率 > 0.6 才 OPEN；OPEN 后要不要真拦看 mode。');
  return lines.join('\n');
}

(async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const watchIdx = args.indexOf('--watch');
  const interval = watchIdx >= 0 ? parseInt(args[watchIdx + 1], 10) || 10 : 0;

  const once = async () => {
    const rows = await collect();
    if (asJson) {
      console.log(JSON.stringify(rows.map((r) => ({ ...r, raw: undefined })), null, 2));
      if (rows[0] && rows[0].raw) console.log(JSON.stringify({ providers: rows[0].raw.providers, totals: rows[0].raw.totals }, null, 2));
    } else {
      console.log(render(rows));
    }
  };

  await once();
  if (interval > 0) {
    console.log(`\n每 ${interval}s 刷新（Ctrl-C 退出）…`);
    setInterval(() => { console.log(''); once().catch((e) => console.error('刷新失败:', e.message)); }, interval * 1000);
  }
})();
