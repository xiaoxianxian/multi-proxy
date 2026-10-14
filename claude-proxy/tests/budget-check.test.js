// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * P7-2：预算预检纯函数 + 三态 decide。全部注入 fetchImpl / 写到 tmp，不碰网络不碰真实数据目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const bc = require('../budget-check.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-p7-'));
const SNAP = path.join(tmp, 'budget-snapshot.json');

const NOW = new Date('2026-10-12T10:00:00Z');
const PRICES = { 'deepseek-v4-flash': { input: 1, output: 2 } };

const baseSnap = (over = {}) => ({
  enabled: true,
  period: '2026-10',
  remaining: 100,
  configHash: 'h1',
  prices: PRICES,
  caps: { total: 100, perModel: {}, perAgent: {} },
  ...over,
});

const okFetch = (snap) => async () => ({ ok: true, status: 200, json: async () => snap });
const failFetch = async () => { throw new Error('ECONNREFUSED'); };
const notOkFetch = async () => ({ ok: false, error: 'HTTP 500' });

beforeEach(() => { bc.resetStateForTest(); if (fs.existsSync(SNAP)) fs.unlinkSync(SNAP); });

describe('budget-check 纯函数', () => {
  test('extractMaxTokens：认 max_tokens / max_completion_tokens，脏值返回 null', () => {
    expect(bc.extractMaxTokens({ max_tokens: 1000 })).toBe(1000);
    expect(bc.extractMaxTokens({ max_completion_tokens: 2000 })).toBe(2000);
    expect(bc.extractMaxTokens({ max_tokens: -1 })).toBe(null);
    expect(bc.extractMaxTokens({})).toBe(null);
    expect(bc.extractMaxTokens(null)).toBe(null);
  });

  test('lookupPrice：大小写不敏感', () => {
    expect(bc.lookupPrice(PRICES, 'deepseek-v4-flash').output).toBe(2);
    expect(bc.lookupPrice(PRICES, 'DeepSeek-V4-Flash').output).toBe(2);
    expect(bc.lookupPrice(PRICES, 'nope')).toBe(null);
  });

  test('estimateWorstCaseCost：max_tokens 全按输出价，缺价返回 null', () => {
    expect(bc.estimateWorstCaseCost(1000, { input: 1, output: 2 })).toBeCloseTo(0.002);
    expect(bc.estimateWorstCaseCost(1000, { input: 1 })).toBe(null); // 无输出价
    expect(bc.estimateWorstCaseCost(null, { output: 2 })).toBe(null);
  });

  test('periodKeyForNow / periodMatches：月 vs 日宽度对齐', () => {
    expect(bc.periodKeyForNow(new Date('2026-10-12T00:00:00Z'))).toBe('2026-10-12');
    expect(bc.periodMatches('2026-10', NOW)).toBe(true);   // 月快照 vs 当月
    expect(bc.periodMatches('2026-09', NOW)).toBe(false);  // 跨月
    expect(bc.periodMatches('2026-10-12', NOW)).toBe(true); // 日快照
  });

  test('isFresh：启用 + at + TTL 内 + 同周期', () => {
    const fresh = baseSnap({ at: NOW.getTime() });
    expect(bc.isFresh(fresh, NOW, 10 * 60 * 1000)).toBe(true);
    expect(bc.isFresh(fresh, new Date(NOW.getTime() + 11 * 60 * 1000), 10 * 60 * 1000)).toBe(false); // TTL 外
    expect(bc.isFresh(baseSnap({ at: NOW.getTime(), period: '2026-09' }), NOW, 10 * 60 * 1000)).toBe(false); // 跨周期
    expect(bc.isFresh(baseSnap({ enabled: false }), NOW, 10 * 60 * 1000)).toBe(false);
  });

  test('evaluate：disabled / no-estimate 放行；剩额不足拦', () => {
    expect(bc.evaluate(null, 1000, null).allowed).toBe(true);                 // 没快照
    expect(bc.evaluate('deepseek-v4-flash', 1000, baseSnap({ prices: {} })).allowed).toBe(true); // 无价
    const ok = bc.evaluate('deepseek-v4-flash', 1000, baseSnap({ remaining: 100 }));
    expect(ok.allowed).toBe(true); expect(ok.estimate).toBeCloseTo(0.002);
    const blocked = bc.evaluate('deepseek-v4-flash', 1000, baseSnap({ remaining: 0.001 }));
    expect(blocked.allowed).toBe(false); expect(blocked.deficit).toBeCloseTo(0.001);
  });
});

