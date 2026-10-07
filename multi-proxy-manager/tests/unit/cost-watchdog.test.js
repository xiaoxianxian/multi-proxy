'use strict';
const W = require('../../../l2/savings-gateway/cost-watchdog.js');

// G1 硬上限（task1 二期 · 取自 Paperclip 预算模型「到限暂停」）
// 三档优先级：hardCap > critical > warn；hardCap=0 默认不拦（YAGNI，零行为变更）。
describe('cost-watchdog G1 硬上限 (l2/savings-gateway/cost-watchdog.js)', () => {
  // large 档：1000in+500out → 0.096 CNY（与 gateway.js DEFAULT_PRICING.large 一致）
  const entry = { ts: 1000, actualTier: 'large', promptTokens: 1000, completionTokens: 500, actualCost: 0.096 };

  test('默认 hardCap=0 → 永不 block，旧行为不变（ok→critical 照常）', () => {
    const w = W.createCostWatchdog({ config: { criticalBudget: 0.2 } });
    w.record(entry, { now: 1000 });
    expect(w.state().block).toBe(false);
    expect(w.state().level).toBe('ok');
    w.record(entry, { now: 2000 }); // 0.192
    expect(w.state().block).toBe(false);
    w.record(entry, { now: 3000 }); // 0.288 > 0.2 → critical
    expect(w.state().level).toBe('critical');
    expect(w.state().block).toBe(false);
  });

  test('G1：累计越过 hardCap → level=blocked、block=true、action=block、downgradeTo=null', () => {
    const w = W.createCostWatchdog({ config: { hardCap: 0.2 } });
    w.record(entry, { now: 1000 });
    expect(w.state().level).toBe('ok');
    expect(w.state().block).toBe(false);
    const r2 = w.record(entry, { now: 2000 }); // 0.192 < 0.2 → ok
    expect(r2.block).toBe(false);
    const r3 = w.record(entry, { now: 3000 }); // 0.288 >= 0.2 → blocked
    expect(r3.level).toBe('blocked');
    expect(r3.block).toBe(true);
    expect(r3.action).toBe('block');
    expect(r3.downgradeTo).toBeNull();
    expect(w.state().block).toBe(true);
    expect(w.state().level).toBe('blocked');
  });

  test('G1：blocked 优先级高于 critical/warn（同一累计先判 hardCap）', () => {
    const w = W.createCostWatchdog({ config: { warnBudget: 0.1, criticalBudget: 0.15, hardCap: 0.2 } });
    expect(w.record(entry, { now: 1000 }).level).toBe('ok');        // 0.096
    expect(w.record(entry, { now: 2000 }).level).toBe('critical');  // 0.192 >= 0.15
    const r = w.record(entry, { now: 3000 });                       // 0.288 >= 0.2
    expect(r.level).toBe('blocked');
    expect(r.block).toBe(true);
    expect(w.state().level).toBe('blocked');
  });

  test('G1：produceAlertSignal 在 blocked 时 level=blocked、budget=hardCap、block=true', () => {
    const w = W.createCostWatchdog({ config: { hardCap: 0.2 } });
    w.record(entry, { now: 1000 });
    w.record(entry, { now: 2000 });
    w.record(entry, { now: 3000 });
    const sig = w.produceAlertSignal({ now: 3000 });
    expect(sig.level).toBe('blocked');
    expect(sig.budget).toBe(0.2);
    expect(sig.block).toBe(true);
    expect(sig.cost).toBe(0.288);
  });

  test('G1：report 在 blocked 时 level=blocked 且带 hardCap 字段', () => {
    const w = W.createCostWatchdog({ config: { hardCap: 0.2 } });
    w.record(entry, { now: 1000 });
    w.record(entry, { now: 2000 });
    w.record(entry, { now: 3000 });
    const rep = w.report({ now: 3000 });
    expect(rep.level).toBe('blocked');
    expect(rep.hardCap).toBe(0.2);
    expect(rep.cumulative).toBe(0.288);
  });

  test('G1：hardCap 经 env PROXY_COST_HARDCAP 覆盖', () => {
    process.env.PROXY_COST_HARDCAP = '0.2';
    try {
      const w = W.createCostWatchdog();
      w.record(entry, { now: 1000 });
      w.record(entry, { now: 2000 });
      w.record(entry, { now: 3000 });
      expect(w.state().block).toBe(true);
      expect(w.state().hardCap).toBe(0.2);
    } finally {
      delete process.env.PROXY_COST_HARDCAP;
    }
  });

  test('G1：state().hardCap 字段随配置暴露（门控/观测用）', () => {
    const w = W.createCostWatchdog({ config: { hardCap: 5 } });
    expect(w.state().hardCap).toBe(5);
    expect(w.state().block).toBe(false);
  });
});

