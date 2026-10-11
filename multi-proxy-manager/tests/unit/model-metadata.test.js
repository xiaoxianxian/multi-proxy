'use strict';
// P4（2026-10-12）保护网：模型价格来源时刻标注（retrievedAt）。
//
// 核心钉死两件事：
//   1. 纯函数 extractRetrievedAt：取不到就 null，**绝不造「现在」或 0**
//      （与 P2「值是 0 ≠ 值不存在」同一条纪律）。
//   2. 接线：resolvePricing 结果带 retrievedAt；ledger 落 pricingRetrievedAt，
//      没有该字段时**整个键省略**（JSON 里不出现），不写假值。

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-modelmeta-'));
const LEDGER = path.join(TMP, 'cost-ledger.jsonl');
const PROVIDERS = path.join(TMP, 'providers.json');

// 一个模型带 retrievedAt，一个不带 —— 用来区分「知道何时采集」与「不知道」。
const PROVIDERS_JSON = [
  {
    provider_id: 'deepseek',
    models: [{
      id: 'ds-with-date',
      pricing: { input: 1, output: 4 },
      retrievedAt: '2026-10-12',
    }],
  },
  {
    provider_id: 'agnes',
    models: [{
      id: 'agnes-no-date',
      pricing: { input: 0, output: 0 },
      priceSource: 'owner-declared-free@2026-10-02',
    }],
  },
];

let modelMetadata;
let costTrack;

// ⚠️ env 必须在 beforeEach 设（jest.setup-afterenv.js 的 afterEach 会恢复 env 快照），
//    否则 applyTokens 的 enabled() 为 false，静默不落账 —— 见 cost-model-pricing.test.js 同款注释。
beforeEach(() => {
  process.env.PROXY_COST_TRACK = '1';
  process.env.PROXY_COST_LEDGER = LEDGER;
});

beforeAll(() => {
  fs.writeFileSync(PROVIDERS, JSON.stringify(PROVIDERS_JSON));
  jest.resetModules();
  modelMetadata = require('../../lib/model-metadata');
  costTrack = require('../../lib/cost-track');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('model-metadata.extractRetrievedAt（纯函数）', () => {
  test('优先取 entry.retrievedAt', () => {
    expect(modelMetadata.extractRetrievedAt({ retrievedAt: '2026-10-12' })).toBe('2026-10-12');
  });

  test('priceSource 是对象时取其 retrievedAt', () => {
    expect(
      modelMetadata.extractRetrievedAt({ priceSource: { retrievedAt: '2026-10-02', note: 'x' } })
    ).toBe('2026-10-02');
  });

  test('🔴 取不到就 null，绝不造「现在」或 0', () => {
    expect(modelMetadata.extractRetrievedAt({ pricing: {} })).toBeNull();
    expect(modelMetadata.extractRetrievedAt({ priceSource: 'string-note' })).toBeNull();
    expect(modelMetadata.extractRetrievedAt(null)).toBeNull();
    expect(modelMetadata.extractRetrievedAt(undefined)).toBeNull();
    expect(modelMetadata.extractRetrievedAt('nope')).toBeNull();
  });
});

describe('model-metadata.annotateResult', () => {
  test('把 retrievedAt 补进结果；没有就 null', () => {
    expect(modelMetadata.annotateResult({ source: 'model' }, { retrievedAt: '2026-10-12' }).retrievedAt)
      .toBe('2026-10-12');
    expect(modelMetadata.annotateResult({ source: 'model' }, {}).retrievedAt).toBeNull();
  });
});

describe('P4 接线：resolvePricing 带 retrievedAt', () => {
  beforeAll(() => {
    costTrack.loadPricingFromProviders(PROVIDERS);
  });

  test('登记了 retrievedAt 的模型 → 带出', () => {
    const pr = costTrack.resolvePricing('ds-with-date', {});
    expect(pr.source).toBe('model');
    expect(pr.retrievedAt).toBe('2026-10-12');
  });

  test('没登记 retrievedAt 的模型 → null（不是「现在」）', () => {
    const pr = costTrack.resolvePricing('agnes-no-date', {});
    expect(pr.source).toBe('model');
    expect(pr.retrievedAt).toBeNull();
  });

  test('完全没登记的模型（unknown）→ retrievedAt null', () => {
    const pr = costTrack.resolvePricing('never-seen', {});
    expect(pr.source).toBe('unknown');
    expect(pr.retrievedAt).toBeNull();
  });
});

describe('P4 接线：ledger 落 pricingRetrievedAt', () => {
  const lastRow = () => {
    const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n');
    return JSON.parse(rows[rows.length - 1]);
  };

  test('有 retrievedAt → 落盘', () => {
    costTrack.applyTokens('deepseek',
      { prompt: 10, completion: 5, cacheHit: 0, thinking: 0 },
      100, { model: 'ds-with-date', reqId: 'r-with-date' });
    const row = lastRow();
    expect(row.pricingSource).toBe('model');
    expect(row.pricingRetrievedAt).toBe('2026-10-12');
  });

  test('🔴 没 retrievedAt → 字段省略（JSON 里不出现），绝不写「现在」', () => {
    costTrack.applyTokens('agnes',
      { prompt: 10, completion: 5, cacheHit: 0, thinking: 0 },
      100, { model: 'agnes-no-date', reqId: 'r-no-date' });
    const row = lastRow();
    expect(row.pricingSource).toBe('model');
    expect('pricingRetrievedAt' in row).toBe(false);
  });
});