describe('fetchBudgetSnapshot：超时 / 错误不抛，走 ok:false', () => {
  test('成功解析 snap', async () => {
    const r = await bc.fetchBudgetSnapshot({ fetchImpl: okFetch(baseSnap()), timeoutMs: 500 });
    expect(r.ok).toBe(true); expect(r.snap.enabled).toBe(true);
  });
  test('throw → ok:false（不崩）', async () => {
    const r = await bc.fetchBudgetSnapshot({ fetchImpl: failFetch, timeoutMs: 200 });
    expect(r.ok).toBe(false);
  });
  test('ok:false → ok:false', async () => {
    const r = await bc.fetchBudgetSnapshot({ fetchImpl: notOkFetch, timeoutMs: 200 });
    expect(r.ok).toBe(false);
  });
});

describe('decide 三态', () => {
  test('exact：manager 可达 → 精确判级（剩额足放行）', async () => {
    const r = await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: okFetch(baseSnap({ remaining: 100 })) });
    expect(r.state).toBe('exact'); expect(r.allowed).toBe(true); expect(r.remaining).toBe(100);
    expect(bc.getStatus().mode).toBe('exact');
  });

  test('exact：剩额不足 → 拦截', async () => {
    const r = await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: okFetch(baseSnap({ remaining: 0.001 })) });
    expect(r.state).toBe('exact'); expect(r.allowed).toBe(false); expect(r.code || r.source).toBeDefined();
  });

  test('open：manager 不可达 + 无快照 → fail-open 放行', async () => {
    const r = await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: failFetch });
    expect(r.state).toBe('open'); expect(r.allowed).toBe(true); expect(r.source).toBe('fail-open');
  });

  test('degraded：manager 先成功后挂 → 对快照判 + 本地累加最坏估计', async () => {
    // 第一发：manager 在，写快照（remaining 0.003，每笔估 0.002）
    const r1 = await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: okFetch(baseSnap({ remaining: 0.003 })) });
    expect(r1.state).toBe('exact'); expect(r1.allowed).toBe(true);
    // 第二发：manager 挂 → 降级，remaining 0.003 - 0 = 0.003 >= 0.002 放行，accLocal=0.002
    const r2 = await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: failFetch });
    expect(r2.state).toBe('degraded'); expect(r2.allowed).toBe(true);
    expect(bc.getStatus().accLocal).toBeCloseTo(0.002);
    // 第三发：降级，remaining 0.003 - 0.002 = 0.001 < 0.002 → 拦
    const r3 = await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: failFetch });
    expect(r3.state).toBe('degraded'); expect(r3.allowed).toBe(false);
  });

  test('degraded→exact 恢复：manager 回来用真剩额，accLocal 清零', async () => {
    await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: okFetch(baseSnap({ remaining: 0.003 })) });
    await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: failFetch }); // 降级累加
    expect(bc.getStatus().accLocal).toBeGreaterThan(0);
    const r = await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: okFetch(baseSnap({ remaining: 100 })) });
    expect(r.state).toBe('exact'); expect(r.allowed).toBe(true);
    expect(bc.getStatus().accLocal).toBe(0); // 精确模式清零 pessimism buffer
  });

  test('快照落盘：degraded 后 accLocal 写进文件，重启可读回', async () => {
    await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: okFetch(baseSnap({ remaining: 0.003 })), snapshotFile: SNAP });
    await bc.decide('deepseek-v4-flash', 1000, { now: NOW, fetchImpl: failFetch, snapshotFile: SNAP });
    const onDisk = bc.loadSnapshotFile(SNAP);
    expect(onDisk.accLocal).toBeCloseTo(0.002);
    expect(onDisk.mode).toBe('degraded');
    // 模拟重启：seed 回内存
    bc.resetStateForTest();
    expect(bc.getStatus().enabled).toBe(false);
    bc.seedStateFromFile(SNAP);
    expect(bc.getStatus().accLocal).toBeCloseTo(0.002);
  });
});
