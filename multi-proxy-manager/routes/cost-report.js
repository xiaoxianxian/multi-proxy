// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== 路由：跨进程 usage 上报（POST /api/cost/report） ====================
// 这是**唯一的接入面**：任何 agent 的代理（codex-proxy / cursor-proxy / hermes-proxy /
// 未来第三方）都走这一个端点把上游 usage 交给 manager 的 cost-track。
//
// 接入规范（对接入方零开发量，见 lib/usage-probe.js 头注释）：
//   POST /api/cost/report
//   { "agent": "codex-proxy",            // 谁报的（可选，默认 gateway）
//     "raw":   { ...上游 usage 原样... },  // 对象 or 流式 SSE 拼接文本
//     "latencyMs": 1234 }                 // 可选，喂 floor 的 p50
//   wire 可不带 —— 由 usage-probe.detectWire() 自动认（anthropic / openai / gemini / sse）。
//
// 鉴权：写端点不 fail-open。两条通道（lib/auth.js requireAgentAuth）——
//   ① 界面 JWT（x-auth-token）；② 机器 token（x-agent-token: <MANAGER_AGENT_TOKEN>）。
// 机器 token 由 manager 首次启动自动落盘（~/.multi-proxy-manager/agent-token, 0600）并注入
// 自身 env，spawnProxy 的 `{ ...process.env }` 会自动带进它拉起的代理子进程；第三方代理
// 复制同一串进 env 即可，无需登录。
//
// 为什么独立成一个文件而不是塞进 forward.js：写入口必须是**可远程调用的接口**，
// 否则每接一个 agent 代理就得往 manager 进程里加一段转发代码，与「开盒即用」相悖。
const express = require('express');
const { requireAgentAuth } = require('../lib/auth');
const costTrack = require('../lib/cost-track');
const watchtower = require('../../l2/watchtower-report');

const router = express.Router();

// 币种：账本只记数字不记币种（单价是部署时配的，CNY/USD 都可能）。
// 没配 → report.currency = null，**前端/CLI 不许印货币符号**（印了就是假精度）。
const COST_CURRENCY = (process.env.PROXY_COST_CURRENCY || '').trim() || null;

// ── 读端点：周报（Watchtower）──────────────────────────────────────────
//
// 为什么单独开一个读口（2026-10-16，对照 navige.ai Watchtower 后立项）：
//   cost-track 有 713 行、账本躺在本机，但此前**唯一的读口是 /api/floor**（开发者盘面）。
//   dashboard 的「成本」页只有 provider 余额 + 预算判级——「上周烧了多少、
//   模型重写省了多少」这两个数从来没被算出来过，也就从来没被人看见过。
//   Navige 的打法是把这两个数做成 $0 永久免费只读层，先让你看见钱再开省钱开关。
//
// 口径（详见 l2/watchtower-report.js 头注释）：
//   ① 实际花费 —— 账本行内冻结的 cost 直接求和（价表改了也不漂）。
//   ② 已省金额 —— 模型重写差额：账本同时记 model（实际计费）与 requestModel（宿主要的），
//                  两个都能在价表里查到价时才可算；配不齐 → null，页面画「—」。
//   🔴 v1 **不做**「还能省多少」的估算——Navige 官网自己都写
//      `An estimate, not a savings claim`。我们只报可回源的事实。
//
// 鉴权用 requireAgentAuth（界面 JWT **或** 机器 token）：
//   dashboard 带 x-auth-token，CLI 带 x-agent-token（~/.multi-proxy-manager/agent-token），
//   两条路都是现成的，接入方零额外开发。
router.get('/watchtower', requireAgentAuth, (req, res) => {
  try {
    const days = req.query.days ? parseInt(req.query.days, 10) : undefined;
    if (req.query.days && !(days > 0)) {
      return res.status(400).json({ ok: false, error: 'bad days: expect positive integer' });
    }
    const report = watchtower.buildWatchtowerReport({
      entries: costTrack.readLedgerEntries(),
      pricing: costTrack.getPricingTable(),
      days: days,
      now: new Date().toISOString(),
      currency: COST_CURRENCY,
      // 时区（2026-10-16）：周报的「上周」按用户本地日期理解。不传的话
      // watchtower 默认 Asia/Shanghai；这里显式从 PROXY_COST_TZ 读，
      // 让部署侧能覆盖（比如部署在 UTC 机器上但团队在东部时区）。
      tz: process.env.PROXY_COST_TZ || undefined
    });
    // 门控状态必须随报返回（2026-10-16 加）：PROXY_COST_TRACK 默认关，
    // 「没开记账」和「开了但真没流量」在账本上长得一模一样（都是空），
    // 而读者看到空周报的第一反应是「这工具没用」——必须让他看见差别。
    // 口径分开报：enabled=false 时下面这些数可能是历史存量，不是当前状态。
    const trackingEnabled = costTrack.enabled();
    report.tracking = { enabled: trackingEnabled, hint: null };
    if (!trackingEnabled) {
      report.tracking.hint = '当前未开启记账（PROXY_COST_TRACK 未设为 1/true/on）。'
        + '下面的数是门控开启期间的历史存量，不是当前状态；开启并重启 manager 后才会记新账。';
    } else if (report.spend.entryCount === 0) {
      report.tracking.hint = '已开启记账，但本窗口没有记录。确认流量确实经过 multi-proxy，'
        + '且代理能连上 manager（上报失败会在代理侧打一次 [cost] 警告）。';
    }
    res.json(report);
  } catch (e) {
    // 读端点不 fail-open：账本读失败要说出来，不能返回一份空周报冒充「上周没花钱」。
    res.status(500).json({ ok: false, error: 'watchtower build failed: ' + e.message });
  }
});


// 三模型字段（详见 lib/cost-track.js 头注释）：
//   model / requestModel / pricingModel —— 跨进程上报时原样带上，
//   否则过代理的 Anthropic 线会退化成 model=<unknown>，按模型拆账直接没数据。
//   reqId —— 幂等键。代理侧 tee 的 on('close')/on('finish') 双触发会把同一次响应报两遍
//   （实测 252 = 126×2），有 reqId 才能去重；不带就照记，不猜。
router.post('/report', requireAgentAuth, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'bad body: expect { agent?, raw, latencyMs? }' });
  }
  if (!body.raw) {
    return res.status(400).json({ ok: false, error: 'missing raw (上游 usage 原样)' });
  }
  // 口径由 lib/usage-probe 归一；这里不做解析、不猜字段 —— 认不出来就全 0 记一笔空账。
  const t = costTrack.reportUsage({
    agent:         body.agent,
    raw:           body.raw,
    latencyMs:     body.latencyMs,
    model:         body.model,
    requestModel:  body.requestModel,
    pricingModel:  body.pricingModel,
    reqId:         body.reqId,
  });
  res.json({
    ok: true,
    agent: body.agent || 'gateway',
    wire: t.wire,
    prompt: t.prompt, completion: t.completion, cacheHit: t.cacheHit, thinking: t.thinking,
  });
});

module.exports = router;
