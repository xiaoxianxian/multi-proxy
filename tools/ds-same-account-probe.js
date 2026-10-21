#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
'use strict';

// 两把 DeepSeek key 是否同一账号 —— 用「花一笔看得见的钱看谁的余额掉」来判，而不是看余额相等就下结论。
//
// 为什么必须做这步：cache-cross-account-ds.js 跑出「B1 冷请求即命中 1792 tok」，
//   但这个现象有两种解释：
//     (a) 两 key 属于**同一账号** ⇒ 跨 key 命中只是同账号内共享，跟「跨账号」无关；
//     (b) 两 key 分属不同账号 ⇒ 命中跨过了账号边界 ⇒ 平台级共享（多账号轮换不毁缓存）。
//   两种解释对 multi-proxy 的轮换设计结论完全相反，必须分开。
//   ⚠️ 余额数值相同只能当线索（两账号各充 ¥10 也长得一样），不能当证据。
//
// 判据（可证伪、单次可复现）：
//   用 K2 发一发请求花掉一笔看得见的钱（≈ ¥0.10，未命中价 $0.15/M），前后各读一次两把 key 的余额：
//     K1 余额也掉同样多 ⇒ 同一个余额池 ⇒ 同一账号（解释 a）
//     K1 纹丝不动、只有 K2 掉     ⇒ 不同账号（解释 b）
// 成本：约 ¥0.10（一次性）。规模由 --fill 控制，默认按 100k 未命中 token 设计。
//
// 🔴 2026-10-21 实测教训：DeepSeek 余额接口**不是实时扣减**。花完 15s 与约 10 min 两次复查
//   都是原值一分未动（当时误判为「判不出来」），约 20 min 后才双双掉 ¥0.11。
//   ⇒ 复查必须等，默认 --wait-seconds 1200（20 分钟）。别在分钟级时间窗下结论。
//   ⇒ 结果：K1 与 K2 **同时掉同样多**（钱只用 K2 花的）⇒ 同一余额池 ⇒ 同一账号。
//
// ⚠️ DeepSeek API 必须直连（7897 代理吞 Authorization 头）。

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HOST = 'https://api.deepseek.com';
const MODEL = process.env.DS_MODEL || 'deepseek-flash';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const FILL_REPEAT = Number(flag('fill', 3000)); // ≈ 171k 汉字 ≈ 100k tokens
const DRY = args.includes('--dry-run');

function loadKeys() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(DEEPSEEK_API_KEY(?:_2)?)\s*=\s*(\S+)\s*$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  }
  const k1 = process.env.DEEPSEEK_API_KEY, k2 = process.env.DEEPSEEK_API_KEY_2;
  if (!k1 || !k2) { console.error('缺 key：.env 需 DEEPSEEK_API_KEY / DEEPSEEK_API_KEY_2'); process.exit(2); }
  return [k1, k2];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function balance(key) {
  const r = await fetch(HOST + '/user/balance', { headers: { Authorization: 'Bearer ' + key } });
  const j = await r.json().catch(() => ({}));
  const bi = (j.balance_infos || [])[0] || {};
  return Number(bi.total_balance ?? NaN);
}

async function spend(key, tag) {
  const filler = '这是一段用于消耗余额的中文占位文本，不承载语义，只用来把请求输入撑到十万 token 量级，从而产生一笔看得见的扣费。';
  const body = {
    model: MODEL,
    messages: [
      // tag 进 system ⇒ 前缀与任何历史请求都不同，保证 miss（miss 才花钱）
      { role: 'system', content: `[spend-probe ${tag}] ` + filler.repeat(FILL_REPEAT) },
      { role: 'user', content: '只回一个字：好。' },
    ],
    max_tokens: 4,
  };
  const r = await fetch(HOST + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, err: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
  const u = j.usage || {};
  const d = u.prompt_tokens_details || {};
  const hit = d.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? ((u.prompt_tokens ?? 0) - hit);
  return { ok: true, prompt: u.prompt_tokens, hit, miss, costUsd: (miss * 0.15 + hit * 0.003) / 1e6 };
}

(async () => {
  const [k1, k2] = loadKeys();
  const est = (FILL_REPEAT * 47 / 1.69) * 0.15 / 1e6 * 7.2; // 粗估人民币成本（47 字/条 ÷ 1.69 字/token）
  console.log(`同账号判定探针 · 用 K2 花掉约 ¥${est.toFixed(3)}（fill=${FILL_REPEAT}）${DRY ? ' · DRY-RUN 不花钱' : ''}`);

  const before1 = await balance(k1), before2 = await balance(k2);
  console.log(`  花之前：K1=¥${before1}  K2=¥${before2}`);
  if (DRY) return;

  const sp = await spend(k2, Date.now());
  if (!sp.ok) { console.log(`  ❌ 请求失败：${sp.err}`); process.exit(1); }
  console.log(`  已发：prompt=${sp.prompt} hit=${sp.hit} miss=${sp.miss} ⇒ 约 $${sp.costUsd.toFixed(5)}（≈ ¥${(sp.costUsd * 7.2).toFixed(3)}）`);
  const WAIT = Number(flag('wait-seconds', 1200)); // 结算延迟实测 ~20 min，别改小
  console.log(`  等 ${WAIT}s 让结算刷新…`);
  await sleep(WAIT * 1000);

  const after1 = await balance(k1), after2 = await balance(k2);
  console.log(`  花之后：K1=¥${after1}  K2=¥${after2}`);
  const d1 = Number((before1 - after1).toFixed(4)), d2 = Number((before2 - after2).toFixed(4));
  console.log(`  掉额：K1 −¥${d1}   K2 −¥${d2}`);

  console.log('\n=== 判定 ===');
  if (d1 > 0.005 && d2 > 0.005) {
    console.log('  ★ 两把 key 的余额同时掉 ⇒ 同一个余额池 ⇒ **同一账号**。');
    console.log('    ⇒ 跨账号共享这道题**仍未闭合**（本次只证明了「同账号内多 key 共享缓存」）。');
    console.log('    ⇒ 要真闭合，需要一把来自**另一个 DeepSeek 账号**的 key 重跑 cache-cross-account-ds.js。');
  } else if (d2 > 0.005 && Math.abs(d1) < 0.005) {
    console.log('  ★ 只有 K2 掉、K1 不动 ⇒ **两把 key 分属不同账号**。');
    console.log('    ⇒ 结合 cache-cross-account-ds.js 的 B1 hit=1792：缓存跨过账号边界 ⇒ 平台级共享，多账号轮换不毁缓存。');
  } else {
    console.log('  ⚠️ 掉额都不到 ¥0.005，判不出来：把 --fill 加到 6000 重跑（成本翻倍到约 ¥0.2）。');
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
