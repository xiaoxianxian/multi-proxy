// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// P5-A 单测：llm-metadata 导入（语义反转 + 补集窗口 + add-only + 不造 0）。
// fixture 全部取自 basellm/llm-metadata dist/api/all.json 真实条目（2026-10-12 核对），
// 边界样例（畸形/不一致/全 peak）是手工构造的极端输入。

const {
  complementPeakWindows,
  convertLlmMetadataCost,
  importLlmMetadataCatalog,
} = require('../../lib/model-catalog');

// ── 真实 fixture：deepseek-flash（CNY 档带 peak schedule，base=闲时）──
// 上游语义：base {input:1,output:4,cache_read:0.02} = 闲时；
//           windows peak {input:2,output:8,cache_read:0.04}，Mon–Fri 01:00-04:00 & 06:00-10:00 UTC。
const DEEPSEEK_COST = {
  input: 0.15,
  output: 0.6,
  reasoning: 0.6,
  cache_read: 0.003,
  schedule: {
    timezone: 'UTC',
    fallback: 'off_peak',
    windows: [
      {
        name: 'peak',
        weekdays: [1, 2, 3, 4, 5],
        hours: ['01:00-04:00', '06:00-10:00'],
        input: 0.3,
        output: 1.2,
        reasoning: 1.2,
        cache_read: 0.006,
      },
    ],
  },
  currency_options: {
    CNY: {
      input: 1,
      output: 4,
      reasoning: 4,
      cache_read: 0.02,
      schedule: {
        timezone: 'UTC',
        fallback: 'off_peak',
        windows: [
          {
            name: 'peak',
            weekdays: [1, 2, 3, 4, 5],
            hours: ['01:00-04:00', '06:00-10:00'],
            input: 2,
            output: 8,
            reasoning: 8,
            cache_read: 0.04,
          },
        ],
      },
    },
  },
};

// ── 真实 fixture：kimi-k2.6（无 schedule 平铺价）──
const KIMI_COST = { cache_read: 0.16, input: 0.95, output: 4 };

describe('complementPeakWindows：peak 窗口 → 本站 off-peak 补集', () => {
  test('deepseek 官方 peak（Mon-Fri 01-04 & 06-10 UTC）→ 与本站手写表逐字一致', () => {
    const out = complementPeakWindows(DEEPSEEK_COST.schedule.windows);
    expect(out).toEqual([
      { hoursUtc: ['00:00-01:00', '04:00-06:00', '10:00-00:00'], weekdays: [1, 2, 3, 4, 5] },
      { hoursUtc: ['00:00-00:00'], weekdays: [6, 7] },
    ]);
    // 🔑 这一条是整轮反转的锚：本站 ~/.multi-proxy-manager/pricing.json 里 deepseek
    // 的 offPeakPricing.windows 是 2026-10-12 手写的，导入产物必须与它同构，
    // 否则「换真实来源」会顺手改掉已拍过的窗口定义。
  });

  test('跨零点 peak 窗口：22:00-02:00 → 补集 02:00-22:00', () => {
    const out = complementPeakWindows([
      { weekdays: [1, 2, 3, 4, 5, 6, 7], hours: ['22:00-02:00'] },
    ]);
    expect(out).toEqual([
      { hoursUtc: ['02:00-22:00'], weekdays: [1, 2, 3, 4, 5, 6, 7] },
    ]);
  });

  test('工作日全天 peak → 这些天不出现在 off-peak 输出里；周末全天 off-peak', () => {
    const out = complementPeakWindows([
      { weekdays: [1, 2, 3, 4, 5], hours: ['00:00-00:00'] },
    ]);
    expect(out).toEqual([
      { hoursUtc: ['00:00-00:00'], weekdays: [6, 7] },
    ]);
  });

  test('全周全天 peak → 空数组（没便宜档可打，调用方放弃 schedule）', () => {
    const out = complementPeakWindows([
      { weekdays: [1, 2, 3, 4, 5, 6, 7], hours: ['00:00-00:00'] },
    ]);
    expect(out).toEqual([]);
  });

  test('多段不连续 peak：00-02 与 10-12 → 补集 02-10 与 12-00；未覆盖的星期全天 off-peak', () => {
    const out = complementPeakWindows([
      { weekdays: [3], hours: ['00:00-02:00', '10:00-12:00'] },
    ]);
    expect(out).toEqual([
      { hoursUtc: ['00:00-00:00'], weekdays: [1, 2, 4, 5, 6, 7] },
      { hoursUtc: ['02:00-10:00', '12:00-00:00'], weekdays: [3] },
    ]);
  });

  test('畸形 hours → null（调用方必须放弃 schedule 导入）', () => {
    expect(complementPeakWindows([{ weekdays: [1], hours: ['25:00-04:00'] }])).toBeNull();
    expect(complementPeakWindows([{ weekdays: [1], hours: ['01:0'] }])).toBeNull();
  });

  test('畸形 weekdays → null', () => {
    expect(complementPeakWindows([{ weekdays: [9], hours: ['01:00-04:00'] }])).toBeNull();
    expect(complementPeakWindows([{ weekdays: 'mon', hours: ['01:00-04:00'] }])).toBeNull();
  });

  test('weekdays 缺失 = 全周适用', () => {
    const out = complementPeakWindows([{ hours: ['01:00-04:00'] }]);
    expect(out).toEqual([
      { hoursUtc: ['00:00-01:00', '04:00-00:00'], weekdays: [1, 2, 3, 4, 5, 6, 7] },
    ]);
  });

  // 🔒 不变式：补集产出的每个 hoursUtc 字符串都必须能被我方解析器原样解析。
  // 曾经出过 "10:00-24:00"（小时 24 非法 ⇒ 窗口永不命中 ⇒ 高峰全价的静默错账）。
  test('不变式：所有产出的 hoursUtc 都能被 pricing-schedule.parseWindowRange 解析', () => {
    const { parseWindowRange } = require('../../lib/pricing-schedule');
    const cases = [
      [{ weekdays: [1, 2, 3, 4, 5], hours: ['01:00-04:00', '06:00-10:00'] }],
      [{ hours: ['22:00-02:00'] }],
      [{ weekdays: [3], hours: ['00:00-02:00', '10:00-12:00'] }],
      [{ weekdays: [1, 2, 3, 4, 5, 6, 7], hours: ['00:00-00:00'] }],
      [{ weekdays: [7], hours: ['23:59-00:00'] }],
    ];
    for (const c of cases) {
      const out = complementPeakWindows(c) || [];
      for (const w of out) {
        for (const r of w.hoursUtc) {
          expect(parseWindowRange(r)).not.toBeNull();
        }
      }
    }
  });
});

