// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

const BG = require('../../lib/budget-guard');

describe('P7 budget-guard: parseBudgetConfig', () => {
  test('null → ok + config:null（没配预算）', () => {
    expect(BG.parseBudgetConfig(null)).toEqual({ ok: true, config: null });
  });

  test('缺省值全部偏向「不拦」：月周期 / hardCap=0 / warnRatio=0.8', () => {
    const { ok, config } = BG.parseBudgetConfig({});
    expect(ok).toBe(true);
    expect(config).toMatchObject({ period: 'monthly', hardCap: 0, warnRatio: 0.8, perModel: {}, perAgent: {} });
  });

  test('合法全量配置', () => {
    const { ok, config } = BG.parseBudgetConfig({
      period: 'daily', hardCap: 5, warnRatio: 0.5, timezone: 'Asia/Shanghai',
      perModel: { 'deepseek-v4-flash': 2 }, perAgent: { dsh: 3 },
    });
    expect(ok).toBe(true);
    expect(config).toMatchObject({ period: 'daily', hardCap: 5, warnRatio: 0.5, timezone: 'Asia/Shanghai' });
    expect(config.perModel).toEqual({ 'deepseek-v4-flash': 2 });
    expect(config.perAgent).toEqual({ dsh: 3 });
  });

  test('畸形一律 ok:false + 说清哪儿不对', () => {
    expect(BG.parseBudgetConfig([]).ok).toBe(false);
    expect(BG.parseBudgetConfig({ period: 'weekly' }).error).toMatch(/period/);
    expect(BG.parseBudgetConfig({ hardCap: -1 }).error).toMatch(/hardCap/);
    expect(BG.parseBudgetConfig({ hardCap: 'abc' }).error).toMatch(/hardCap/);
    expect(BG.parseBudgetConfig({ warnRatio: 1.5 }).error).toMatch(/warnRatio/);
    expect(BG.parseBudgetConfig({ warnRatio: 0 }).error).toMatch(/warnRatio/);
    expect(BG.parseBudgetConfig({ timezone: '' }).error).toMatch(/timezone/);
    expect(BG.parseBudgetConfig({ perModel: [] }).error).toMatch(/perModel/);
    expect(BG.parseBudgetConfig({ perModel: { m: -2 } }).error).toMatch(/perModel\.m/);
    expect(BG.parseBudgetConfig({ perAgent: { a: 'x' } }).error).toMatch(/perAgent\.a/);
  });
});

describe('P7 budget-guard: periodKey', () => {
  test('monthly → YYYY-MM；daily → YYYY-MM-DD', () => {
    const ts = '2026-10-12T03:00:00.000Z';
    expect(BG.periodKey(ts, 'monthly')).toMatch(/^2026-10(0[1-9]|1[0-2])?$/);   // 时区可能跨月，锁不住具体日
    expect(BG.periodKey(ts, 'daily')).toMatch(/^2026-10-\d{2}$/);
  });

  test('timezone 决定周期归属：UTC 10-01 16:30 = 上海 10-02 00:30', () => {
    const ts = '2026-10-01T16:30:00.000Z';
    // 同一时刻：UTC 口径还在 10 月 1 日，上海口径已进 10 月 2 日
    expect(BG.periodKey(ts, 'daily', 'UTC')).toBe('2026-10-01');
    expect(BG.periodKey(ts, 'daily', 'Asia/Shanghai')).toBe('2026-10-02');
    // monthly 同月（这个例子特意选不跨月的时刻，锁「天级才随时区跳」）
    expect(BG.periodKey(ts, 'monthly', 'UTC')).toBe(BG.periodKey(ts, 'monthly', 'Asia/Shanghai'));
  });

  test('坏时间戳 → null（不猜周期）', () => {
    expect(BG.periodKey('not-a-date', 'monthly')).toBeNull();
    expect(BG.periodKey(undefined, 'monthly')).toBeNull();
  });
});

describe('P7 budget-guard: estimateWorstCaseCost / canAfford', () => {
  test('最坏情况 = max_tokens 全按输出价', () => {
    // 1M output token × ¥8/M = ¥8
    expect(BG.estimateWorstCaseCost(1_000_000, { input: 2, output: 8 })).toBeCloseTo(8, 10);
    expect(BG.estimateWorstCaseCost(500_000, { output: 8 })).toBeCloseTo(4, 10);
  });

  test('估不出 → null（不猜 0）', () => {
    expect(BG.estimateWorstCaseCost(1000, { input: 2 })).toBeNull();       // 没 output 价
    expect(BG.estimateWorstCaseCost(1000, null)).toBeNull();
    expect(BG.estimateWorstCaseCost(0, { output: 8 })).toBeNull();
    expect(BG.estimateWorstCaseCost(-5, { output: 8 })).toBeNull();
    expect(BG.estimateWorstCaseCost('abc', { output: 8 })).toBeNull();
  });

  test('canAfford：没预算不预拒、估不出不预拒', () => {
    expect(BG.canAfford(8, null)).toBe(true);      // 没设预算
    expect(BG.canAfford(null, 3)).toBe(true);      // 估不出
    expect(BG.canAfford(3, 3)).toBe(true);         // 恰好够（>= 边界含）
    expect(BG.canAfford(3.01, 3)).toBe(false);
  });
});

