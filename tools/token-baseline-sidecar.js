#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// token-baseline-sidecar · 「只度量、不改包」旁挂探针
//
// 目的：在不动热路径（codex-proxy/proxy.js 等）的前提下，抓到第一批**真实请求构成数据**。
// 形态：独立进程 + 独立端口，把 agent 的 base_url 指到本端口，本进程转发给 UPSTREAM（默认 18790）。
// 回滚：把 base_url 指回上游即可，对仓库任何既有文件 0 改动。
//
// 用法：
//   node tools/token-baseline-sidecar.js                # 转发模式
//   UPSTREAM=http://127.0.0.1:18790 PORT=18793 node tools/token-baseline-sidecar.js
//   WRAPPER_STUB=1 node tools/token-baseline-sidecar.js # 桩响应模式（不消耗任何 token，用于造流量）
//
// 隐私：默认不落任何请求正文，只落长度／类别分布／sha256 前 12 位。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 18793);
const BINDING = process.env.BINDING || '127.0.0.1';
const UPSTREAM = (process.env.UPSTREAM || 'http://127.0.0.1:18790').replace(/\/$/, '');
const STUB = process.env.WRAPPER_STUB === '1';
const LOG_DIR = process.env.WRAPPER_LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_PATH = path.join(LOG_DIR, `token-baseline-${new Date().toISOString().slice(0, 10)}.jsonl`);

// ---------- 度量工具 ----------
// 估算口径**复用 l2/token-policy.js 的 estimateTokens**（AGENTS §3 复用不重造）：
// 2026-10-01 校准后是 CJK-aware（CJK ≈ 1.04 token/字，其余 ≈ 0.255 token/字符），
// 旧的那份「CJK 0.75 token/字 + 其余 1/3.6」公式已经删掉了 —— 两份公式并存会互相打脸
// （旧式在真语料上 MAPE 14.5%，新式 7.0%）。系数可用 TOKEN_CJK_RATIO / TOKEN_ASCII_RATIO 覆盖。
// 这是启发式估计，不是 tokenizer、不是 provider usage。
const estimateTokens = require('../l2/token-policy.js').estimateTokens;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('');
  return content == null ? '' : JSON.stringify(content);
}

function hash12(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12); }

// 七类坐标系的简化版（对齐 dsh-context 的 system/tools/user/skill/assistant/tool 分法）
function measure(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const classes = { system: 0, user: 0, assistant: 0, tool: 0, toolsSchema: 0, other: 0 };
  const chars = { system: 0, user: 0, assistant: 0, tool: 0, toolsSchema: 0, other: 0 };
  const counts = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 };
  let maxMsgTokens = 0;
  const hashes = [];

  for (const m of messages) {
    const raw = textOf(m && m.content);
    const t = estimateTokens(raw);
    switch (m && m.role) {
      case 'system': case 'developer': classes.system += t; chars.system += raw.length; counts.system++; break;
      case 'user': classes.user += t; chars.user += raw.length; counts.user++; break;
      case 'assistant': classes.assistant += t; chars.assistant += raw.length; counts.assistant++; break;
      case 'tool': classes.tool += t; chars.tool += raw.length; counts.tool++; break;
      default: classes.other += t; chars.other += raw.length; counts.other++;
    }
    if (t > maxMsgTokens) maxMsgTokens = t;
    hashes.push(`${m && m.role}:${hash12(textOf(m && m.content))}`);
  }
  if (Array.isArray(body && body.tools)) {
    const tj = JSON.stringify(body.tools);
    classes.toolsSchema += estimateTokens(tj);
    chars.toolsSchema += tj.length;
  }

  // 连续重复（同一条消息在同一轮里挨着出现两次以上）— 历史膨胀的直接指征
  let dupAdjacent = 0;
  for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) dupAdjacent++;
  const uniqueHashes = new Set(hashes).size;

  const total = Object.values(classes).reduce((a, b) => a + b, 0);
  return { classes, chars, counts, maxMsgTokens, dupAdjacent, uniqueHashes, msgCount: messages.length, estTotalTokens: total };
}

// Responses API 归一化：instructions → system，input[] → messages，其余保序留为 other
function normalize(body) {
  if (!body || Array.isArray(body.messages)) return body;
  const msgs = [];
  if (typeof body.instructions === 'string' && body.instructions) msgs.push({ role: 'system', content: body.instructions });
  for (const it of Array.isArray(body.input) ? body.input : []) {
    if (!it) continue;
    if (it.type === 'message') msgs.push({ role: it.role, content: textOf(it.content) });
    else msgs.push({ role: 'other', content: typeof it === 'string' ? it : JSON.stringify(it) });
  }
  return { messages: msgs.length ? msgs : body.messages, tools: body.tools, model: body.model, stream: body.stream };
}

