#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// bridge-dryrun · 开 rewrite 之前的影响面报告
//
// 为什么要有这个文件：桥的 rewrite 模式会把 policy 的输出合并回**真实请求体**——
//   也就是说，启用某个 pack 会悄悄改写发给真实厂商的 prompt。此前没有任何东西
//   回答「这个 pack 开下去会动哪些字段、波及哪些 model/endpoint、命中多少条」。
//   同构问题在 NVIDIA/OpenShell 里是用 policy prover（策略变更生效前先形式化演算
//   将新放出哪些能力）解决的。这里不需要形式化：把「开 / 关」两态在**同一份
//   真实请求**上各跑一遍做 diff，影响面就出来了。
//
// 语料来源：桥开 BRIDGE_LOG_BODY=1 时把转发前的原始包落到 logs/bridge-corpus-*.jsonl
//   （正文与度量日志分文件存放，保持主日志的可公开性）。
//
// 用法：
//   node tools/bridge-dryrun.js --corpus logs/bridge-corpus-2026-10-01.jsonl
//   node tools/bridge-dryrun.js --corpus <p> --change onHistory:maxMsgChars=800
//   node tools/bridge-dryrun.js --corpus <p> --change onHistory:foldToolOutput=true --json
//
// ⚠️ 口径：token 数是 context-fold 的估算（长度/3 启发式），不是 tokenizer、
//    不是 provider usage。报告标题已标，别拿去当账目数。

const fs = require('fs');
const BRIDGE = require('./token-policy-bridge.js');
const { createCurator, POLICY_FILES } = require('../packs/curator/curator-engine.js');
const { createContextFold } = require('../l2/context-fold.js');

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const a = { corpus: null, changes: [], json: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--corpus') a.corpus = argv[++i];
    else if (v === '--limit') a.limit = Number(argv[++i]) || 0;
    else if (v === '--json') a.json = true;
    else if (v === '--change') {
      const spec = String(argv[++i] || '');
      const m = spec.match(/^([A-Za-z]+):([A-Za-z]+)=(.+)$/);
      if (!m) throw new Error(`--change 格式应为 hook:param=value，收到：${spec}`);
      // 值可能是 true/false/数字/字符串
      let val = m[3];
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^-?\d+$/.test(val)) val = Number(val);
      a.changes.push({ hook: m[1], change: m[2], value: val });
    }
  }
  if (!a.corpus) throw new Error('缺 --corpus <bridge-corpus-*.jsonl>');
  return a;
}

// ---------- 纯函数 ----------

function loadCorpus(file, limit) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const keep = limit > 0 ? lines.slice(0, limit) : lines;
  const out = [];
  const skipped = [];
  for (const line of keep) {
    try {
      const o = JSON.parse(line);
      if (!o || !o.body) { skipped.push('no-body'); continue; }
      out.push({
        ts: o.ts || null,
        path: o.path || '/v1/responses',
        api: o.api || (/responses$/.test(o.path || '') ? 'responses' : 'chat-completions'),
        model: o.model || null,
        agentType: o.agentType || null,
        body: o.body,
      });
    } catch (e) { skipped.push('bad-json'); }
  }
  return { entries: out, skipped };
}

/** 与桥同一把秤。🔴 responses 必须先归一——fold 只认 messages，直接喂原包七类全 0。 */
function estTokens(body, api) {
  const ctx = BRIDGE.ctxFromRequest(body, api);
  const sys = ctx.systemPrompt ? [{ role: 'system', content: ctx.systemPrompt }] : [];
  const f = createContextFold().fold({ ...body, messages: sys.concat(ctx.messages) });
  return {
    total: f.estimate.total,
    byCategory: f.estimate.byCategory,
    msgs: ctx.messages.length,
    history: ctx.history.length,
    tools: ctx.tools.length,
  };
}

