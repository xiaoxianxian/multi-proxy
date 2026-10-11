'use strict';
// P2（2026-10-12）保护网：model 级价表 + fallback 链 + pricingSource 标注。
//
// 核心要钉死的是维护者 2026-10-12 那句话：**「值是 0」和「值不存在」是不同参数**。
//   - agnes pricing={0,0,0} 但**带 priceSource** ⇒ 真免费 ⇒ source 必须是 'model'
//   - 没登记过的模型 ⇒ source='unknown'，绝不静默当成「免费」⇒ 否则两者在账上
//     都记 cost=0，之后任何省钱率 / 预算推导都建立在流沙上。
//
// fallback 链固定为：model → proxy → unknown（与 LiteLLM off_peak 的
// 「unset falls back to the standard rate」同一条纪律：兜底兜的是标准价，不是 0）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-pricing-'));
const LEDGER = path.join(TMP, 'cost-ledger.jsonl');
const PROVIDERS = path.join(TMP, 'providers.json');

const PROVIDERS_JSON = [
  {
    provider_id: 'deepseek',
    models: [{ id: 'deepseek-v4-flash', pricing: { input: 1, output: 4, cacheHit: 0.02 } }],
  },
  {
    provider_id: 'agnes',
    models: [{
      id: 'agnes-3.0-flash',
      pricing: { input: 0, output: 0, cacheHit: 0 },
      priceSource: 'owner-declared-free@2026-10-02',
    }],
  },
];

let costTrack;

// ⚠️ env 必须在 **beforeEach** 设，不能只在 beforeAll：jest.setup-afterenv.js 的
// afterEach 会把 process.env 恢复到 worker 加载时的快照（根治跨文件 env 泄漏的 flaky），
// 所以 beforeAll 里设的 PROXY_COST_TRACK 会在第一个 test 结束后就被清掉 ⇒
// 后续 applyTokens 的 enabled() 为 false，静默不落账（2026-10-12 实测踩到）。
beforeEach(() => {
  process.env.PROXY_COST_TRACK = '1';
  process.env.PROXY_COST_LEDGER = LEDGER;
});

beforeAll(() => {
  fs.writeFileSync(PROVIDERS, JSON.stringify(PROVIDERS_JSON));
  jest.resetModules();
  costTrack = require('../../lib/cost-track');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const lastLedgerRow = () => {
  const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n');
  return JSON.parse(rows[rows.length - 1]);
};

describe('P2 loadPricingFromProviders', () => {
  test('读入 model 级价表', () => {
    const r = costTrack.loadPricingFromProviders(PROVIDERS);
    expect(r.ok).toBe(true);
    expect(r.loaded).toBe(2);
  });

  test('文件不存在时不抛，返回 ok=false（价表读不出不该让网关起不来）', () => {
    const r = costTrack.loadPricingFromProviders(path.join(TMP, 'nope.json'));
    expect(r.ok).toBe(false);
    expect(r.loaded).toBe(0);
  });
});

describe('P2 resolvePricing fallback 链', () => {
  test('model 价优先于 per-proxy 价', () => {
    const r = costTrack.resolvePricing('deepseek-v4-flash', { pricing: { input: 9, output: 9 } });
    expect(r.source).toBe('model');
    expect(r.key).toBe('deepseek-v4-flash');
    expect(r.input).toBe(1);
    expect(r.output).toBe(4);
  });

  test('🔴 真免费（pricing 全 0 但带 priceSource）判 model，不是 unknown', () => {
    const r = costTrack.resolvePricing('agnes-3.0-flash', { pricing: { input: 9, output: 9 } });
    expect(r.source).toBe('model');        // 有登记 ⇒ 不是「没价」
    expect(r.input).toBe(0);
    expect(r.priceSource).toMatch(/owner-declared-free/);
  });

  test('没登记的模型回落 per-proxy，标 source=proxy（不冒充 model 实测价）', () => {
    const r = costTrack.resolvePricing('some-unlisted-model', { pricing: { input: 9, output: 9 } });
    expect(r.source).toBe('proxy');
    expect(r.input).toBe(9);
  });

  test('🔴 都没有 ⇒ source=unknown，绝不静默当成 0 元「免费」', () => {
    const r = costTrack.resolvePricing('ghost-model', { pricing: { input: 0, output: 0 } });
    expect(r.source).toBe('unknown');
    expect(r.input).toBe(0);
  });
});

describe('P2 applyTokens 按 model 价算钱并落 pricingSource', () => {
  test('按 model 价算（1M input × ¥1/M = ¥1），source=model', () => {
    costTrack.applyTokens(
      't-gw', { prompt: 1_000_000, completion: 0, cacheHit: 0, thinking: 0 }, 1,
      { model: 'deepseek-v4-flash', reqId: 'r1' });
    const all = costTrack.getAll();
    expect(all['t-gw'].cost).toBeCloseTo(1, 6);
    const last = lastLedgerRow();
    expect(last.model).toBe('deepseek-v4-flash');
    expect(last.pricingSource).toBe('model');
  });

  test('🔴 真免费模型落账 cost=0 但 pricingSource=model（与 unknown 可区分）', () => {
    costTrack.applyTokens(
      't-gw', { prompt: 1_000_000, completion: 0, cacheHit: 0, thinking: 0 }, 1,
      { model: 'agnes-3.0-flash', reqId: 'r2' });
    const last = lastLedgerRow();
    expect(last.cost).toBe(0);
    expect(last.pricingSource).toBe('model');   // 不是 unknown
  });

  test('🔴 没价的模型落账 cost=0 且 pricingSource=unknown（必须与上一条分得开）', () => {
    costTrack.applyTokens(
      't-gw', { prompt: 1_000_000, completion: 0, cacheHit: 0, thinking: 0 }, 1,
      { model: 'ghost-model', reqId: 'r3' });
    const last = lastLedgerRow();
    expect(last.cost).toBe(0);
    expect(last.pricingSource).toBe('unknown');
  });
});
