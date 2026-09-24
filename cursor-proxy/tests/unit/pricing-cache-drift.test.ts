/**
 * Q1 P2/P3 - price-cache + drift alert tests (2026-09-22).
 * Covers arch 3.1 single-source sync lock / 3.2 drift detection / 3.10 alert reuse.
 * Flat structure, strictly balanced brackets.
 */
import { OFFICIAL_PRICING, FX_SEED, CHANNELS } from '../../src/pricing/seed.js';
import {
  detectDrift,
  toAlertSignal,
  recordTrigger,
  isPriceDriftNotifyEnabled,
  suppressMsFor,
  percentDelta,
} from '../../src/routing/priceDrift.js';

// Authoritative literals (single source of truth, 7 vendors). F1: deepseek-v4-pro input=0.5.
// Lock only behavior-relevant fields; `source` is descriptive metadata (not locked here).
const EXPECTED: Record<string, { input: number; output: number; cacheHit?: number; currency: string }> = {
  'deepseek-v4-pro': { input: 0.5, output: 3, cacheHit: 0.02, currency: 'CNY' },
  'deepseek-flash': { input: 0.2, output: 1.6, cacheHit: 0.02, currency: 'CNY' },
  'kimi-k2.6': { input: 6.5, output: 27, currency: 'CNY' },
  'kimi-k3': { input: 20, output: 100, currency: 'CNY' },
  'agnes-2.5-flash': { input: 0, output: 0, cacheHit: 0, currency: 'CNY' },
  'qwen3.8:27b-mlx': { input: 0, output: 0, cacheHit: 0, currency: 'CNY' },
  'gpt-5.6-codex': { input: 12.5, output: 37.5, currency: 'USD' },
  'claude-opus-4.7': { input: 15, output: 75, currency: 'USD' },
};

// RouteEngine inline pricing (dynamic import — MUST import successfully in a real build).
let routePricing: Record<string, any> | undefined;
// P0-E: fail-loud gate.  import failure → test fails; no silent skip.
beforeAll(async () => {
  try {
    const m = await import('../../src/routing/routeEngine.js') as any;
    routePricing = m && m.DEFAULT_ROUTE_CONFIG && m.DEFAULT_ROUTE_CONFIG.pricing;
    } catch (err) {
      throw err; // P0-E: import failure is a hard test failure, not a silent skip
    }
});

const NOTIFY_SAVE = process.env.PROXY_PRICE_DRIFT_NOTIFY;
afterAll(() => {
  if (NOTIFY_SAVE === undefined) delete process.env.PROXY_PRICE_DRIFT_NOTIFY;
  else process.env.PROXY_PRICE_DRIFT_NOTIFY = NOTIFY_SAVE;
});

