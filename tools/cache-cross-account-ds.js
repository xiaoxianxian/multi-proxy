#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
'use strict';

// 跨账号缓存共享实测 · DeepSeek 版（2026-10-21，老板补第二个 DeepSeek key）
//
// 要回答的问题：上游的提示缓存是「账号级隔离」还是「平台级共享」？
//   直接决定 multi-proxy 若做多 key 轮换/多账号负载均衡，会不会周期性把缓存打空——
//   轮换 N 个 key = 每个 key 的前缀都热不起来 = 缓存折扣全丢（命中 $0.003/M vs 未命中 $0.15/M，差 50 倍）。
//
// 为什么上一轮 agnes 版没答成：agnes 的 chat 端点不报缓存字段、messages 端点恒 0
//   ⇒ 平台不实现提示缓存，实验在那儿不成立。DeepSeek 有真缓存（usage.prompt_tokens_details.cached_tokens）。
//
// 实验序列（前缀逐字节相同，只有末尾问题/答案不同）：
//   A1 = K1 首次（冷，预期 hit=0）
//   A2 = K1 第二次（同账号验证，预期 hit>0 ⇒ 该 key 的缓存确实工作）
//   B1 = K2 首次（★跨 key/账号测试）
//   B2 = K2 第二次（K2 自身验证，排除「K2 压根没缓存」的干扰解释）
// 判定：
//   B1 hit > 0                  ⇒ 命中跨过 key 边界（平台级共享 或 两 key 同账号，见 balance 校验）
//   B1 hit = 0 且 B2 hit > 0    ⇒ 账号级隔离（轮换会毁缓存）★ 预期形态
//   A2 = 0 或 B2 = 0            ⇒ 前缀没过缓存粒度/TTL，实验不成立（加大 FILL 重跑）
//
// 🔴 2026-10-21 实测结果（别当未跑重跑）：B1（K2 首个请求）在与 K1 逐字节相同的前缀上
//   直接 hit=1792 ⇒ **缓存跨 key 边界命中**。但 tools/ds-same-account-probe.js 用「花一笔钱看
//   谁的余额掉」证明这两把 key **是同一个账号**（K1/K2 同时掉 ¥0.11）
//   ⇒ 本脚本目前只闭合了「同账号内多 key 共享缓存」；要闭合**跨账号**，需一把来自
//     **另一个 DeepSeek 账号**的 key 替换 DEEPSEEK_API_KEY_2 后重跑（判定逻辑不用改）。
//
// ⚠️ DeepSeek API 必须直连：本机 7897 代理会吞 Authorization 头（实测报 auth header format 错）。
//    脚本内 fetch 默认不走代理，别给环境塞 NODE_USE_ENV_PROXY / HTTP_PROXY。
// 用法：node tools/cache-cross-account-ds.js [--fill 60] [--pause 3000] [--max-tokens 16]

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
  const k2 = process.env.DEEPSEEK_API_KEY_2;
  if (!k1 || !k2) {
    console.error('缺 key：请在 multi-proxy/.env 配 DEEPSEEK_API_KEY / DEEPSEEK_API_KEY_2（权限 600）');
    process.exit(2);
  }
  return [k1, k2];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 长前缀 filler：跨请求必须逐字节相同，否则测的是「前缀变了」不是「key 变了」
const FILLER = '这一段是用于构造稳定前缀的中文占位文本，内容不承载语义，只用来把 system 块撑到足以触发缓存单元切分的长度。';
const SYSTEM = FILLER.repeat(FILL_REPEAT);
const Q1 = '第一问：这段材料讲的是什么？一句话回答。';
const Q2 = '第二问：这段材料的核心判断是什么？一句话回答。';

