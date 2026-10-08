// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// 28 号文档 C6 + C7 的保护网。
// C6 = per-model 价表（取代「只有三档 tier」）；C7 = A 路 token 账喂进 cost.js 同一 record()。
const GW = require('../../../l2/savings-gateway/gateway.js');
const C = require('../../../l2/cost.js');

describe('C6 per-model 价表（l2/savings-gateway/gateway.js）', () => {
  test('per-model 优先于 tier', () => {
    const pricing = {
      models: { 'deepseek-v4-pro': { input: 2, output: 8 } },
      tiers: { medium: { input: 1, output: 4 } },
    };
    const r = GW.resolvePricing(pricing, 'deepseek-v4-pro', 'medium');
    expect(r.source).toBe('model');
    expect(r.key).toBe('deepseek-v4-pro');
    expect(r.input).toBe(2);
    expect(r.output).toBe(8);
  });

  test('无 per-model 数据时回落 tier，且标 source=tier（不冒充实测价）', () => {
    const pricing = { tiers: { medium: { input: 1, output: 4 } } };
    const r = GW.resolvePricing(pricing, 'some-unknown-model', 'medium');
    expect(r.source).toBe('tier');
    expect(r.key).toBe('medium');
  });

  test('兼容现有扁平形状 { small, medium, large }', () => {
    const r = GW.resolvePricing(GW.DEFAULT_PRICING, null, 'large');
    expect(r).toEqual({ input: 32, output: 128, source: 'tier', key: 'large' });
  });

  test('档位与模型都对不上 → null（不炸、不猜）', () => {
    expect(GW.resolvePricing(GW.DEFAULT_PRICING, null, 'nonexistent-tier')).toBeNull();
    expect(GW.resolvePricing(GW.DEFAULT_PRICING, 'nope', 'nope')).toBeNull();
    expect(GW.resolvePricing(null, null, 'medium')).toEqual(
      expect.objectContaining({ source: 'tier', key: 'medium' }),
    );
  });

  test('🔴 价表条目残缺（只有 input 没有 output）→ unknown，不拿半截数据也不拿 tier 凑数', () => {
    const pricing = { models: { bad: { input: 1 } }, tiers: { medium: { input: 1, output: 4 } } };
    const r = GW.resolvePricing(pricing, 'bad', 'medium');
    expect(r.source).toBe('unknown');
    expect(r.input).toBeNull();
    expect(r.output).toBeNull();
  });

  test('🔴 C0-3：价表非空但查不到这个 model → unknown（绝不回落 tier 冒充实测价）', () => {
    // 真实场景：providers.json 里 agnes provider 只登记了 agnes-2.0-flash，
    // 而 codex 实际在跑 agnes-3.0-flash —— 它的单价未知，不该被 tier small 算成 ¥0。
    const pricing = {
      models: { 'agnes-2.0-flash': { input: 0, output: 0 } },
      tiers: { small: { input: 0, output: 0 }, medium: { input: 1, output: 4 } },
    };
    const r = GW.resolvePricing(pricing, 'agnes-3.0-flash', 'small');
    expect(r.source).toBe('unknown');
    expect(r.key).toBe('agnes-3.0-flash');
    expect(r.input).toBeNull();
  });

  test('价表空（没登记任何 model）→ 仍允许 tier 估算并标注 source（向后兼容）', () => {
    const pricing = { tiers: { medium: { input: 1, output: 4 } } };
    const r = GW.resolvePricing(pricing, 'some-unknown-model', 'medium');
    expect(r.source).toBe('tier');
    expect(r.key).toBe('medium');
  });

  test('默认 per-model 表为空：没有实测价就绝不冒充', () => {
    expect(GW.DEFAULT_MODEL_PRICING).toEqual({});
  });
});

describe('C7 A 路 token 账（l2/cost.js）', () => {
  const P = { input: 1, output: 4 }; // CNY / 百万 token

  test('tokenCost 纯函数：正常 / snake_case / 缺价 / 空输入', () => {
    expect(C.tokenCost({ promptTokens: 1e6, completionTokens: 0 }, P)).toBe(1);
    expect(C.tokenCost({ prompt_tokens: 1e6, completion_tokens: 0.5e6 }, P)).toBe(3);
    expect(C.tokenCost({ promptTokens: 1e6 }, null)).toBeNull();
    expect(C.tokenCost({ promptTokens: 1e6 }, { input: 1 })).toBeNull();
    expect(C.tokenCost(null, P)).toBeNull();
  });

  test('A 路首笔：消费额 == 该笔花费（零点生效，不得少第一笔）', () => {
    const s = C.createCostService();
    const r = s.record('p', null, { tokens: { promptTokens: 1e6 }, pricing: P });
    expect(r.basis).toBe('token');
    expect(r.snapshot.spend).toBe(1);
    expect(r.consumption.total).toBe(1);
  });

  test('A 路累计：多笔累加，余额单调变负', () => {
    const s = C.createCostService();
    s.record('p', null, { tokens: { promptTokens: 1e6 }, pricing: P });
    const r2 = s.record('p', null, { tokens: { promptTokens: 1e6, completionTokens: 0.5e6 }, pricing: P });
    expect(r2.snapshot.spend).toBe(3);
    expect(r2.snapshot.balance).toBe(-4);
    expect(r2.consumption.total).toBe(4);
  });

  test('给了 token 但价格缺失 → priced=false，绝不填 0 冒充「没花钱」', () => {
    const s = C.createCostService();
    const r = s.record('p', null, { tokens: { promptTokens: 1e6 } });
    expect(r.priced).toBe(false);
    expect(r.basis).toBe('unpriced');
    expect(r.snapshot.spend).toBeUndefined();
  });

  test('signal 形状不变（alert.js cost-budget-exceeded 契约）', () => {
    const s = C.createCostService();
    const r = s.record('p', null, { tokens: { promptTokens: 1e6 }, pricing: P, budget: 10 });
    expect(r.signal).toEqual({ source: 'cost', providerId: 'p', cost: 1, budget: 10 });
  });

  test('🔴 B 路回归红线：不传 tokens 时行为与改动前完全一致', () => {
    const s = C.createCostService();
    const r1 = s.record('b', 100);
    expect(r1.basis).toBe('balance');
    expect(r1.snapshot.balance).toBe(100);
    expect(r1.snapshot.spend).toBeUndefined();
    const r2 = s.record('b', 70);
    expect(r2.consumption.total).toBe(30); // 100 - 70
    expect(r2.signal.cost).toBe(30);
    expect(r2.priced).toBe(true);
  });
});
