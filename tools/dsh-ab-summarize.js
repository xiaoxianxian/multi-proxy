#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * 离线重放 dsh A/B 的汇总表 —— 从 tools/dsh-saving-ab.sh 落盘的 raw 日志算结论，
 * **不再发任何上游请求**（DeepSeek 限流很凶，为看一张表烧 4 次请求不划算）。
 *
 * raw 格式（tools/dsh-saving-ab.sh 写）：
 *   <payload sha256 前 12 位> payload        ← 头行，跳过
 *   <A_pt> <A_hit> <A_miss>|<B_pt> <B_hit> <B_miss>
 *
 * 用法：
 *   node tools/dsh-ab-summarize.js logs/dsh-ab-raw-2026-10-02-204500.jsonl
 *   node tools/dsh-ab-summarize.js $(ls -t logs/dsh-ab-raw-*.jsonl | head -1)
 *
 * 🔴 口径纪律（见 MEMORY.md §六「对拍三条线」）：
 *   · pt = prompt_tokens = hit + miss，是「这一轮要喂进去的量」，不是「这一轮花的钱」。
 *   · miss 才是每次全价新算的那一截；hit 是按量打折计价的旧内容。
 *   · 历史被桥改短 ⇒ miss 也小 ⇒ 口径一（−32%）在任何计费口径下都是真省，
 *     但拿 pt 差当「每轮每轮都省三成」是误读：稳态的 miss 跟你有没有桥基本无关。
 */
const fs = require('fs');

const file = process.argv[2] || (() => {
  try {
    const hits = fs.readdirSync('logs').filter(f => f.startsWith('dsh-ab-raw-')).sort().reverse();
    return hits.length ? `logs/${hits[0]}` : null;
  } catch { return null; }
})();
if (!file || !fs.existsSync(file)) {
  console.error('用法: node tools/dsh-ab-summarize.js <raw 文件路径>');
  process.exit(1);
}

const rows = [];
let hash = '-';
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t) continue;
  if (t.endsWith(' payload')) { hash = t; continue; }
  const [a, b] = t.split('|');
  if (!b) continue;
  const n = s => (s || '').trim().split(' ').map(x => parseInt(x) || 0);
  const A = n(a), B = n(b);
  if (A.length === 3 && B.length === 3) rows.push([A, B]);
}
if (!rows.length) { console.error(`（${file} 里没有可用样本）`); process.exit(1); }

const mean = arr => arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
const A = rows.map(r => r[0]), B = rows.map(r => r[1]);
const g = (C, i, k) => parseInt(C[i][k]) || 0;
const f = x => (Math.round(x * 10) / 10).toFixed(1);
const pct = (x, y) => (y !== 0 ? `${(100 * (x - y) / y).toFixed(1)}%` : 'n/a');

const A_pt = mean(A.map((_, i) => g(A, i, 0))), B_pt = mean(B.map((_, i) => g(B, i, 0)));
const A_ms = mean(A.map((_, i) => g(A, i, 2))), B_ms = mean(B.map((_, i) => g(B, i, 2)));
const A_ht = mean(A.map((_, i) => g(A, i, 1))), B_ht = mean(B.map((_, i) => g(B, i, 1)));
const yuan = (hit, miss) => (miss / 1e6) * 1 + (hit / 1e6) * 0.1;
// 🔴 上游不回缓存分档时（实测 agnes 不回 prompt_cache_hit/miss），口径二/三会全 0。
//    0 会被读成「没省钱」，跟口径一的 −35% 直接打架 —— 宁可显式标 n/a，不硬凑数字。
const cacheSplit = [...A, ...B].some(r => (Number(r[1]) || 0) > 0 || (Number(r[2]) || 0) > 0);

console.log(`样本: ${file}  (${hash})   轮数 = ${A.length}`);
console.log('');
console.log('===== dsh × DeepSeek 旁挂桥 A/B 汇总 =====');
console.log('');
console.log('[口径一] 少传了多少 —— 确定性，不依赖缓存');
console.log(`   A(直连) pt 均值 = ${f(A_pt).padStart(9)}    B(过桥) pt 均值 = ${f(B_pt).padStart(9)}`);
console.log(`   Δ = ${f(B_pt - A_pt).padStart(9)}   ${pct(B_pt, A_pt)}`);
console.log('');
console.log('[口径二] 真付钱多少 —— miss 才是全价新算的那一截');
console.log(`   A(直连) miss 均值 = ${f(A_ms).padStart(6)}    B(过桥) miss 均值 = ${f(B_ms).padStart(6)}`);
console.log(`   Δ = ${f(B_ms - A_ms).padStart(6)}   ${pct(B_ms, A_ms)}`);
if (!cacheSplit)
  console.log('   ⚠️ n/a：上游未回 prompt_cache_hit/miss 分档，miss 恒 0 —— 本口径不可用，别读成「没省」');
console.log('   🔴 稳态下 miss 只跟「这轮新变的尾巴」有关，跟桥没关系。别把口径一的 −32%');
console.log('      读成「每轮都省三成」——那是「这一轮要喂进去的量」的差，不是「花的钱」的差。');
console.log('');
console.log('[口径二·拆] 逐轮（A = 直连 18790 / B = 过桥 18795）');
for (let i = 0; i < A.length; i++) {
  const t = `r${i + 1}`.padEnd(6);
  console.log(`   ${t} A pt=${String(g(A, i, 0)).padStart(6)} hit=${String(g(A, i, 1)).padStart(6)} miss=${String(g(A, i, 2)).padStart(5)}` +
              `  |  B pt=${String(g(B, i, 0)).padStart(6)} hit=${String(g(B, i, 1)).padStart(6)} miss=${String(g(B, i, 2)).padStart(5)}`);
}
console.log('');
console.log('[口径三] 钱（输入侧；DeepSeek 未命中 1 元/M + 命中 0.1 元/M，换上游重算）');
if (!cacheSplit) {
  console.log('   n/a —— 上游未回 prompt_cache_hit/miss，无法按缓存分档计价');
  console.log('         （硬算会得到 0 元，被读成「没省钱」，跟口径一打架，故不凑数）');
  console.log('   👉 省钱结论看口径一（pt Δ）：确定性，不依赖缓存分档。');
} else {
  console.log(`   A(直连) = ${yuan(A_ht, A_ms).toFixed(5)} 元    B(过桥) = ${yuan(B_ht, B_ms).toFixed(5)} 元    变化 = ${pct(yuan(B_ht, B_ms), yuan(A_ht, A_ms))}`);
}
console.log('   ⚠️ 不含输出；换上游/换价要重算这一行。');
