#!/usr/bin/env node
'use strict';
// token-policy-bridge · 把 apply() 接进真实转发链路的旁挂桥
//
// 目的：让 5 个 hook 跑在真实流量上。此前 apply() 全仓只有 demo 与单测调用，
//       「省了多少」永远是 policy 执行层估计，称不到真流量。
// 形态：独立进程 + 独立端口，agent 的 base_url 指到本端口，本进程转发给 UPSTREAM。
//       codex-proxy/proxy.js 保持 0 diff——热路径铁律不受影响，回滚 = base_url 指回上游。
//
// 为什么独立文件而不是改 token-baseline-sidecar：
//   那份探针的文件头契约是「只度量、不改包」，它产出的 jsonl 是基线数据。
//   给它加改写会让基线数据失去可信度（「这份数是被策略改过的吗」），必须分开。
//
// 用法：
//   node tools/token-policy-bridge.js                      # observe（默认，原样转发）
//   BRIDGE_MODE=rewrite node tools/token-policy-bridge.js  # 改写后转发
//   PORT=18794 UPSTREAM=http://127.0.0.1:18790 node tools/token-policy-bridge.js
//   BRIDGE_STUB=1 node tools/token-policy-bridge.js        # 桩响应，不消耗 token
//
// 隐私：默认不落请求正文，只落类别分布 / delta / policy 名与净增量。

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 18794);
const BINDING = process.env.BINDING || '127.0.0.1';
const UPSTREAM = (process.env.UPSTREAM || 'http://127.0.0.1:18790').replace(/\/$/, '');
const DEFAULT_MODE = 'observe'; // observe | rewrite；运行时读 env，便于同一进程内切换做对照
const STUB = process.env.BRIDGE_STUB === '1';
const AGENT_TYPE = process.env.BRIDGE_AGENT_TYPE || 'coding';
// 只有这几个字段允许写回请求体。handler 返回别的字段一律忽略并计数——
// 未知字段写进上游请求等于赌 provider 会容忍，赢了没收益、输了直接 400。
const MERGE_FIELDS = ['messages', 'systemPrompt', 'history'];
const LOG_DIR = process.env.BRIDGE_LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_PATH = path.join(LOG_DIR, `token-policy-bridge-${new Date().toISOString().slice(0, 10)}.jsonl`);

const TP = require('../l2/token-policy.js');
const CF = require('../l2/context-fold.js');

// ---------- 纯函数：协议归一（可独立测） ----------

/**
 * 从 OpenAI 请求体构造 token-policy 的 ctx。
 * 两种协议归一成同一形状：chat/completions 的 messages、responses 的 input/instructions。
 * @returns {{agentType:string, model:string, api:string, messages:Array, systemPrompt:string, history:Array, tools:Array}}
 */
