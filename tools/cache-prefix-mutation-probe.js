#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
'use strict';

// 前缀变异探针 · DeepSeek 版（2026-10-23）
//
// 要回答的问题：在上游缓存已热的前缀中段插一个字符，缓存是「单元块部分复用」还是「整段打空」？
//   直接决定两件事：
//   ① tools-lazyload 的裁剪经济学——官方文档说「前缀单元全匹配 + 长输入按固定 token 间隔切单元」，
//      若中段编辑只废掉变异点之后的单元、之前的单元照常命中，则 mid 裁剪能保留大部分命中；
//      若严格最长前缀匹配，则改一个字整段掉 miss（命中 $0.003/M vs 未命中 $0.15/M，差 50 倍）。
//   ② prefix-stability-guard 的价值主张——「谁在破坏前缀」值多少钱，取决于破坏的半径。
//
// 实验序列（前缀与 cache-cross-account-ds.js 逐字节相同，仅在中段插一个「甲」字）：
//   W1 = 未变异前缀第一次   （基线：此时缓存已被跨 key 实测热过，预期 hit≈1792）
//   M1 = 中段变异后第一次   （★关键样本：若 hit≈变异点之前的单元数 ⇒ 单元块部分复用；若 hit=0 ⇒ 严格全匹配）
//   M2 = 中段变异后第二次   （自验：M1 的低命中是「变异」而非「冷启动」⇒ M2 应显著高于 M1）
//
// 判定：
//   M1 hit > 0 且 M2 hit > M1   ⇒ 单元块模型：中段编辑只废尾部，头部单元跨变异复用
//   M1 hit = 0 且 M2 hit ≈ W1   ⇒ 严格最长前缀模型：改一个字符整段打空
//   M2 ≈ M1 且都很低            ⇒ 实验不成立（前缀没过缓存粒度），加大 --fill 重跑
//
// ⚠️ DeepSeek API 必须直连：本机 7897 代理会吞 Authorization 头。脚本内 fetch 默认不走代理。
// 用法：node tools/cache-prefix-mutation-probe.js [--fill 60] [--pause 3000] [--max-tokens 16]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOST = 'https://api.deepseek.com';
const MODEL = process.env.DS_MODEL || 'deepseek-flash';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const FILL_REPEAT = Number(flag('fill', 60));
const PAUSE_MS = Number(flag('pause', 3000));
const MAX_TOKENS = Number(flag('max-tokens', 16));

function loadKeys() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(DEEPSEEK_API_KEY(?:_2)?)\s*=\s*(\S+)\s*$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  }
  const k1 = process.env.DEEPSEEK_API_KEY;
  if (!k1) {
    console.error('缺 key：请在 multi-proxy/.env 配 DEEPSEEK_API_KEY（权限 600）');
    process.exit(2);
  }
  return k1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILLER = '这一段是用于构造稳定前缀的中文占位文本，内容不承载语义，只用来把 system 块撑到足以触发缓存单元切分的长度。';
const SYSTEM = FILLER.repeat(FILL_REPEAT);
const Q = '唯一问题：这段材料讲的是什么？一句话回答。';

// 中段插字：插在第 40% 个字符处（落在某一次 FILLER 重复中间）
const MUT_POS = Math.floor(SYSTEM.length * 0.4);
const MUTATED = SYSTEM.slice(0, MUT_POS) + '甲' + SYSTEM.slice(MUT_POS);

async function chat(key, messages) {
  const r = await fetch(HOST + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: MAX_TOKENS }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, err: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
  const u = j.usage || {};
  const d = u.prompt_tokens_details || {};
  const prompt = u.prompt_tokens ?? null;
  const hit = d.cached_tokens ?? u.prompt_cache_hit_tokens ?? null;
  const miss = u.prompt_cache_miss_tokens ?? (prompt != null && hit != null ? prompt - hit : null);
  return { ok: true, prompt, hit, miss };
}

function fmt(r) {
  if (!r.ok) return `请求失败 ${r.status || ''} ${r.err}`;
  const pct = r.prompt ? ((r.hit / r.prompt) * 100).toFixed(1) : '-';
  return `prompt=${r.prompt} hit=${r.hit} miss=${r.miss}（命中率 ${pct}%）`;
}

(async () => {
  const k1 = loadKeys();
  console.log(`前缀变异探针（DeepSeek）· model=${MODEL}`);
  console.log(`system 前缀 ≈ ${SYSTEM.length} 汉字；变异点在第 ${MUT_POS} 字符处（约 ${(MUT_POS / SYSTEM.length * 100).toFixed(0)}%），插入 1 个「甲」字\n`);

  const steps = [];
  // W1：未变异前缀（此刻缓存已被此前的跨 key 实测热过）
  let r = await chat(k1, [{ role: 'system', content: SYSTEM }, { role: 'user', content: Q }]);
  console.log(`  W1 · 未变异前缀          : ${fmt(r)}`);
  steps.push(['W1', r]);
  await sleep(PAUSE_MS);

  // M1：中段变异后第一次（关键样本）
  r = await chat(k1, [{ role: 'system', content: MUTATED }, { role: 'user', content: Q }]);
  console.log(`  M1 · 中段变异后首次（★） : ${fmt(r)}`);
  steps.push(['M1', r]);
  await sleep(PAUSE_MS);

  // M2：中段变异后第二次（自验）
  r = await chat(k1, [{ role: 'system', content: MUTATED }, { role: 'user', content: Q }]);
  console.log(`  M2 · 中段变异后二次（自验）: ${fmt(r)}`);
  steps.push(['M2', r]);

  const S = Object.fromEntries(steps);
  const hit = (k) => (S[k] && S[k].ok ? S[k].hit || 0 : null);
  console.log('\n=== 判定 ===');
  if (['W1', 'M1', 'M2'].some((k) => !S[k] || !S[k].ok)) {
    console.log('样本不全（多为限流/余额），无法判定。稍后重跑同一命令。');
    return;
  }
  console.log(`  基线 W1 hit=${hit('W1')}（未变异前缀，缓存已热）`);
  console.log(`  变异 M1 hit=${hit('M1')} → 自验 M2 hit=${hit('M2')}`);
  const headShare = (MUT_POS / SYSTEM.length * 100).toFixed(0);
  if (hit('M1') > 0 && hit('M2') > hit('M1')) {
    console.log(`  结论：★单元块模型——中段插 1 字后仍命中 ${hit('M1')} tok（≈变异点之前的 ${headShare}% 前缀），二次请求升到 ${hit('M2')}`);
    console.log('       ⇒ 头部缓存单元跨变异复用；中段编辑只废尾部。裁剪/改写前缀的代价是「变异点之后的 token」，不是整段。');
  } else if (hit('M1') === 0 && hit('M2') > 0) {
    console.log(`  结论：★严格最长前缀模型——中段插 1 字整段打空（M1 hit=0），自身二次请求才热起来（M2 hit=${hit('M2')}）`);
    console.log('       ⇒「改一个字整段掉 miss」成立；前缀稳定性守卫（PROXY_PREFIX_GUARD）按零容忍设计是对的。');
  } else {
    console.log('  结论：形态不在预期内（M2≈M1 且都低＝前缀没过缓存粒度，加大 --fill 重跑；其它形态人工看数）。');
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