// agentType 启发式（token-policy 的 appliesTo 需要它，这里按请求特征猜）
function guessAgentType(body) {
  const sys = (Array.isArray(body && body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    .map((m) => textOf(m.content)).join(' ').toLowerCase();
  if (/storyboard|镜头|short film|script outline/.test(sys)) return 'aigc';
  if (Array.isArray(body && body.tools) && body.tools.length > 2) return 'coding';
  if (/research|search the web| citations/.test(sys)) return 'research';
  return 'general';
}

// 工具 schema opt-in 落盘（WRAPPER_DUMP_TOOLS=<path>）。
// 为什么单独开关、且只落 tools 不落正文：工具 schema 是 agent 自己定义的结构声明，
// 不含用户对话内容，是后续优化（懒加载/精简）的必要输入；正文仍受隐私约束不落。
const DUMP_TOOLS_PATH = process.env.WRAPPER_DUMP_TOOLS || '';

// token-policy 影子试跑：证明「如果接进热路径，会有几条 policy 命中」（默认不注册任何 pack，通常 0）
let tokenPolicy = null;
function policyShadow(agentType) {
  if (tokenPolicy === undefined) {
    try {
      const m = require('../l2/token-policy.js');
      tokenPolicy = typeof m.createTokenPolicy === 'function' ? m.createTokenPolicy() : null;
    } catch { tokenPolicy = null; }
  }
  if (!tokenPolicy) return null;
  try {
    const r = tokenPolicy.apply('onRequestAssemble', { agentType, messages: [] });
    return { ran: Array.isArray(r && r.results) ? r.results.length : 0, outEmpty: !!(r && r.results && r.results[0] && r.results[0].out) };
  } catch (e) { return { ran: 0, error: String(e && e.message || e) }; }
}

// ---------- 落盘 ----------
let loggedBoot = false;
function logRecord(rec) {
  try {
    if (!loggedBoot) { fs.mkdirSync(LOG_DIR, { recursive: true }); loggedBoot = true; }
    fs.appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n');
  } catch (e) { console.error('[sidecar] write fail:', e.message); }
}

// ---------- 转发 ----------
async function forward(req, bodyBuf) {
  const started = Date.now();
  const target = UPSTREAM + req.url;
  try {
    const res = await fetch(target, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization || '' },
      body: req.method === 'GET' ? undefined : bodyBuf,
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    return { status: res.status, body: text, ms: Date.now() - started };
  } catch (e) {
    return { status: 502, body: JSON.stringify({ success: false, error: `sidecar upstream unreachable: ${e.message}` }), ms: Date.now() - started };
  }
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (req.url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM, stub: STUB, log: LOG_PATH }));
  }

  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* 非 JSON 直接转发 */ }

  const isChat = req.url.startsWith('/v1/chat/completions') || req.url.startsWith('/v1/responses');
  const rec = { ts: new Date().toISOString(), path: req.url, upstream: STUB ? 'STUB' : UPSTREAM };

  const nb = isChat ? normalize(body) : body;
  if (isChat) {
    const m = measure(nb);
    const agentType = guessAgentType(nb);
    Object.assign(rec, {
      api: req.url.startsWith('/v1/responses') ? 'responses' : 'chat-completions',
      agentType,
      stream: !!body.stream,
      hasTools: Array.isArray(body.tools) ? body.tools.length : 0,
      msgCount: m.msgCount,
      counts: m.counts,
      classes: m.classes,
      chars: m.chars,
      estTotalTokens: m.estTotalTokens,
      maxMsgTokens: m.maxMsgTokens,
      dupAdjacent: m.dupAdjacent,
      uniqueRatio: m.msgCount ? +(m.uniqueHashes / m.msgCount).toFixed(3) : 1,
      policyShadow: policyShadow(agentType),
    });
    if (DUMP_TOOLS_PATH && Array.isArray(nb.tools)) {
      try {
        fs.writeFileSync(DUMP_TOOLS_PATH, JSON.stringify({ ts: rec.ts, api: rec.api, tools: nb.tools }));
      } catch (e) { /* dump 失败不影响主链路 */ }
    }
  }

  let out;
  if (STUB) {
    const isResponses = req.url.startsWith('/v1/responses');
    const respObj = isResponses
      ? {
          id: 'resp_stub', object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model || 'stub',
          status: 'completed', output_text: 'ok', parallel_tool_calls: true, tool_choice: 'auto',
          output: [{ type: 'message', id: 'msg_stub', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        }
      : null;
    out = { status: 200, ms: 0, body: '' };
    if (isResponses && body.stream) {
      const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      out.body = [
        ev('response.created', { ...respObj, status: 'in_progress', output: [] }),
        ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, sequence_number: 1, item: respObj.output[0] }),
        ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_stub', output_index: 0, content_index: 0, delta: 'ok', sequence_number: 2 }),
        ev('response.completed', { type: 'response.completed', response: respObj, sequence_number: 3 }),
      ].join('');
      out.contentType = 'text/event-stream';
    } else if (isResponses) {
      out.body = JSON.stringify(respObj);
    } else {
      out.body = JSON.stringify({
        id: 'stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model || 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } else {
    out = await forward(req, raw);
  }

  if (isChat) {
    let usage = null;
    try { usage = (JSON.parse(out.body) || {}).usage || null; } catch { /* 非 JSON */ }
    rec.upstreamStatus = out.status;
    rec.upstreamMs = out.ms;
    // actual vs estimate 双轨：upstream 真返回值是「实测」，classes 是「估算」
    rec.actualPromptTokens = usage ? (usage.prompt_tokens ?? usage.input_tokens ?? null) : null;
    rec.actualCompletionTokens = usage ? (usage.completion_tokens ?? usage.output_tokens ?? null) : null;
    console.log(`[sidecar] ${req.url} model=${rec.model} msgs=${rec.msgCount} est=${rec.estTotalTokens} tok | sys=${rec.classes.system} tools=${rec.classes.toolsSchema} user=${rec.classes.user} asst=${rec.classes.assistant} tool=${rec.classes.tool} | actual_in=${rec.actualPromptTokens} dup=${rec.dupAdjacent} status=${out.status} ${out.ms}ms`);
    logRecord(rec);
  }

  res.writeHead(out.status, { 'Content-Type': out.contentType || 'application/json' });
  res.end(out.body);
});

server.listen(PORT, BINDING, () => {
  console.log(`[sidecar] listening http://${BINDING}:${PORT} → ${STUB ? 'STUB (no token spent)' : UPSTREAM}`);
  console.log(`[sidecar] metrics → ${LOG_PATH}`);
});
