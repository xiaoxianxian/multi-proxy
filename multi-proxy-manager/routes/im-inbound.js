// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== 路由：IM 入站通道（POST /api/im-inbound/webhook） ====================
// 让 IM 平台（飞书 / Telegram / …）的消息进 multi-proxy，走本地 agent 执行，再把回复回投。
//
// 非侵入铁律（与全项目一致）：
//   - 门控 PROXY_IM_INBOUND 默认关 → 403，热路径零副作用；=1 才放行。
//   - 真执行另受 PROXY_EXECUTOR_BIND 门控（缺省 0）→ 不开 = 不触下游、不花钱、不吐数据。
//   - 不写任何 agent 文件；出站回投走 webhook 旁挂（YAGNI，不直连各平台 API）。
//
// 流程：webhook 收 → normalizeInbound 归一 → runAgent 跑本地 agent（codex 默认）→
//       同步回 { reply } + 异步 sendOutbound 回投（若带 replyTo.webhookUrl）。
//
// 接入形态（body 二选一）：
//   A. 平台原始回调：{ "channel":"feishu", "payload":{...} }
//   B. 已归一化直连：{ "channel":"generic", "text":"...", "conversationId":"..." }
//   可选回投：replyTo = { "channel":"webhook", "webhookUrl":"https://your-relay/..." }
//   可选指定执行：adapterId（默认 codex）/ model / maxTokens

const express = require('express');
const { requireAgentAuth } = require('../lib/auth');
const { normalizeInbound, sendOutbound } = require('../lib/im-channels');

const router = express.Router();

// ---- 门控：PROXY_IM_INBOUND ∈ {1,true,on} 才放行，其余一律拒（默认零副作用）----
function gateOpen() {
  const v = String(process.env.PROXY_IM_INBOUND || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// 真执行门控（复用既有 executor-bind 三重门控之一，不开 = 不触下游）
function isExecutorBindOpen() {
  const v = String(process.env.PROXY_EXECUTOR_BIND || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// 懒构造 executor（仅门控开 + 真实绑定时才真触下游；构造期不触网）
let _executor = null;
function getExecutor() {
  if (_executor === null) {
    if (!isExecutorBindOpen()) { _executor = false; return null; }
    const { createBoundExecutor } = require('../../l2/executor-bind.js');
    const bind = createBoundExecutor({ logger: { log: () => {}, warn: () => {} } });
    _executor = bind.executor; // 形态：(adapterId, subtask, ctx)
  }
  return _executor || null;
}

// 跑一轮本地 agent（默认 codex）。opts.executor 可注入（测试用）。
// 返回 { content, adapterId, model, raw }。
async function runAgent(text, opts = {}) {
  const executor = opts.executor || getExecutor();
  if (!executor) {
    throw new Error('executor 未绑定（需 PROXY_IM_INBOUND=1 且 PROXY_EXECUTOR_BIND=1）→ 不触下游');
  }
  const subtask = {
    id: opts.id || `im-${Date.now()}`,
    type: 'chat',
    prompt: text,
    params: { model: opts.model, maxTokens: opts.maxTokens },
  };
  const r = await executor(opts.adapterId || 'codex', subtask, opts.ctx || {});
  const content = (r && r.content) ||
    (r && r.raw && r.raw.result && r.raw.result.content) || '';
  return { content, adapterId: r && r.adapterId, model: r && r.model, raw: r };
}

// 测试辅助：注入/重置 executor（避免测试触真网络）
router._setExecutor = function (fn) { _executor = fn ? fn : null; };
router._resetForTest = function () { _executor = null; };

// ---- 门控中间件 ----
router.use((req, res, next) => {
  if (!gateOpen()) {
    return res.status(403).json({
      error: 'im-inbound-gate-closed',
      hint: '开灰度：PROXY_IM_INBOUND=1 node server.js（真执行还需 PROXY_EXECUTOR_BIND=1）',
    });
  }
  next();
});

// POST /webhook —— 入站入口（机器鉴权：x-agent-token 或界面 JWT）
router.post('/webhook', requireAgentAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const channel = body.channel;
    if (!channel) return res.status(400).json({ ok: false, error: 'missing channel' });

    // 归一化（A. 原始 payload / B. 已归一化直连）
    let msg;
    if (body.payload !== undefined) {
      msg = normalizeInbound(channel, body.payload);
      if (msg._handshake) {
        // 飞书订阅握手：原样回 challenge
        return res.json({ ok: true, challenge: msg.challenge });
      }
    } else if (body.text !== undefined) {
      msg = normalizeInbound('generic', body);
    } else {
      return res.status(400).json({
        ok: false,
        error: 'expect {channel,payload} or {channel,text,conversationId}',
      });
    }

    const text = String(msg.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'empty message text' });

    // 执行：优先用测试注入的 executor，否则走真实绑定
    const result = await runAgent(text, {
      id: `im-${msg.conversationId || 'direct'}-${Date.now()}`,
      model: body.model,
      maxTokens: body.maxTokens,
      adapterId: body.adapterId,
      executor: req.app.locals.imExecutor || undefined,
    });

    // 回投（异步、non-fatal）
    let outbound = null;
    const replyTo = body.replyTo;
    if (replyTo && replyTo.channel === 'webhook' && replyTo.webhookUrl) {
      outbound = await sendOutbound('webhook', {
        target: msg.conversationId,
        text: result.content,
        webhookUrl: replyTo.webhookUrl,
      }).catch((e) => ({ ok: false, error: e.message }));
    }

    return res.json({
      ok: true,
      reply: result.content,
      adapterId: result.adapterId,
      model: result.model,
      conversationId: msg.conversationId,
      outbound,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.gateOpen = gateOpen;
module.exports.runAgent = runAgent;
module.exports.normalizeInbound = normalizeInbound;
module.exports.sendOutbound = sendOutbound;