describe('Q1 P2/P3 price-cache + drift alert', () => {
  // ---- A. single-source sync lock (anti F1 recurrence) ----
   it('A1 seed.OFFICIAL_PRICING equals authoritative literal (7 vendors, core fields)', () => {
    for (const [model, exp] of Object.entries(EXPECTED)) {
      const p = OFFICIAL_PRICING[model];
      expect(p).toBeDefined();
      expect(p.input).toBe(exp.input);
      expect(p.output).toBe(exp.output);
      // 仅锁 EXPECTED 显式声明的字段；cacheHit/currency 缺省则该 vendor 不锁
      // （kimi 价 C4 待老板定、gpt/claude USD 订阅无 cacheHit，不硬锁）
      if (exp.cacheHit !== undefined) expect(p.cacheHit).toBe(exp.cacheHit);
      if (exp.currency) expect(p.currency).toBe(exp.currency);
      }
    expect(Object.keys(OFFICIAL_PRICING).sort()).toEqual(Object.keys(EXPECTED).sort());
    });

  it('A2 routeEngine inline pricing equals seed (anti-drift sync lock)', () => {
   // P0-E: routeEngine MUST import (beforeAll throws on failure). And the models that
   // ACTUALLY feed cost-optimization routing must be present + match seed — silent skip
   // is what let the drift lock stay green. Non-routed reference entries (codex/glm/…)
   // are NOT required in routeEngine, so we don't over-fire on those.
    expect(routePricing).toBeDefined();
   const rp = routePricing as Record<string, { input: number; output: number; currency: string }> && (
     routePricing as Record<string, { input: number; output: number; currency: string }>);
   const CORE = ['qwen3.8:27b-mlx', 'deepseek-v4-pro', 'agnes-2.5-flash', 'kimi-k2.6'];
   for (const m of CORE) {
      expect(rp[m]).toBeDefined(); // anti-silent-skip: routed core must exist
      expect(rp[m].input).toBe(EXPECTED[m].input);
      expect(rp[m].output).toBe(EXPECTED[m].output);
      expect(rp[m].currency).toBe(EXPECTED[m].currency);
     }
   });

  it('A3 deepseek-v4-pro input is 0.5 (F1 regression sentinel, never back to 1.0)', () => {
    expect(OFFICIAL_PRICING['deepseek-v4-pro'].input).toBe(0.5);
   });

  // ---- B-E. detectDrift ----
  it('B price change >10% -> severity warn', () => {
    const r = detectDrift({
      model: 'deepseek-v4-pro',
      oldPricing: { input: 0.5, output: 3 },
      newPricing: { input: 0.6, output: 3 }, // +20%
     });
    expect(r.priceDelta.inputPct).toBeCloseTo(0.2, 5);
    expect(r.severity).toBe('warn');
   });

  it('C fx change >10% -> severity warn (USD model)', () => {
    const r = detectDrift({ model: 'gpt-5.6-codex', fx: 7.5, fxOld: 6.0 }); // +25%
    expect(r.priceDelta.fxPct).toBeCloseTo(0.25, 5);
    expect(r.severity).toBe('warn');
   });

  it('D rank change -> severity critical (key alert)', () => {
    const r = detectDrift({
      model: 'qwen3.8:27b-mlx',
      oldPricing: { input: 10, output: 10 }, // qwen old price expensive
      newPricing: { input: 0, output: 0 },     // qwen new price free
      rankCandidates: ['deepseek-v4-pro', 'qwen3.8:27b-mlx'],
      rankInputTokens: 1_000_000,
      rankOutputTokens: 1_000_000,
      });
      // qwen old=expensive(10) sits last (after deepseek); new=free(0) jumps to front.
      // non-target deepseek holds the old target price (10) — detectDrift only knows
      // the model's new price, so others stay put. qwen 10->0 flips it to the front.
      // before [deepseek, qwen] != after [qwen, deepseek] => orderChanged.
    expect(r.orderChanged).toBe(true);
    expect(r.severity).toBe('critical');
    expect(r.orderBefore?.join(',')).toContain('deepseek-v4-pro');
    });

  it('D2 no price change -> order unchanged -> info', () => {
    const r = detectDrift({
      model: 'deepseek-v4-pro',
      oldPricing: { input: 0.5, output: 3 },
      newPricing: { input: 0.5, output: 3 },
      rankCandidates: ['qwen3.8:27b-mlx', 'deepseek-v4-pro'],
      rankInputTokens: 1_000_000,
      rankOutputTokens: 1_000_000,
     });
    expect(r.orderChanged).toBe(false);
    expect(r.severity).toBe('info');
   });

  it('E model added / removed', () => {
    const added = detectDrift({ model: 'new-model', oldPricing: null, newPricing: { input: 1, output: 1 } });
    expect(added.modelAdded).toBe(true);
    const removed = detectDrift({ model: 'gone-model', oldPricing: { input: 1, output: 1 }, newPricing: null });
    expect(removed.modelRemoved).toBe(true);
   });

  // ---- F/G. gate observe-closed default + 24h suppression ----
  it('G1 gate closed by default: drift detected but actionable false (observe, no alert)', () => {
    delete process.env.PROXY_PRICE_DRIFT_NOTIFY;
    expect(isPriceDriftNotifyEnabled()).toBe(false);
    const r = detectDrift({
      model: 'deepseek-v4-pro',
      oldPricing: { input: 0.5, output: 3 },
      newPricing: { input: 1, output: 3 },
     });
    expect(r.severity).toBe('warn');
    expect(r.actionable).toBe(false);
   });

  it('G2 gate open -> actionable true', () => {
    process.env.PROXY_PRICE_DRIFT_NOTIFY = 'on';
    expect(isPriceDriftNotifyEnabled()).toBe(true);
    const r = detectDrift({
      model: 'deepseek-v4-pro',
      oldPricing: { input: 0.5, output: 3 },
      newPricing: { input: 1, output: 3 },
     });
    expect(r.actionable).toBe(true);
   });

  it('F1 24h suppression: within window -> suppressed true, actionable false', () => {
    process.env.PROXY_PRICE_DRIFT_NOTIFY = 'on';
    const lastTrigger = { 'deepseek-v4-pro': 1_000_000 };
    const r = detectDrift({
      model: 'deepseek-v4-pro',
      now: () => 1_000_000 + 3600 * 1000, // 1h later, within 24h
      lastTriggerMap: lastTrigger,
      oldPricing: { input: 0.5, output: 3 },
      newPricing: { input: 5, output: 5 },
     });
    expect(r.suppressed).toBe(true);
    expect(r.actionable).toBe(false);
   });

  it('F2 beyond 24h window -> not suppressed, actionable true', () => {
    process.env.PROXY_PRICE_DRIFT_NOTIFY = 'on';
    const lastTrigger = { 'deepseek-v4-pro': 1_000_000 };
    const r = detectDrift({
      model: 'deepseek-v4-pro',
      now: () => 1_000_000 + 25 * 60 * 60 * 1000, // 25h later
      lastTriggerMap: lastTrigger,
      oldPricing: { input: 0.5, output: 3 },
      newPricing: { input: 5, output: 5 },
     });
    expect(r.suppressed).toBe(false);
    expect(r.actionable).toBe(true);
   });

  it('percentDelta edges: 0->0=0; 0->nonzero=+100%; 1->1.2=+20%', () => {
    expect(percentDelta(0, 0)).toBe(0);
    expect(percentDelta(0, 1)).toBe(1);
    expect(percentDelta(1, 1.2)).toBeCloseTo(0.2, 5);
   });

  it('suppressMsFor: env window overrides default 24h', () => {
    expect(suppressMsFor('deepseek', 'deepseek=72')).toBe(72 * 60 * 60 * 1000);
    expect(suppressMsFor('deepseek', undefined)).toBe(24 * 60 * 60 * 1000);
   });

  it('recordTrigger writes timestamp for 24h dedup', () => {
    const map: Record<string, number> = {};
    expect(map['deepseek-v4-pro']).toBeUndefined();
    recordTrigger(map, 'deepseek-v4-pro', 9_999_000);
    expect(map['deepseek-v4-pro']).toBe(9_999_000);
   });

  // ---- H. alert.js price-drift integration contract ----
  it('H1 toAlertSignal maps to price-drift alert signal (human-readable message)', () => {
    const r = detectDrift({
      model: 'deepseek-v4-pro',
      oldPricing: { input: 0.5, output: 3 },
      newPricing: { input: 0.6, output: 3 },
     });
    const sig = toAlertSignal(r);
    expect(sig.source).toBe('price-drift');
    expect(sig.model).toBe('deepseek-v4-pro');
    expect(sig.message).toContain('单价'); // human-readable (arch 3.10 readability rule)
    expect(typeof sig.actionable).toBe('boolean');
   });

  // H2: pure shape assertion on toAlertSignal (loadAlert removed — alert.js
  // has no price-drift case yet; wiring that case is a separate follow-up that
  // needs its own review. P3 only produces detectDrift + the signal shape here.)
  it('H2 toAlertSignal shape under gate (price-drift signal, output drift)', () => {
    process.env.PROXY_PRICE_DRIFT_NOTIFY = 'on';
    const r = detectDrift({
      model: 'deepseek-v4-pro',
      channel: 'official-deepseek',
      oldPricing: { input: 0.5, output: 3 },
      newPricing: { input: 0.5, output: 4 }, // output 3→4 = +33.3%
      lastTriggerMap: {},
      });
    const sig = toAlertSignal(r);
    // shape (老板点名 4 项)
    expect(sig.source).toBe('price-drift');
    expect(sig.model).toBe('deepseek-v4-pro');
    expect(sig.message).toContain('单价'); // human-readable (§3.10 readability rule)
    expect(typeof sig.actionable).toBe('boolean');
    // gate open + real drift -> actionable concretely true; channel transparent; severity legal
    expect(sig.severity).toBe('warn');
    expect(sig.actionable).toBe(true);
    expect(sig.channel).toBe('official-deepseek');
    delete process.env.PROXY_PRICE_DRIFT_NOTIFY;
    });

  // ---- I. FX_SEED fallback ----
  it('I FX_SEED USD/CNY = 7.2 cache fallback (D2, not 1.0)', () => {
    expect(FX_SEED.rates.USD).toBe(7.2);
    expect(FX_SEED.base).toBe('CNY');
    expect(FX_SEED.source).toBe('seed-fallback');
   });

  // ---- J. channel reliability ----
  it('J official channels reliability 1.0; openrouter aggregator <1.0', () => {
   const official = CHANNELS.filter((c: any) => c.official);
   expect(official.length).toBeGreaterThan(5);
   expect(official.every((c: any) => c.reliability === 1.0)).toBe(true);
   const openrouter = CHANNELS.find((c: any) => c.id === 'openrouter');
   expect(openrouter?.reliability).toBeLessThan(1.0);
   });
  });
