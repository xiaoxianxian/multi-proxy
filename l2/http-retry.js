// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// 上游退避重试底座（零外部依赖，仅 node 内置）。
//
// 这是「429 / 5xx / 网络错不再杀死一次运行」的 durable 修复：
//   - L1 adapter 的 chat 出网路径用它（见 l2/adapters/l1-agent-adapter.js）；
//   - 任何将来打上游的 sweep / 校准脚本也应复用，而不是各写各的 ad-hoc 重试。
//
// 设计边界（与本项目「零依赖·只读·非侵入」铁律一致）：
//   - 只对**可重试**的条件重试：429（限流）/ 5xx（上游抖动）/ 网络错·超时（throw）。
//   - 尊重上游 Retry-After（权威等待指令），无则指数退避 + 抖动，封顶防惊群。
//   - 不可重试的 4xx（如 401 鉴权失败 / 400 请求错）**不重试**，直接返回给上层判错——
//     这类是配置/请求问题，重试只会放大错误与成本。

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// 解析 Retry-After（秒）。支持 delta-seconds 与 HTTP-date 两种形式；node http 头名已小写。
function parseRetryAfter(headers) {
  if (!headers) return null;
  const v = headers['retry-after'];
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const date = Date.parse(s);
  if (!isNaN(date)) {
    const delta = Math.floor((date - Date.now()) / 1000);
    return delta > 0 ? delta : null;
  }
  return null;
}

// 指数退避：base * 2^attempt，加 ±25% 抖动避免惊群，最后封顶 maxDelayMs。
// 注意：抖动必须在封顶「之后」再 clamp 一次——否则 raw 已顶到 maxDelayMs 时，
// +25% 抖动会让最终等待突破上限，使封顶形同虚设（惊群风险回归）。
function backoffDelay(attempt, { baseDelayMs = 500, maxDelayMs = 8000 } = {}) {
  const base = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.min(maxDelayMs, Math.round(base + jitter)));
}

const RETRY_AFTER_CAP_MS = 60000; // 尊重上游指令但不等荒谬时长

const HTTP_RETRY_DEFAULTS = {
  maxRetries: 3,                 // 最多额外重试 3 次（共 4 次尝试）
  baseDelayMs: 500,
  maxDelayMs: 8000,
  retryStatuses: new Set([429, 500, 502, 503, 504]),
  retryOnThrow: true,            // 网络错 / 超时也重试
  logger: null,                  // 可选：(attempt, info) => void
};

/**
 * 包裹一个「返回 {status, body, headers?} 或抛错」的上游调用。
 * @param {() => Promise<{status:number, body:string, headers?:object}>} fn
 * @returns {Promise<{status:number, body:string, headers?:object}>}
 */
async function withHttpRetry(fn, opts = {}) {
  const cfg = Object.assign({}, HTTP_RETRY_DEFAULTS, opts);
  const statuses = cfg.retryStatuses instanceof Set ? cfg.retryStatuses : new Set(cfg.retryStatuses);
  let lastErr = null;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const res = await fn();
      if (res && statuses.has(res.status) && attempt < cfg.maxRetries) {
        const retryAfter = parseRetryAfter(res.headers);
        const wait = (retryAfter && retryAfter > 0)
          ? Math.min(retryAfter * 1000, RETRY_AFTER_CAP_MS)
          : backoffDelay(attempt, cfg);
        if (cfg.logger) cfg.logger(attempt + 1, { status: res.status, retryAfter, wait });
        await sleep(wait);
        continue;
      }
      return res; // 成功 / 不可重试的 4xx（401/400）—— 直接返回给上层
    } catch (e) {
      lastErr = e;
      if (cfg.retryOnThrow && attempt < cfg.maxRetries) {
        const wait = backoffDelay(attempt, cfg);
        if (cfg.logger) cfg.logger(attempt + 1, { error: e && e.message, wait });
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
}

module.exports = { sleep, parseRetryAfter, backoffDelay, withHttpRetry, HTTP_RETRY_DEFAULTS, RETRY_AFTER_CAP_MS };
