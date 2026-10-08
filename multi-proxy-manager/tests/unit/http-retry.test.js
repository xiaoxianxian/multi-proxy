// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// l2/http-retry.js 单测：不依赖网络，用 mock fn 验证退避行为。

const { withHttpRetry, parseRetryAfter, backoffDelay, HTTP_RETRY_DEFAULTS } = require('../../../l2/http-retry.js');

describe('parseRetryAfter', () => {
  it('解析 delta-seconds', () => {
    expect(parseRetryAfter({ 'retry-after': '30' })).toBe(30);
  });
  it('解析 HTTP-date', () => {
    const future = new Date(Date.now() + 120000).toUTCString();
    const v = parseRetryAfter({ 'retry-after': future });
    expect(v).toBeGreaterThanOrEqual(118);
    expect(v).toBeLessThanOrEqual(120);
  });
  it('无头 / 空返回 null', () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter({})).toBeNull();
    expect(parseRetryAfter({ 'retry-after': '' })).toBeNull();
  });
});

describe('backoffDelay', () => {
  it('指数封顶且不超 maxDelayMs', () => {
    expect(backoffDelay(0, { baseDelayMs: 500, maxDelayMs: 8000 })).toBeLessThanOrEqual(8000);
    expect(backoffDelay(10, { baseDelayMs: 500, maxDelayMs: 8000 })).toBeLessThanOrEqual(8000);
    // 抖动 ±25% 下仍 ≥ 0
    expect(backoffDelay(0, { baseDelayMs: 500, maxDelayMs: 8000 })).toBeGreaterThanOrEqual(0);
  });
});

describe('withHttpRetry', () => {
  it('首次成功直接返回，不重试', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 200, body: 'ok' });
    const r = await withHttpRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(r.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('429 时按 maxRetries 重试，最终恢复', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce({ status: 429, body: '', headers: { 'retry-after': '0' } })
      .mockResolvedValueOnce({ status: 429, body: '', headers: { 'retry-after': '0' } })
      .mockResolvedValueOnce({ status: 200, body: 'recovered' });
    const r = await withHttpRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(r.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('超过 maxRetries 后抛出最后一次网络错', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(withHttpRetry(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 }))
      .rejects.toThrow('ECONNRESET');
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('不可重试的 4xx（401）不重试', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 401, body: 'no' });
    const r = await withHttpRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(r.status).toBe(401);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('尊重 Retry-After 给出的等待（约 1s）', async () => {
    const start = Date.now();
    const fn = jest.fn()
      .mockResolvedValueOnce({ status: 429, body: '', headers: { 'retry-after': '1' } })
      .mockResolvedValueOnce({ status: 200, body: 'ok' });
    await withHttpRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(950); // 至少等了约 1s
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('5xx 也重试', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce({ status: 503, body: '', headers: {} })
      .mockResolvedValueOnce({ status: 200, body: 'ok' });
    const r = await withHttpRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(r.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('默认 retryStatuses 不含 400', () => {
    expect(HTTP_RETRY_DEFAULTS.retryStatuses.has(400)).toBe(false);
    expect(HTTP_RETRY_DEFAULTS.retryStatuses.has(429)).toBe(true);
  });
});