// G2 阈值告警（task1 二期 · 取自 Paperclip「阈值告警」）：累计达 hardCap 的 80%/95% 发告警
// 事件型、每档只 fire 一次、回落到阈值以下自动 re-arm；hardCap=0 默认不触发（贴合非侵入纪律）。
describe('cost-watchdog G2 阈值告警 (l2/savings-gateway/cost-watchdog.js)', () => {
  const entry = { ts: 1000, actualTier: 'large', promptTokens: 1000, completionTokens: 500, actualCost: 0.096 };

  test('G2：第 1 笔(0.096)不触发，第 2 笔(0.192)同时触发 warn80+warn95', () => {
    const w = W.createCostWatchdog({ config: { hardCap: 0.2 } }); // 80%=0.16, 95%=0.19
    const r1 = w.record(entry, { now: 1000 });
    expect(r1.thresholdAlerts).toEqual([]);
    const r2 = w.record(entry, { now: 2000 });
    expect(r2.thresholdAlerts.length).toBe(2);
    const levels = r2.thresholdAlerts.map((a) => a.level).sort();
    expect(levels).toEqual(['warn80', 'warn95']);
    const w80 = r2.thresholdAlerts.find((a) => a.level === 'warn80');
    expect(w80.threshold).toBeCloseTo(0.16, 6);
    expect(w80.ratio).toBeCloseTo(0.8, 6);
    const w95 = r2.thresholdAlerts.find((a) => a.level === 'warn95');
    expect(w95.threshold).toBeCloseTo(0.19, 6);
  });

  test('G2：fire-once — 第 3 笔不再重复触发，firedRatiosCount=2', () => {
    const w = W.createCostWatchdog({ config: { hardCap: 0.2 } });
    w.record(entry, { now: 1000 });
    const r2 = w.record(entry, { now: 2000 });
    expect(r2.thresholdAlerts.length).toBe(2);
    const r3 = w.record(entry, { now: 3000 });
    expect(r3.thresholdAlerts).toEqual([]);
    expect(w.state().firedRatiosCount).toBe(2);
  });

  test('G2：hardCap=0 默认不触发阈值告警（零行为变更）', () => {
    const w = W.createCostWatchdog(); // hardCap=0
    for (let i = 0; i < 10; i++) w.record(entry, { now: 1000 + i * 1000 });
    expect(w.record(entry, { now: 99999 }).thresholdAlerts).toEqual([]);
  });

  test('G2：alertRatios=[] → 不发任何阈值告警', () => {
    const w = W.createCostWatchdog({ config: { hardCap: 0.2, alertRatios: [] } });
    w.record(entry, { now: 1000 });
    const r = w.record(entry, { now: 2000 });
    expect(r.thresholdAlerts).toEqual([]);
  });

  test('G2：report 暴露 alertRatios + firedRatiosCount', () => {
    const w = W.createCostWatchdog({ config: { hardCap: 0.2 } });
    w.record(entry, { now: 1000 });
    w.record(entry, { now: 2000 });
    const rep = w.report({ now: 2000 });
    expect(rep.alertRatios).toEqual([0.8, 0.95]);
    expect(rep.firedRatiosCount).toBe(2);
  });

  test('G2：re-arm — 窗口重置使成本回落后可再次触发', () => {
    // 不带 ts 的 entry，让 io.now 驱动 ts（窗口过滤依赖真实 ts）
    const e2 = { actualTier: 'large', promptTokens: 1000, completionTokens: 500, actualCost: 0.096 };
    const w = W.createCostWatchdog({ config: { hardCap: 0.2, windowMs: 1500 } });
    w.record(e2, { now: 1000 });
    const r2 = w.record(e2, { now: 2000 }); // 0.192 触发
    expect(r2.thresholdAlerts.length).toBe(2);
    const r3 = w.record(e2, { now: 4000 }); // cutoff=2500 → 旧条目全过期，累计归零 → re-arm
    expect(r3.thresholdAlerts).toEqual([]);
    const r4 = w.record(e2, { now: 4100 }); // 0.192 再次触发
    expect(r4.thresholdAlerts.length).toBe(2);
  });
});