async function balance(key) {
  try {
    const r = await fetch(HOST + '/user/balance', { headers: { Authorization: 'Bearer ' + key } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, err: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
    const bi = (j.balance_infos || [])[0] || {};
    return { ok: true, available: j.is_available, currency: bi.currency, total: bi.total_balance, granted: bi.granted_balance, toppedUp: bi.topped_up_balance };
  } catch (e) { return { ok: false, err: String(e).slice(0, 120) }; }
}

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
  const answer = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { ok: true, prompt, hit, miss, answer, raw: u };
}

function fmt(r) {
  if (!r.ok) return `请求失败 ${r.status || ''} ${r.err}`;
  const pct = r.prompt ? ((r.hit / r.prompt) * 100).toFixed(1) : '-';
  return `prompt=${r.prompt} hit=${r.hit} miss=${r.miss}（命中率 ${pct}%）`;
}

(async () => {
  const [k1, k2] = loadKeys();
  console.log(`跨账号缓存共享实测（DeepSeek）· model=${MODEL}`);
  console.log(`system 前缀 ≈ ${SYSTEM.length} 汉字（约 ${Math.ceil(SYSTEM.length / 1.6)} tokens 估），4 步各停 ${PAUSE_MS}ms\n`);

  console.log('=== 先校验两个 key 是不是同一个账号（余额口径）===');
  const b1 = await balance(k1), b2 = await balance(k2);
  console.log(`  K1: ${b1.ok ? `available=${b1.available} ${b1.currency} total=${b1.total}（赠送 ${b1.granted} / 充值 ${b1.toppedUp}）` : b1.err}`);
  console.log(`  K2: ${b2.ok ? `available=${b2.available} ${b2.currency} total=${b2.total}（赠送 ${b2.granted} / 充值 ${b2.toppedUp}）` : b2.err}`);
  const sameBalance = b1.ok && b2.ok && String(b1.total) === String(b2.total) && String(b1.toppedUp) === String(b2.toppedUp);
  console.log(`  余额口径：${sameBalance ? '⚠️ 两 key 余额完全一致 ⇒ 可能同一账号（跨账号结论要打折）' : '✅ 余额不同 ⇒ 倾向不同账号'}\n`);

  const prefix = [{ role: 'system', content: SYSTEM }, { role: 'user', content: Q1 }];

  const steps = [];
  // A1：K1 冷启动
  let r = await chat(k1, prefix);
  console.log(`  A1 · K1 首次（冷）        : ${fmt(r)}`);
  const a1 = r; steps.push(['A1', r]);
  await sleep(PAUSE_MS);

  // A2：K1 第二次（前缀 = A1 全量 + A1 答案 + Q2）
  r = await chat(k1, [...prefix, { role: 'assistant', content: a1.ok ? a1.answer : '' }, { role: 'user', content: Q2 }]);
  console.log(`  A2 · K1 第二次（同 key 验）: ${fmt(r)} ${r.ok ? '| raw ' + JSON.stringify(r.raw) : ''}`);
  steps.push(['A2', r]);
  await sleep(PAUSE_MS);

  // B1：★K2 首次，prompt 与 A1 逐字节相同
  r = await chat(k2, prefix);
  console.log(`  B1 · K2 首次（★跨 key）    : ${fmt(r)}`);
  const b1r = r; steps.push(['B1', r]);
  await sleep(PAUSE_MS);

  // B2：K2 第二次（前缀 = B1 全量 + B1 答案 + Q2）
  r = await chat(k2, [...prefix, { role: 'assistant', content: b1r.ok ? b1r.answer : '' }, { role: 'user', content: Q2 }]);
  console.log(`  B2 · K2 第二次（同 key 验）: ${fmt(r)}`);
  steps.push(['B2', r]);

  const S = Object.fromEntries(steps);
  const hit = (k) => (S[k] && S[k].ok ? S[k].hit || 0 : null);
  console.log('\n=== 判定 ===');
  if ([ 'A1','A2','B1','B2' ].some((k) => !S[k] || !S[k].ok)) {
    console.log('样本不全（多为限流/余额），无法判定。稍后重跑同一命令。');
    return;
  }
  console.log(`  K1 缓存是否工作：A1 hit=${hit('A1')} → A2 hit=${hit('A2')} ${hit('A2') > 0 ? '✔' : '✘ 前缀没过缓存粒度，加大 --fill 重跑'}`);
  console.log(`  K2 缓存是否工作：B1 hit=${hit('B1')} → B2 hit=${hit('B2')} ${hit('B2') > 0 ? '✔' : '✘'}`);
  if (hit('B1') > 0) {
    console.log(`  结论：★跨 key 命中（B1 冷请求即命中 ${hit('B1')} tok）`);
    console.log(sameBalance
      ? '       ⚠️ 但两 key 余额一致，无法排除「同一账号的两个 key」这个解释 ⇒ 结论降级为：同一账号内多 key 共享缓存。'
      : '       两 key 余额不同 ⇒ 倾向**平台级/账号外共享**：多 key 轮换不毁缓存。');
  } else if (hit('B2') > 0) {
    console.log('  结论：★账号级隔离——K2 首次同前缀 hit=0、第二次才命中。');
    console.log('       ⇒ multi-proxy 做多 key 轮换会周期性打空缓存；轮换策略必须按「会话粘性优先」设计（PROXY_ROUTE_STICKY）。');
  } else {
    console.log('  结论：该前缀/模型未观测到缓存（实验不成立），加大 --fill 到 120+ 重跑。');
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
