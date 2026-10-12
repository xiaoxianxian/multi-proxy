// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== IM 通道归一化 + 出站抽象 ====================
// 入站：把各平台 webhook 原始 payload 归一成 common message shape。
// 出站：把 agent 回复发回对应平台（先支持通用 webhook 回投；平台专用 API 留 stub，YAGNI）。
//
// 设计原则（与全项目一致）：
//   - 归一 / 执行 / 回投三件解耦；本文件只管「归一」和「回投」两件的纯函数与 IO。
//   - 不写任何 agent 文件、不触本地模型；平台对接按需扩展，不预先写死。

// 各平台原始 payload → common shape { text, conversationId, userId, raw }
function normalizeInbound(channel, raw) {
  if (!channel || typeof channel !== 'string') {
    throw new Error('normalizeInbound: channel 必填（如 feishu/telegram/generic）');
  }
  if (raw == null) {
    throw new Error('normalizeInbound: raw payload 必填');
  }
  const fn = NORMALIZERS[channel.toLowerCase()] || NORMALIZERS.generic;
  return fn(raw);
}

// --- 各平台归一器 ---
const NORMALIZERS = {
  // 飞书：事件回调。只取文本消息；订阅握手（url_verification）单独标记。
  // 真实部署还需校验 signature（README 要求），这里只做字段归一，签名校验交给部署侧。
  feishu(raw) {
    if (raw && raw.type === 'url_verification') {
      return { _handshake: true, challenge: raw.challenge };
    }
    const ev = raw && raw.event;
    const msg = (ev && ev.message) || {};
    const text = String(msg.text || '').replace(/^@[^ ]+\s*/, ''); // 去掉 @机器人 前缀
    const conversationId = msg.chat_id || (ev && ev.open_chat_id) || null;
    const userId = msg.sender_id || null;
    return { text, conversationId, userId, raw };
  },

  // Telegram：Update 对象，取 message.text。
  telegram(raw) {
    const msg = (raw && raw.message) || {};
    const text = String(msg.text || '');
    const conversationId = msg.chat && (msg.chat.id != null) ? String(msg.chat.id) : null;
    const userId = msg.from && (msg.from.id != null) ? String(msg.from.id) : null;
    return { text, conversationId, userId, raw };
  },

  // 通用 / 直连：payload 直接带 text + conversationId。未专门归一的平台走这条。
  generic(raw) {
    const text = raw.text != null ? String(raw.text) : '';
    const conversationId = raw.conversationId != null ? String(raw.conversationId) : null;
    const userId = raw.userId != null ? String(raw.userId) : null;
    return { text, conversationId, userId, raw };
  },
};

// 出站：把回复发回平台。
//   channel='webhook'：POST JSON 到 webhookUrl（fire-and-forget，2s 超时即弃，non-fatal）。
//   channel='feishu' ：POST 到 env IM_OUTBOUND_FEISHU_WEBHOOK（可选 IM_OUTBOUND_FEISHU_SECRET 签名）。
//   channel='telegram'：POST 到 Telegram Bot API（env IM_OUTBOUND_TELEGRAM_TOKEN + 目标 chat_id）。
//   缺配置一律显式报错（fail loud），不静默假装成功；凭据全部走 env，不在代码里写死。
async function sendOutbound(channel, { target, text, webhookUrl } = {}) {
  if (!text) throw new Error('sendOutbound: text 必填');

  if (channel === 'webhook') {
    if (!webhookUrl) throw new Error("sendOutbound(webhook): webhookUrl 必填");
    return postJson(webhookUrl, { text, target, conversationId: target });
  }

  if (channel === 'feishu') {
    const hook = process.env.IM_OUTBOUND_FEISHU_WEBHOOK;
    if (!hook) {
      throw new Error(
        "sendOutbound(feishu): 未配置 IM_OUTBOUND_FEISHU_WEBHOOK —— 要么配它，要么改用 channel='webhook' 旁挂回投地址"
      );
    }
    const body = { msg_type: 'text', content: { text: String(text) } };
    const secret = process.env.IM_OUTBOUND_FEISHU_SECRET;
    if (secret) {
      // 飞书签名：stringToSign = `${timestamp}\n${secret}`；sign = base64(HMAC-SHA256(stringToSign, secret))
      const ts = Math.floor(Date.now() / 1000);
      const crypto = require('crypto');
      const stringToSign = `${ts}\n${secret}`;
      const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
      body.timestamp = String(ts);
      body.sign = sign;
    }
    return postJson(hook, body);
  }

  if (channel === 'telegram') {
    const token = process.env.IM_OUTBOUND_TELEGRAM_TOKEN;
    if (!token) {
      throw new Error(
        "sendOutbound(telegram): 未配置 IM_OUTBOUND_TELEGRAM_TOKEN —— 要么配它，要么改用 channel='webhook' 旁挂回投地址"
      );
    }
    if (!target) throw new Error('sendOutbound(telegram): target(=chat_id) 必填');
    const api = `https://api.telegram.org/bot${token}/sendMessage`;
    return postJson(api, { chat_id: String(target), text: String(text) });
  }

  // 其他平台专用 API 尚未实现 → 显式报错，让调用方改用 webhook 旁挂。
  throw new Error(
    `sendOutbound('${channel}'): 平台专用 API 尚未实现（YAGNI）—— 用 channel='webhook' 旁挂回投地址`
  );
}

function postJson(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
    .then((r) => ({ ok: r.ok, status: r.status }))
    .catch((e) => ({ ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message }))
    .finally(() => clearTimeout(timer));
}

module.exports = { normalizeInbound, sendOutbound, NORMALIZERS };
