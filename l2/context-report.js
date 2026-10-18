// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// context-report — lane 侧上下文观测上报器（context-breakdown 口径 §4/§6）
//
// 职责：lane 在一次转发成功后，把请求体折成七类组成（l2/context-fold.js）、
// 与同 clientKey 的上一帧比出事件（l2/context-events.js）、fire-and-forget
// 报给 manager（POST /api/context/report）。
//
// 铁律（与 cost-track 埋点同构）：
//   - 门控 PROXY_CONTEXT_TRACK 默认关；关时 observe() 第一次布尔判断就返回，
//     不 fold、不建帧、不发网 —— 热路径零开销。
//   - 任何异常只吞不抛：观测链路崩了不能拖垮转发（try 全包）。
//   - 只上报计数，永不包含 prompt/回复正文（口径 §4 隐私纪律）。
//
// 用法（lane 的 usage 上报点旁边）：
//   const ctxReport = require('../../l2/context-report');
//   ctxReport.observe({ agent: 'dsh-proxy', reqId, model, requestModel,
//     clientKey, request: req.body, actuals: response.data.usage });

const { createContextFold } = require('./context-fold.js');
const { inferEvents } = require('./context-events.js');

const MANAGER_URL = process.env.MANAGER_URL || 'http://127.0.0.1:18792';
const AGENT_TOKEN = process.env.MANAGER_AGENT_TOKEN || '';
const SHIP_TIMEOUT_MS = 2000;
/** 最多记住多少个 clientKey 的上一帧（generic lane 多客户端场景）。超出按插入序淘汰。 */
const MAX_CLIENTS = 8;

/** 门控：与 cost-track.enabled() 同构，默认关。 */
function enabled() {
  const v = process.env.PROXY_CONTEXT_TRACK;
  return v === '1' || v === 'true' || v === 'on';
}

function toolNamesOf(request) {
  if (!request || !Array.isArray(request.tools)) return null;
  const names = [];
  for (const t of request.tools) {
    if (typeof t === 'string') { names.push(t); continue; }
    if (t && typeof t === 'object') {
      const n = (t.function && t.function.name) ? t.function.name : t.name;
      if (typeof n === 'string' && n) names.push(n);
    }
  }
  return names;
}

class ContextReporter {
  constructor(opts = {}) {
    this.agent = opts.agent || 'lane';
    this.fold = createContextFold();
    /** clientKey → 上一帧 { total, model, toolNames }（只存帧，不存正文） */
    this._lastFrame = new Map();
  }

  _rememberFrame(clientKey, frame) {
    if (this._lastFrame.size >= MAX_CLIENTS && !this._lastFrame.has(clientKey)) {
      const oldest = this._lastFrame.keys().next().value;
      this._lastFrame.delete(oldest);
    }
    this._lastFrame.set(clientKey, frame);
  }

  /**
   * 观测一次请求。门控关 / 任何异常 → 静默返回（绝不拖累转发）。
   * @param {object} o { agent?, reqId?, model?, requestModel?, clientKey?, request, actuals? }
   */
  observe(o) {
    try {
      if (!enabled()) return null;
      if (!o || typeof o !== 'object' || !o.request) return null;

      const clientKey = (typeof o.clientKey === 'string' && o.clientKey) || 'default';
      const prev = this._lastFrame.get(clientKey) || null;

      const folded = this.fold.fold(o.request, { actuals: o.actuals || null });
      const curr = {
        total: folded.estimate.total,
        model: typeof o.model === 'string' ? o.model : null,
        toolNames: toolNamesOf(o.request),
      };
      const events = inferEvents(prev, curr);
      this._rememberFrame(clientKey, curr);

      const payload = {
        agent: o.agent || this.agent,
        reqId: o.reqId || null,
        model: o.model || null,
        requestModel: o.requestModel || null,
        clientKey,
        frame: {
          estimate: folded.estimate,
          actual: folded.actual,
          source: folded.source,
          warnings: folded.warnings,
        },
        events,
        ts: Date.now(),
      };
      this._ship(payload);
      return payload;
    } catch {
      return null; // 观测失败不是转发失败
    }
  }

  /** fire-and-forget：2s 超时，失败只吞。 */
  _ship(payload) {
    try {
      const url = `${MANAGER_URL.replace(/\/$/, '')}/api/context/report`;
      const headers = { 'Content-Type': 'application/json' };
      if (AGENT_TOKEN) headers['x-agent-token'] = AGENT_TOKEN;
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SHIP_TIMEOUT_MS),
      }).catch(() => { /* 观测链路故障不冒泡 */ });
    } catch { /* 同左 */ }
  }

  /** 测试/诊断用：清空帧记忆。 */
  reset() { this._lastFrame.clear(); }
}

const _singleton = new ContextReporter();

module.exports = {
  enabled,
  ContextReporter,
  // 单例转发（lane 直接 require 即用）。
  // ⚠️ 必须 bind 到单例：裸方法引用 `cr.observe()` 调时 this 会指向 exports 而非 _singleton，
  // 导致 this._lastFrame / this.fold 为 undefined 直接抛错（已修）。
  observe: _singleton.observe.bind(_singleton),
  reset: _singleton.reset.bind(_singleton),
  MANAGER_URL,
};