describe('convertLlmMetadataCost：语义反转', () => {
  test('deepseek CNY 档：标准价=peak{2,8,0.04}，闲时价=base{1,4,0.02}，窗口=补集', () => {
    const r = convertLlmMetadataCost(DEEPSEEK_COST, { preferCurrency: 'CNY' });
    expect(r.pricing).toEqual({ input: 2, output: 8, cacheHit: 0.04 });
    expect(r.offPeakPricing.pricing).toEqual({ input: 1, output: 4, cacheHit: 0.02 });
    expect(r.offPeakPricing.windows).toEqual([
      { hoursUtc: ['00:00-01:00', '04:00-06:00', '10:00-00:00'], weekdays: [1, 2, 3, 4, 5] },
      { hoursUtc: ['00:00-00:00'], weekdays: [6, 7] },
    ]);
    expect(r.currency).toBe('CNY');
    expect(r.note).toBeUndefined();
  });

  test('无 CNY 档 → 回落 USD base（deepseek USD：peak 0.3/1.2/0.006，闲 0.15/0.6/0.003）', () => {
    const r = convertLlmMetadataCost(DEEPSEEK_COST, { preferCurrency: 'CNY' });
    // 上面已验 CNY；这里造一个只有 base 的对象验回落
    const r2 = convertLlmMetadataCost({
      input: 0.15, output: 0.6, cache_read: 0.003,
      schedule: { timezone: 'UTC', fallback: 'off_peak', windows: [{ weekdays: [1, 2, 3, 4, 5], hours: ['01:00-04:00'], input: 0.3, output: 1.2, cache_read: 0.006 }] },
    });
    expect(r2.currency).toBe('USD(base)');
    expect(r2.pricing).toEqual({ input: 0.3, output: 1.2, cacheHit: 0.006 });
    expect(r2.offPeakPricing.pricing).toEqual({ input: 0.15, output: 0.6, cacheHit: 0.003 });
    expect(r).toBeTruthy();
  });

  test('无 schedule（kimi-k2.6 真实条目）→ 平铺落入，不造 offPeakPricing', () => {
    const r = convertLlmMetadataCost(KIMI_COST);
    expect(r.pricing).toEqual({ input: 0.95, output: 4, cacheHit: 0.16 });
    expect(r.offPeakPricing).toBeUndefined();
    expect(r.note).toBeUndefined();
  });

  test('cost 缺失 / input+output 全缺 → null（绝不造 0）', () => {
    expect(convertLlmMetadataCost(null)).toBeNull();
    expect(convertLlmMetadataCost({})).toBeNull();
    expect(convertLlmMetadataCost({ cache_read: 0.1 })).toBeNull();
  });

  test('fallback 不是 off_peak → 不反转，只落 base 并留 note（高峰会低估，必须可见）', () => {
    const r = convertLlmMetadataCost({
      input: 1, output: 4,
      schedule: { timezone: 'UTC', fallback: 'peak', windows: [{ weekdays: [1], hours: ['01:00-04:00'], input: 2, output: 8 }] },
    });
    expect(r.pricing).toEqual({ input: 1, output: 4, cacheHit: null });
    expect(r.offPeakPricing).toBeUndefined();
    expect(r.note).toMatch(/fallback/);
  });

  test('timezone 非 UTC → 不反转（hours 无法无损映射到 hoursUtc）', () => {
    const r = convertLlmMetadataCost({
      input: 1, output: 4,
      schedule: { timezone: 'Asia/Shanghai', fallback: 'off_peak', windows: [{ weekdays: [1], hours: ['01:00-04:00'], input: 2, output: 8 }] },
    });
    expect(r.offPeakPricing).toBeUndefined();
    expect(r.note).toMatch(/非 UTC/);
  });

  test('多窗口价格不一致 → 不反转，只落 base + note', () => {
    const r = convertLlmMetadataCost({
      input: 1, output: 4,
      schedule: { timezone: 'UTC', fallback: 'off_peak', windows: [
        { weekdays: [1], hours: ['01:00-04:00'], input: 2, output: 8 },
        { weekdays: [2], hours: ['01:00-04:00'], input: 3, output: 9 },
      ] },
    });
    expect(r.pricing).toEqual({ input: 1, output: 4, cacheHit: null });
    expect(r.note).toMatch(/不一致/);
  });

  test('全周全天 peak → 落 peak 价为标准价，不配 offPeakPricing', () => {
    const r = convertLlmMetadataCost({
      input: 1, output: 4,
      schedule: { timezone: 'UTC', fallback: 'off_peak', windows: [{ hours: ['00:00-00:00'], input: 2, output: 8 }] },
    });
    expect(r.pricing).toEqual({ input: 2, output: 8, cacheHit: null });
    expect(r.offPeakPricing).toBeUndefined();
    expect(r.note).toMatch(/全周均无 off-peak/);
  });
});