function ctxFromRequest(body, api) {
  const b = body || {};
  let messages = [];
  let systemPrompt = '';
  if (api === 'responses') {
    // responses 的 input 可能是字符串（单轮）或数组（多轮）
    if (typeof b.input === 'string') { messages = [{ role: 'user', content: b.input }]; }
    else if (Array.isArray(b.input)) { messages = b.input; }
    systemPrompt = typeof b.instructions === 'string' ? b.instructions
      : (Array.isArray(b.instructions) ? b.instructions.join('\n') : '');
  } else {
    messages = Array.isArray(b.messages) ? b.messages : [];
    systemPrompt = messages
      .filter((m) => m && m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
  }
  const nonSystem = messages.filter((m) => m && m.role !== 'system');
  return {
    agentType: AGENT_TYPE,
    model: b.model || '',
    api,
    messages: nonSystem,
    systemPrompt,
    // history = 除最后一条外的部分。历史裁剪类 policy 需要它，缺了就静默不生效
    // （token-policy 在 ctx 缺 agentType 时是静默跳过，这里必须显式给全）。
    history: nonSystem.slice(0, -1),
    tools: Array.isArray(b.tools) ? b.tools : [],
  };
}

/**
 * 把 handler 的输出合并回原请求体（仅白名单字段）。
 * @returns {{body:object, applied:string[], ignored:string[], changed:boolean}}
 */
function mergeOutToRequest(body, out, api) {
  const applied = [];
  const ignored = [];
  if (!out || typeof out !== 'object') return { body, applied, ignored, changed: false };
  for (const k of Object.keys(out)) {
    if (k === 'netTokenDelta' || k === 'ok') continue;
    if (!MERGE_FIELDS.includes(k)) { ignored.push(k); continue; }
  }
  let next = body;
  const put = (field, value) => { next = { ...next, [field]: value }; applied.push(field); };

  if (Array.isArray(out.messages) && out.messages.length) {
    put(api === 'responses' ? 'input' : 'messages', api === 'responses'
      ? out.messages
      : (body.systemPrompt != null || systemCount(body) ? withSystem(body, out.messages) : out.messages));
  } else if (Array.isArray(out.history)) {
    // history 是「除最后一条外」，写回时要拼回最后一条，否则会吞掉当前这轮输入
    const last = (api === 'responses' ? (Array.isArray(body.input) ? body.input.slice(-1) : [])
      : (Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role !== 'system').slice(-1) : []));
    const merged = out.history.concat(last);
    put(api === 'responses' ? 'input' : 'messages', api === 'responses'
      ? merged
      : withSystem(body, merged));
  }
  if (typeof out.systemPrompt === 'string') {
    if (api === 'responses') { put('instructions', out.systemPrompt); }
    else { next = { ...next, messages: replaceSystem(next.messages || [], out.systemPrompt) }; if (!applied.includes('messages')) applied.push('messages'); }
  }
  return { body: next, applied, ignored, changed: applied.length > 0 };
}

function systemCount(body) {
  return Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role === 'system').length : 0;
}
function withSystem(body, msgs) {
  const sys = (body.messages || []).filter((m) => m && m.role === 'system');
  return sys.concat(msgs);
}
function replaceSystem(messages, text) {
  const rest = (messages || []).filter((m) => m && m.role !== 'system');
  return text ? [{ role: 'system', content: text }].concat(rest) : rest;
}

// ---------- 转发 ----------
async function forward(req, bodyStr) {
  const started = Date.now();
  try {
    const res = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' },
      body: req.method === 'GET' ? undefined : bodyStr,
      signal: AbortSignal.timeout(120000),
    });
    return { status: res.status, body: await res.text(), ms: Date.now() - started };
  } catch (e) {
    return { status: 502, body: JSON.stringify({ success: false, error: `bridge upstream unreachable: ${e.message}` }), ms: Date.now() - started };
  }
}