describe('P7 budget-guard: evaluateBudget', () => {
  const NOW = new Date('2026-10-12T10:00:00.000Z');
  const cfg = (over = {}) => BG.parseBudgetConfig({
    period: 'monthly', hardCap: 10, warnRatio: 0.8, timezone: 'UTC', ...over,
  }).config;

  const entry = (over = {}) => ({
    ts: '2026-10-12T09:00:00.000Z', proxy: 'codex-proxy', agent: 'dsh',
    model: 'deepseek-v4-flash', cost: 1, pricingSource: 'model', ...over,
  });

  test('没配预算 / hardCap=0 → enabled:false（零行为变更）', () => {
    expect(BG.evaluateBudget([entry()], null, { now: NOW }).enabled).toBe(false);
    expect(BG.evaluateBudget([entry()], BG.parseBudgetConfig({}).config, { now: NOW }).enabled).toBe(false);
    expect(BG.evaluateBudget([entry()], null, { now: NOW }).reason).toBe('no-budget-config');
  });

  test('只累计当前周期：上月账单不计入本月', () => {
    const r = BG.evaluateBudget([
      entry({ ts: '2026-09-30T23:00:00.000Z', cost: 999 }),   // 上月
      entry({ cost: 2 }),
    ], cfg(), { now: NOW });
    expect(r.enabled).toBe(true);
    expect(r.spent).toBe(2);
    expect(r.entryCount).toBe(1);
  });

  test('三档判级：ok → warn（≥80%）→ blocked（越过上限）', () => {
    expect(BG.evaluateBudget([entry({ cost: 1 })], cfg(), { now: NOW }).level).toBe('ok');
    expect(BG.evaluateBudget([entry({ cost: 8 })], cfg(), { now: NOW }).level).toBe('warn');
    const r = BG.evaluateBudget([entry({ cost: 10 })], cfg(), { now: NOW });
    expect(r.level).toBe('blocked');
    expect(r.exceeded).toEqual([{ scope: 'total', spent: 10, cap: 10 }]);
    expect(r.remaining).toBe(0);
  });

  test('perModel 子项上限：总账没超、单模型超了也 blocked', () => {
    const r = BG.evaluateBudget([
      entry({ model: 'deepseek-v4-flash', cost: 4 }),
      entry({ model: 'kimi-k2.6', cost: 3 }),
    ], cfg({ perModel: { 'kimi-k2.6': 2 } }), { now: NOW });
    expect(r.level).toBe('blocked');
    expect(r.exceeded).toEqual([{ scope: 'model:kimi-k2.6', spent: 3, cap: 2 }]);
    expect(r.perModel).toEqual({ 'deepseek-v4-flash': 4, 'kimi-k2.6': 3 });
  });

  test('perAgent 子项上限', () => {
    const r = BG.evaluateBudget([
      entry({ agent: 'dsh', cost: 1 }),
      entry({ agent: 'codex', cost: 5 }),
    ], cfg({ perAgent: { codex: 3 } }), { now: NOW });
    expect(r.level).toBe('blocked');
    expect(r.exceeded).toEqual([{ scope: 'agent:codex', spent: 5, cap: 3 }]);
  });

  test('未定价条目：跳过累计 + 单独计数（「花了 0」和「有 N 笔没价」必须分得开）', () => {
    const r = BG.evaluateBudget([
      entry({ cost: 2 }),
      entry({ cost: undefined }),                              // 缺 cost
      entry({ cost: 0, pricingSource: 'unknown' }),            // 0 元但来源是「没价」
    ], cfg(), { now: NOW });
    expect(r.spent).toBe(2);
    expect(r.unpricedCount).toBe(2);
    expect(r.entryCount).toBe(3);
  });

  test('daily 周期：昨天的账不算今天', () => {
    const c = cfg({ period: 'daily', hardCap: 5 });
    const r = BG.evaluateBudget([
      entry({ ts: '2026-10-11T23:00:00.000Z', cost: 99 }),
      entry({ ts: '2026-10-12T09:00:00.000Z', cost: 1 }),
    ], c, { now: NOW });
    expect(r.period).toBe('2026-10-12');
    expect(r.spent).toBe(1);
  });

  test('entries 不是数组 → 不炸，按空账本判', () => {
    const r = BG.evaluateBudget(null, cfg(), { now: NOW });
    expect(r.enabled).toBe(true);
    expect(r.spent).toBe(0);
    expect(r.level).toBe('ok');
  });
});
