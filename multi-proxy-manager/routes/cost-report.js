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

const router = express.Router();

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