function logRecord(rec) {
  try {
    if (!loggedBoot) { fs.mkdirSync(LOG_DIR, { recursive: true }); loggedBoot = true; }
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n');
  } catch (e) { console.error('[bridge] write fail:', e.message); }
}
let loggedBoot = false;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mode: process.env.BRIDGE_MODE || DEFAULT_MODE, upstream: UPSTREAM, agentType: AGENT_TYPE, log: LOG_PATH }));
  }

  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* 非 JSON 原样转发 */ }

  const isResponses = req.url.startsWith('/v1/responses');
  const isChat = req.url.startsWith('/v1/chat/completions') || isResponses;
  const api = isResponses ? 'responses' : 'chat-completions';

  const MODE = process.env.BRIDGE_MODE || DEFAULT_MODE;
  let outBody = raw;
  const rec = { ts: new Date().toISOString(), path: req.url, mode: MODE, api, model: body.model || null, agentType: AGENT_TYPE };

  if (isChat) {
    const t0 = Date.now();
    const ctx = ctxFromRequest(body, api);
    // ① 度量：真实请求体的七类组成。
    //    ⚠️ 必须先把 responses 的 input/instructions 归一成 messages 再喂 fold——
    //    fold 只认 messages，直接喂原包会让 responses 请求七类全 0，
    //    而 codex 主力走 responses（config.toml wire_api="responses"），
    //    测不到它就等于这条链路白接。
    try {
      const sys = ctx.systemPrompt ? [{ role: 'system', content: ctx.systemPrompt }] : [];
      const f = CF.fold({ ...body, messages: sys.concat(ctx.messages) });
      rec.byCategory = f.estimate.byCategory;
      rec.estTotal = f.estimate.total;
      rec.toolsBySource = f.estimate.toolsBySource || {};
      if (body.usage) { rec.actualPrompt = body.usage.prompt_tokens ?? null; }
    } catch (e) { rec.foldError = String(e && e.message || e); }

    // ② 执行：真正跑 apply()。出错不得影响转发——这是桥的底线
    let applied = null;
    try {
      rec.ctxMsgs = ctx.messages.length;
      rec.ctxHistory = ctx.history.length;
      rec.ctxTools = ctx.tools.length;
      applied = TP.apply('onRequestAssemble', ctx);
      rec.policies = (applied.results || []).map((r) => ({ p: r.policy, ok: r.ok, d: r.netTokenDelta }));
      rec.estSaved = applied.estSaved;
      // estSaved 是各 policy 自报净增量之和；policy 没上报时该项为 null，
      // 累加时会跳过——所以这里可能是 0 条上报而非「确实没省」，口径要标清
      rec.reported = (applied.results || []).filter((r) => Number.isFinite(r.netTokenDelta)).length;

      if (MODE === 'rewrite') {
        // 只有一条 policy 主导改写，取优先级最高（results[0]）的 out，不叠加多个
        const top = (applied.results || [])[0];
        const m = mergeOutToRequest(body, top && top.out, api);
        rec.rewrote = m.changed;
        rec.appliedFields = m.applied;
        rec.ignoredFields = m.ignored;
        if (m.changed) {
          const s = JSON.stringify(m.body);
          // 序列化失败就回退原包——宁可不省，也不能把坏请求发给上游
          if (typeof s === 'string') { outBody = s; rec.bytesBefore = raw.length; rec.bytesAfter = s.length; }
          else { rec.rewrote = false; rec.mergeError = 'serialize-failed'; }
        }
      }
    } catch (e) {
      rec.applyError = String(e && e.message || e);
    }
    rec.bridgeMs = Date.now() - t0;
  }

  let out;
  if (STUB) {
    out = { status: 200, ms: 0, body: JSON.stringify({ id: 'stub', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) };
  } else {
    out = await forward(req, outBody);
  }

  if (isChat) {
    let usage = null;
    try { usage = (JSON.parse(out.body) || {}).usage || null; } catch { /* 流式/非 JSON */ }
    rec.upstreamStatus = out.status;
    rec.upstreamMs = out.ms;
    rec.actualPromptTokens = usage ? (usage.prompt_tokens ?? usage.input_tokens ?? null) : null;
    rec.actualCompletionTokens = usage ? (usage.completion_tokens ?? usage.output_tokens ?? null) : null;
    console.log(`[bridge:${MODE}] ${req.url} model=${rec.model} est=${rec.estTotal ?? '-'} tok | saved=${rec.estSaved ?? '-'} (${rec.reported ?? 0} 条上报) | rewrote=${rec.rewrote ?? false} | bridge=${rec.bridgeMs}ms status=${out.status} ${out.ms}ms`);
    logRecord(rec);
  }

  res.writeHead(out.status, { 'Content-Type': 'application/json' });
  res.end(out.body);
});

if (require.main === module) {
  server.listen(PORT, BINDING, () => {
    console.log(`[bridge] listening http://${BINDING}:${PORT} → ${STUB ? 'STUB' : UPSTREAM} | mode=${MODE} agentType=${AGENT_TYPE}`);
    console.log(`[bridge] metrics → ${LOG_PATH}`);
  });
}

module.exports = { ctxFromRequest, mergeOutToRequest, server, MERGE_FIELDS };