/** 字段级 diff：只在顶层键上比，值用序列化长度而不是内容包含（避免大数组逐字较） */
function diffFields(origin, next) {
  const keys = new Set([].concat(Object.keys(origin || {}), Object.keys(next || {})));
  const changed = [];
  for (const k of keys) {
    const a = origin ? origin[k] : undefined;
    const b = next ? next[k] : undefined;
    const sa = a === undefined ? null : JSON.stringify(a);
    const sb = b === undefined ? null : JSON.stringify(b);
    if (sa === sb) continue;
    const beforeChars = sa ? sa.length : 0;
    const afterChars = sb ? sb.length : 0;
    changed.push({ field: k, beforeChars, afterChars, deltaChars: afterChars - beforeChars });
  }
  return changed;
}

function policyModule(hook) {
  const hit = (POLICY_FILES || []).find((x) => x.hook === hook);
  if (!hit) return null;
  try { return require(`../packs/curator/policies/${hit.file}.js`); } catch { return null; }
}

/**
 * 单条请求的开关对照跑。
 * @returns {{hit:boolean, applied:string[], ignored:string[], changed:array, before:object, after:object, policies:array}}
 */
function runOne(item, changes) {
  const pack = createCurator({});
  const undo = [];
  const installed = [];
  for (const c of changes) {
    const mod = policyModule(c.hook);
    const prev = mod && mod.params ? mod.params[c.change] : undefined;
    const r = pack.applyChange(c.hook, c.change, c.value);
    undo.push(() => { if (mod && mod.params) mod.params[c.change] = prev; });
    installed.push({ hook: c.hook, change: c.change, value: c.value, ok: !!r.installed, reason: r.reason || null });
  }
  try {
    const before = estTokens(item.body, item.api);
    // 与桥完全同构：ctxFromRequest → 链式 apply → results[0].out → mergeMany
    const ctx = BRIDGE.ctxFromRequest(item.body, item.api);
    let chained = ctx;
    const runs = [];
    for (const hook of BRIDGE.REQUEST_HOOKS) {
      const res = pack.apply(hook, chained);
      runs.push({ hook, res });
      const top = (res.results || [])[0];
      if (top && top.out && typeof top.out === 'object') {
        const next = { ...chained };
        if (Array.isArray(top.out.history)) next.history = top.out.history;
        if (Array.isArray(top.out.messages)) next.messages = top.out.messages;
        if (typeof top.out.systemPrompt === 'string') next.systemPrompt = top.out.systemPrompt;
        chained = next;
      }
    }
    const policies = runs.flatMap((x) => (x.res.results || [])
      .map((r) => ({ hook: x.hook, policy: r.policy, ok: r.ok, netTokenDelta: r.netTokenDelta ?? null })));
    const outs = runs.map((x) => (x.res.results || [])[0]).filter(Boolean).map((r) => r.out);
    const m = BRIDGE.mergeMany(item.body, outs, item.api);
    const after = estTokens(m.body, item.api);
    // 🔴 「命中」的判据必须是**请求体真的变了**，不是 m.changed。
    //    m.changed 只表示「往 body 上写过某个字段」——policy 把 history 原样吐回来时
    //    照样会写一次，于是出现「applied 非空、但对字节数零影响」的假命中。
    //    （和桥的教训同构：「省了多少」和「发出去什么」是两件事。）
    const bodyChanged = diffFields(item.body, m.body);
    return {
      hit: bodyChanged.length > 0,
      writtenFields: m.applied,
      applied: m.applied, ignored: m.ignored,
      changed: bodyChanged,
      before, after, policies, installed,
      estSaved: before.total - after.total,
    };
  } finally {
    // params 挂在 require 缓存的模块对象上——不还原会污染同进程后续对照组
    undo.forEach((fn) => fn());
  }
}