describe('importLlmMetadataCatalog：整目录导入', () => {
  const ALL_JSON = {
    deepseek: {
      models: {
        'deepseek-flash': { id: 'deepseek-flash', canonical_model_id: 'deepseek/deepseek-v4.1-flash', cost: DEEPSEEK_COST },
      },
    },
    moonshotai: {
      models: {
        'kimi-k2.6': { id: 'kimi-k2.6', cost: KIMI_COST },
      },
    },
    acme: {
      models: {
        'mystery-model': { id: 'mystery-model' }, // 无 cost
      },
    },
  };

  test('add-only：existingIds 里的 id 跳过并给理由', () => {
    const { entries, skipped } = importLlmMetadataCatalog(ALL_JSON, {
      existingIds: new Set(['kimi-k2.6']),
      retrievedAt: '2026-10-12',
    });
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('deepseek-flash');
    expect(ids).not.toContain('kimi-k2.6');
    expect(skipped).toEqual(expect.arrayContaining([
      { id: 'kimi-k2.6', reason: expect.stringMatching(/add-only/) },
      { id: 'mystery-model', reason: expect.stringMatching(/不造 0/) },
    ]));
  });

  test('每条导入都带 retrievedAt + 可回源 priceSource（含反转说明）', () => {
    const { entries } = importLlmMetadataCatalog(ALL_JSON, { retrievedAt: '2026-10-12' });
    const ds = entries.find((e) => e.id === 'deepseek-flash');
    expect(ds.retrievedAt).toBe('2026-10-12');
    expect(ds.priceSource).toMatch(/llm-metadata@2026-10-12/);
    expect(ds.priceSource).toMatch(/币种=CNY/);
    expect(ds.priceSource).toMatch(/canonical=deepseek\/deepseek-v4\.1-flash/);
    expect(ds.priceSource).toMatch(/schedule 已反转/);
    expect(ds.offPeakPricing.priceSource).toMatch(/peak 窗口补集/);
  });

  test('无 cost 的模型不出现在 entries 里（不造 0）', () => {
    const { entries } = importLlmMetadataCatalog(ALL_JSON, {});
    expect(entries.map((e) => e.id)).toEqual(['deepseek-flash', 'kimi-k2.6']);
    for (const e of entries) {
      expect(e.pricing.input == null && e.pricing.output == null).toBe(false);
    }
  });

  test('all.json 不是对象 → 空 entries + 全局 skip 理由', () => {
    const { entries, skipped } = importLlmMetadataCatalog(null, {});
    expect(entries).toEqual([]);
    expect(skipped[0].reason).toMatch(/不是对象/);
  });

  test('跨供应商同 id 重名（真实存在：kimi-k2.6 在 moonshotai 与 moonshotai-cn 下同 id 不同价）→ 本轮内也 add-only，先到赢', () => {
    const { entries, skipped } = importLlmMetadataCatalog({
      moonshotai: { models: { 'kimi-k2.6': { id: 'kimi-k2.6', cost: { input: 0.95, output: 4 } } } },
      'moonshotai-cn': { models: { 'kimi-k2.6': { id: 'kimi-k2.6', cost: { input: 6.5, output: 27 } } } },
    }, {});
    expect(entries).toHaveLength(1);
    expect(entries[0].pricing).toEqual({ input: 0.95, output: 4, cacheHit: null });
    expect(skipped).toEqual(expect.arrayContaining([
      { id: 'kimi-k2.6', reason: expect.stringMatching(/本轮已从另一供应商导入/) },
    ]));
  });
});
