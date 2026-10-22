#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
//
// 🗄 归档 2026-10-22 —— 已废弃，保留仅作回源，不再维护、全仓零引用。
//   为何废弃：agnes 平台不实现提示缓存（chat 端点不报缓存字段、messages 端点 cache_read 恒 0），
//   结论：本实验在 agnes 上不成立（判定落到「A2=0 且 B2=0」那一格，见本文件 :26/:139）；
//     替代实现是 tools/cache-cross-account-ds.js（DeepSeek 有真缓存，见其 :14）。
'use strict';

// 跨账号缓存共享实测（2026-10-21，老板提供两个 agnes key）
//
// 要回答的问题：上游的提示缓存是「账号级隔离」还是「平台级共享」？
//   直接决定 multi-proxy 若做多账号轮换，会不会周期性把缓存打空——
//   轮换 N 个账号 = 每个账号的前缀都热不起来 = 缓存折扣全丢。
//
// 为什么必须用 /v1/messages 而不是 /v1/chat/completions：
//   agnes 的 chat 端点 usage 只有 prompt/completion/total 三字段，不报缓存；
//   messages 端点（Anthropic 协议）返回 cache_read_input_tokens /
//   cache_creation_input_tokens，缓存可观测。这条是 2026-10-21 实测探出来的。
//
// 实验序列（前缀逐字节相同，只有末尾问题不同）：
//   A1 = K1 第一次（冷，预期 cache_read=0）
//   A2 = K1 第二次（同账号验证，预期 cache_read>0 ⇒ 该账号缓存确实工作）
//   B1 = K2 第一次（跨账号测试，关键样本）
//   B2 = K2 第二次（K2 账号内验证，排除「K2 账号压根不支持缓存」的干扰解释）
// 判定：
//   B1 cache_read > 0  ⇒ 平台级共享（多账号轮换不影响缓存）
//   B1 cache_read = 0 且 B2 > 0 ⇒ 账号级隔离（轮换会毁缓存）★ 最可能的形态
//   B1 = 0 且 B2 = 0   ⇒ 该前缀/模型压根没缓存，实验不成立（要换前缀长度重试）

const fs = require('fs');
const path = require('path');

const HOST = process.env.AGNES_HOST || 'https://apihub.agnes-ai.cn/v1';
const MODEL = process.env.AGNES_MODEL || 'agnes-3.0-flash';
const PAUSE_MS = Number(process.env.PAUSE_MS || 6000); // 缓存构建需要秒级，别连发
const FILL_REPEAT = Number(process.env.FILL || 90);   // 前缀长度旋钮

// key 只从 env 读，不落盘、不进日志
function loadKeys() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^(AGNES_API_KEY_[12])\s*=\s*(.+)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  }
  const k1 = process.env.AGNES_API_KEY_1;
  const k2 = process.env.AGNES_API_KEY_2;
  if (!k1 || !k2) {
    console.error('缺 key：请在 multi-proxy/.env 配 AGNES_API_KEY_1 / AGNES_API_KEY_2（权限 600）');
    process.exit(2);
  }
  return [k1, k2];
}

// 长前缀：逐次请求必须逐字节相同，否则测的是「前缀变了」不是「账号变了」
const FILLER = '这一段是用于构造稳定前缀的中文占位文本，内容不承载语义，只用来把 system 块撑到足以触发缓存单元切分的长度。';
function buildSystem() {
  return [{ type: 'text', text: FILLER.repeat(FILL_REPEAT), cache_control: { type: 'ephemeral' } }];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function messages(key, question, tries = 3) {
  const body = {
    model: MODEL,
    max_tokens: 16,
    system: buildSystem(),
    messages: [{ role: 'user', content: question }],
  };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(HOST + '/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.status === 429 || r.status >= 500) {
        await sleep(15000);
        continue;
      }
      if (!r.ok) return { ok: false, status: r.status, err: JSON.stringify(j).slice(0, 200) };
      return { ok: true, usage: j.usage || {} };
    } catch (e) {
      if (i === tries - 1) return { ok: false, status: 0, err: String(e).slice(0, 150) };
      await sleep(8000);
    }
  }
  return { ok: false, status: 0, err: 'retries exhausted' };
}

function fmt(u) {
  return `input=${u.input_tokens ?? '-'} read=${u.cache_read_input_tokens ?? '-'} create=${u.cache_creation_input_tokens ?? '-'}`;
}

(async () => {
  const [k1, k2] = loadKeys();
  console.log(`跨账号缓存共享实测 · ${HOST} · model=${MODEL}`);
  console.log(`system 前缀 ≈ ${(FILLER.length * FILL_REPEAT)} 汉字（带 cache_control: ephemeral）\n`);

  const steps = [
    ['A1 · K1 首次（冷）', k1, '第一问：这段材料讲的是什么？一句话回答。'],
    ['A2 · K1 第二次（同账号内验证）', k1, '第二问：这段材料的核心判断是什么？一句话回答。'],
    ['B1 · K2 首次（★跨账号测试）', k2, '第一问：这段材料讲的是什么？一句话回答。'],
    ['B2 · K2 第二次（K2 账号内验证）', k2, '第二问：这段材料的核心判断是什么？一句话回答。'],
  ];

  const out = {};
  for (const [label, k, q] of steps) {
    const r = await messages(k, q);
    if (!r.ok) {
      console.log(`  ${label}: 请求失败 ${r.status} ${r.err}`);
      out[label.slice(0, 2)] = null;
    } else {
      console.log(`  ${label}: ${fmt(r.usage)}`);
      out[label.slice(0, 2)] = r.usage;
    }
    await sleep(PAUSE_MS);
  }

  const A1 = out['A1'], A2 = out['A2'], B1 = out['B1'], B2 = out['B2'];
  const rd = (u) => (u && u.cache_read_input_tokens) || 0;
  console.log('\n=== 判定 ===');
  if (!A1 || !A2 || !B1 || !B2) {
    console.log('样本不全，无法判定（多为限流/余额，稍后重跑）。');
    return;
  }
  console.log(`  同账号内缓存是否工作：A1 read=${rd(A1)} → A2 read=${rd(A2)} ${rd(A2) > 0 ? '✔ 工作' : '✘ 未观测到（换更长前缀重试）'}`);
  console.log(`  K2 账号内是否工作：  B1 read=${rd(B1)} → B2 read=${rd(B2)} ${rd(B2) > 0 ? '✔ 工作' : '—'}`);
  if (rd(B1) > 0) {
    console.log('  结论：★平台级共享——跨账号也能命中，多账号轮换不毁缓存。');
  } else if (rd(B2) > 0) {
    console.log('  结论：★账号级隔离——K2 首次同前缀 read=0、第二次才命中。');
    console.log('        ⇒ multi-proxy 做多账号轮换会周期性打空缓存，轮换策略必须按「会话粘性优先」设计。');
  } else {
    console.log('  结论：该前缀/模型未观测到缓存（实验不成立），需加大 FILL 重试。');
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