/** @returns {{entries:array, summary:object}} */
function analyze(corpusFile, changes, limit) {
  const { entries, skipped } = loadCorpus(corpusFile, limit);
  const results = entries.map((item, i) => ({
    n: i + 1, ts: item.ts, path: item.path, model: item.model, agentType: item.agentType,
    api: item.api, ...runOne(item, changes),
  }));
  const models = [...new Set(results.map((r) => r.model).filter(Boolean))];
  const paths = [...new Set(results.map((r) => r.path))];
  const fieldCount = {};
  for (const r of results) for (const f of r.changed) fieldCount[f.field] = (fieldCount[f.field] || 0) + 1;
  const sumTokens = (k) => results.reduce((a, r) => a + r[k].total, 0);
  return {
    entries: results,
    summary: {
      corpus: corpusFile, total: results.length, skipped: skipped.length,
      hit: results.filter((r) => r.hit).length,
      missed: results.filter((r) => !r.hit).length,
      models, paths,
      fieldsChanged: fieldCount,
      writtenNoChange: results.filter((r) => r.writtenFields.length > 0 && !r.hit).length,
      ignoredFields: [...new Set(results.flatMap((r) => r.ignored))],
      tokensBefore: sumTokens('before'),
      tokensAfter: sumTokens('after'),
      estSaved: sumTokens('before') - sumTokens('after'),
      changes, seenRoles: null,
    },
  };
}

// ---------- 输出 ----------

function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }

function toMarkdown(rep) {
  const s = rep.summary;
  const L = [];
  L.push('# bridge dry-run 影响面报告（估算口径）');
  L.push('');
  L.push(`- 语料：\`${s.corpus}\`（${s.total} 条，跳过 ${s.skipped} 条坏行）`);
  L.push(`- 目标 model：${s.models.length ? s.models.join(', ') : '（无）'}`);
  L.push(`- 涉及 endpoint：${s.paths.join(', ')}`);
  L.push(`- 装载的变更：${s.changes.length ? s.changes.map((c) => `${c.hook}.${c.change}=${JSON.stringify(c.value)}`).join(' / ') : '（无，pack 默认全关）'}`);
  L.push(`- **命中 ${s.hit} 条 / 未命中 ${s.missed} 条**${s.writtenNoChange ? `（其中 ${s.writtenNoChange} 条被 policy 写回但字节内容无变化 = 假节省）` : ''}`);
  L.push(`- token 合计：${s.tokensBefore} → ${s.tokensAfter}（净 ${-s.estSaved}，${pct(s.estSaved, s.tokensBefore)}）`);
  L.push(`- 被改字段：${Object.keys(s.fieldsChanged).length ? Object.entries(s.fieldsChanged).map(([k, v]) => `${k}×${v}`).join(', ') : '（无）'}`);
  if (s.ignoredFields.length) L.push(`- ⚠️ 被白名单挡掉的字段（**没写进上游**）：${s.ignoredFields.join(', ')}`);
  L.push('');
  if (!s.changes.length) {
    L.push('> 没装载任何变更。curator pack 默认全关，此时影响面恒为空——这本身就是结论：');
    L.push('> **桥现在切到 rewrite 也不会产生任何改动。**');
    return L.join('\n');
  }
  L.push('| # | model | endpoint | before→after | 净 | 改了哪些字段 | policy（netTokenDelta） |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of rep.entries) {
    const fields = r.changed.length ? r.changed.map((f) => `${f.field}(${f.deltaChars > 0 ? '+' : ''}${f.deltaChars} chars)`).join(' ') : '—';
    const pol = r.policies.length ? r.policies.map((p) => `${p.policy}=${p.netTokenDelta ?? 'null'}`).join(' ') : '—';
    L.push(`| ${r.n} | ${r.model || '-'} | ${r.path} | ${r.before.total}→${r.after.total} | ${-r.estSaved} (${pct(r.estSaved, r.before.total)}) | ${fields} | ${pol} |`);
  }
  L.push('');
  L.push('> token 为 context-fold 估算（长度/3），非 tokenizer、非 provider usage。');
  return L.join('\n');
}

// ---------- CLI ----------

function main() {
  const a = parseArgs(process.argv.slice(2));
  const rep = analyze(a.corpus, a.changes, a.limit);
  process.stdout.write((a.json ? JSON.stringify(rep, null, 2) : toMarkdown(rep)) + '\n');
}

module.exports = { parseArgs, loadCorpus, estTokens, diffFields, runOne, analyze, toMarkdown };

if (require.main === module) {
  try { main(); } catch (e) { console.error('[dryrun] ' + e.message); process.exit(1); }
}
