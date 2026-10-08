#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// curator · tools-lazyload 离线 A/B 基准（第一个真 handler 的效果实测）
//
// 为什么要独立脚本而不是接进 bridge：bridge 的白名单（mergeOutToRequest）不认 tools，
// 且它 require 的是 l2/token-policy.js 的单例，没加载 packs/curator。
// 这里直接用handler 纯函数 + 真实语料做 A/B，量「能省多少」，落盘成基线供后续决策。
//
// 语料：① 真实工具 schema（探针 WRAPPER_DUMP_TOOLS 产出，默认 /tmp/tools-schema.json）
//      ② 本机 ~/.codex/sessions 真实历史会话（从中抽「该会话跑过哪些工具」= 活跃证据）
// 口径：内部估算 = chars/3（token-policy 同口径）；再按 30 号校准系数换算 o200k token。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const lazy = require('../packs/curator/policies/tools-lazyload.js');

const CAL_CODE = 0.2728; // 30 号校准：code/结构化组 tokens-per-char
const CAL_ALL = 0.947; // 全体加权比（估算 → 真分词器）
const FIXED_OVERHEAD = 14709; // 30 号：每轮固定开销（系统+schema+用户，校准后）

const SCHEMA_PATH = process.env.TOOLS_SCHEMA || '/tmp/tools-schema.json';
const SESSION_DIR = process.env.SESSION_DIR || path.join(process.env.HOME, '.codex/sessions');
const OUT = process.env.LAZY_OUT || path.join(__dirname, '..', 'logs', 'tools-lazyload-baseline.json');

const tools = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')).tools || [];
const toolNames = tools.map((t) => (t && t.function && t.function.name) || t && t.name || '(unnamed)');
const nameless = toolNames.filter((n) => !n || n === '(unnamed)').length;

// 从真实会话里抽「跑过哪些工具」。rollout 行格式：{type:'response_item', payload:{type:'function_call', name}}
const files = execSync(`find '${SESSION_DIR}' -name 'rollout-*.jsonl' -type f`).toString().trim().split('\n').filter(Boolean);
const sessions = [];
for (const f of files) {
  const used = new Set();
  let lines = 0;
  try {
    for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) {
      lines++;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const p = o.payload || {};
      if (p.type === 'function_call' && p.name) used.add(p.name);
      if (o.type === 'response_item' && p.type === 'function_call' && p.name) used.add(p.name);
      if (Array.isArray(p.tool_calls)) for (const c of p.tool_calls) if (c && c.name) used.add(c.name);
      if (Array.isArray(p.content)) for (const c of p.content) if (c && (c.type === 'function_call' || c.type === 'tool_call') && c.name) used.add(c.name);
    }
  } catch { continue; }
  if (lines) sessions.push({ file: f.split('/').pop(), used: Array.from(used) });
}

const schemaChars = JSON.stringify(tools).length;
const schemaInternalTokens = Math.ceil(schemaChars / 3);
const schemaO200k = Math.round(schemaChars * CAL_CODE); // 校准后

// ⚠️ 语料对齐：真实历史会话是旧版 codex 打的，里面的 read_file/js/update_plan/spawn_agent
//    等名字在当前 schema 里**根本不存在**（实测 14 个历史工具名只有 7 个是交集）。
//    用旧名当活跃证据会让 matched≈0、100% 退化成全发——那是语料错位，不是策略无效。
//    所以这里只保留「当前 schema 里真实存在」的名字作为证据。
const KNOWN = new Set(toolNames.filter((n) => n && n !== '(unnamed)'));
const withEvidence = sessions
  .map((s) => Object.assign({}, s, { known: s.used.filter((u) => KNOWN.has(u)) }))
  .filter((s) => s.known.length);

// A/B：首轮（无证据）必须零裁减
const firstTurn = lazy.handler({ tools, messages: [] }, { budget: {} });

// 阈值扫参：cfg 合并顺序是 DEFAULTS < env < io.budget，所以直接把 ratio 塞 io.budget 即可覆盖
const RATIOS = String(process.env.LAZY_SCAN || '0.7,0.85,0.9,0.95').split(',').map((x) => Number(x.trim()));
// ⚠️ 口径：必须按「单轮」算，不能把多会话的节省求和去比「每轮」固定开销（量纲错，会得出 >100% 的假数）。
//    单轮省 = schema 总量 × 该会话藏掉的比例。
//    🔴 还要留意「回弹」：本策略每轮按当前历史重算，历史里调用过的工具会不断进入活跃集，
//    于是藏的比例随会话变长而下降 —— 长会话的长期收益低于首轮触发时的值。这是本实现的已知局限。
const scan = RATIOS.map((ratio) => {
  const ratios = [];
  let lazySessions = 0, hiddenTotal = 0;
  for (const s of withEvidence) {
    const ctx = { tools, messages: [{ role: 'assistant', content: s.known.map((n) => ({ type: 'tool_call', name: n })) }], agentType: 'coding' };
    const r = lazy.handler(ctx, { budget: { maxHideRatio: ratio } });
    if (r.reason === 'lazy-loaded') { lazySessions++; hiddenTotal += r.hiddenTools.length; ratios.push(r.hiddenTools.length / tools.length); }
  }
  const sorted = ratios.sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const savedPerTurnO200k = Math.round(schemaO200k * med); // 单轮口径
  return {
    maxHideRatio: ratio, lazySessions, withEvidenceSessions: withEvidence.length, hiddenTotal,
    medianHiddenRatio: +med.toFixed(3),
    savedPerTurnO200kTokens: savedPerTurnO200k,
    pctOfPerTurnFixedOverhead: +((savedPerTurnO200k / FIXED_OVERHEAD) * 100).toFixed(1),
  };
});
const rows = [];
for (const s of withEvidence) {
  const ctx = { tools, messages: [{ role: 'assistant', content: s.known.map((n) => ({ type: 'tool_call', name: n })) }], agentType: 'coding' };
  const r = lazy.handler(ctx, { budget: {} });
  rows.push({ file: s.file.slice(0, 18), knownUsed: s.known.length, kept: r.kept, hidden: r.hiddenTools.length, saved: r.saved, reason: r.reason });
}
const savedTokens = rows.reduce((a, r) => a + r.saved, 0);
const savedO200k = Math.round(savedTokens * 3 * CAL_CODE);
const pctOfFixed = (savedO200k / FIXED_OVERHEAD) * 100;

const report = {
  ts: new Date().toISOString(),
  schema: { tools: tools.length, nameless, names: toolNames, chars: schemaChars, internalTokens: schemaInternalTokens, o200kTokens: schemaO200k },
  sessions: { total: sessions.length, withEvidence: withEvidence.length },
  firstTurnCheck: { kept: firstTurn.kept, total: firstTurn.total, saved: firstTurn.saved, reason: firstTurn.reason, safe: firstTurn.kept === firstTurn.total && firstTurn.saved === 0 },
  ab: { perSession: rows.length, hiddenTotal: rows.reduce((a, r) => a + r.hidden, 0), savedInternalTokens: savedTokens, savedO200kTokens: savedO200k, pctOfPerTurnFixedOverhead: +pctOfFixed.toFixed(1) },
  scan,
  verdict: rows.length === 0 ? 'no-evidence-samples' : pctOfFixed > 20 ? 'worth-it' : 'marginal',
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('\n首轮零裁减（安全性）:', report.firstTurnCheck.safe ? 'PASS' : 'FAIL');
console.log('落盘:', OUT);
// 安全性断言失败就非零退出，便于进 CI / 预提交检查
if (!report.firstTurnCheck.safe) process.exit(1);
