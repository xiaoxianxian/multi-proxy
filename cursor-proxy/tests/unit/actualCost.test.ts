/**
 * Q3 P1-B 成本闭环 · actualCost 实采纯函数测试
 *
 * 覆盖：
 *   A. extractTokens — 5 家 provider usage 字段名兼容提取（OpenAI/DeepSeek / Anthropic / Gemini / 透传）。
 *   B. estimateActualCost — cache 实采公式正确性（core 断言：cacheRead 减非缓存 input + 命中按 cacheHit 计价）。
 *   C. actualCostFromUsage — usage + pricing 一站式。
 *   D. 边界：cacheRead > input（不双计，clamp 0）；无 cache 价 → 退化 input 价（不产假值）；本地模型 0 价。
 */
import {
  extractTokens,
  estimateActualCost,
  actualCostFromUsage,
  type UsageShape,
} from '../../src/routing/actualCost.js';
import type { Pricing } from '../../src/routing/ruleEvaluator.js';

const round = (n: number, d = 9) => Math.round(n * 10 ** d) / 10 ** d;

describe('Q3 actualCost · extractTokens（多 provider usage 字段兼容）', () => {
  it('OpenAI/DeepSeek：prompt_tokens / completion_tokens', () => {
    const u: UsageShape = { prompt_tokens: 1000, completion_tokens: 500 };
    expect(extractTokens(u)).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 });
   });

  it('Anthropic：input_tokens / output_tokens / cache_read_input_tokens', () => {
    const u: UsageShape = { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 800 };
    expect(extractTokens(u)).toEqual({ inputTokens: 2000, outputTokens: 300, cacheReadTokens: 800 });
    });

  it('OpenAI：prompt_tokens_details.cached_tokens（OpenAI 缓存字段）', () => {
    const u: UsageShape = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 300 } };
    expect(extractTokens(u)).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 });
    });

  it('Gemini：cachedContentTokenCount', () => {
    const u: UsageShape = { input_tokens: 1000, output_tokens: 200, cachedContentTokenCount: 400 };
    expect(extractTokens(u)).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400 });
    });

  it('缺字段 → 0（不产假值，本地/未知模型）', () => {
    expect(extractTokens({})).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    });
});

describe('Q3 actualCost · estimateActualCost（cache 实采公式）', () => {
  // input=0.5, output=3, cacheHit=0.02（deepseek 真实价，CNY/1M tokens）
  const pricing: Pricing = { input: 0.5, output: 3, cacheHit: 0.02, currency: 'CNY' };

  it('纯输入输出，无命中：(input/1M×in)+(output/1M×out)', () => {
    const c = estimateActualCost(1_000_000, 1_000_000, 0, pricing);
    // 1×0.5 + 1×3 = 3.5
    expect(round(c)).toBe(3.5);
    });

  it('core 断言：缓存命中部分按 cacheHit 价、非缓存部分按 input 价（cache 实采）', () => {
    // input=1M（含 0.8M 命中）, output=0, cacheRead=0.8M
    // 非缓存 input = 1M - 0.8M = 0.2M → 0.2×0.5 = 0.1
    // 命中 0.8M → 0.8×0.02 = 0.016
    // total = 0.116
    const c = estimateActualCost(1_000_000, 0, 800_000, pricing);
    expect(round(c)).toBe(0.116);
     });

  it('对比：若命中被当成普通 input 计价，成本会偏高（证明 cache 实采有意义）', () => {
    const withCache = estimateActualCost(1_000_000, 0, 800_000, pricing);   // 0.116
    const naive = estimateActualCost(1_000_000, 0, 0, pricing);           // 0.5（命中未减）
    expect(withCache).toBeLessThan(naive);                                 // 实采 < 不含 cache
    expect(round(naive)).toBe(0.5);
     });

  it('边界：cacheRead > input → clamp（非缓存 clamp 0，命中按 input 全量计，不产假负值）', () => {
    // input=100, cacheRead=500 → 非缓存 max(0,100-500)=0；命中 max(0,500)=500 → 0.5×0.005... 用大数算
    const c = estimateActualCost(100, 0, 500, pricing);
    const expected = (0 / 1e6) * 0.5 + (500 / 1e6) * 0.02;   // = 1e-4
    expect(round(c)).toBe(round(expected));
    expect(c).toBeGreaterThanOrEqual(0);                      // 不产假负值
    });

  it('无 cacheHit 价 → 退化用 input 价（不产假值，命中按 input 价计）', () => {
    const p: Pricing = { input: 10, output: 20 };   // 无 cacheHit
    // input 1M（含 0.5M 命中），无 cacheHit → 命中按 input=10 计
    // 非缓存 0.5M×10 + 命中 0.5M×10 = 5 + 5 = 10
    const c = estimateActualCost(1_000_000, 0, 500_000, p);
    expect(round(c)).toBe(10);
     });
});

describe('Q3 actualCost · actualCostFromUsage（一站式）', () => {
  it('Anthropic usage + pricing → 含 cache 的总成本', () => {
    const u: UsageShape = { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 300_000 };
    const p: Pricing = { input: 6.5, output: 27, cacheHit: 1.3, currency: 'CNY' };
    // 非缓存 input=0.7M×6.5=4.55；输出 0.5M×27=13.5；命中 0.3M×1.3=0.39 → 18.44
    expect(round(actualCostFromUsage(u, p))).toBe(18.44);
    });

  it('本地模型 0 价 → 成本 0（不参与告警）', () => {
    const u: UsageShape = { prompt_tokens: 999, completion_tokens: 999 };
    const p: Pricing = { input: 0, output: 0, cacheHit: 0, currency: 'CNY' };
    expect(actualCostFromUsage(u, p)).toBe(0);
     });
});