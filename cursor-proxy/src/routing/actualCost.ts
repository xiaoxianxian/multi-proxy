/**
 * Q3 P1-B 成本闭环 · 实采精确计费（纯函数）
 *
 * 与 estimateCost（路由预估，保守假设 50% cacheHit）解耦：
 *   estimateCost — 路由排选用，用 0.5 比例估算命中 → 路由决策
 *   estimateActualCost — 成本实采用，用真实 cacheRead token 数 → 成本告警
 *
 * 三者解耦，互不影响路由选择（AGENTS §3 非侵入铁律）。
 *
 * 公式（与 manager lib/cost-track.js:118 一致，cache 价=CNY/1M tokens）：
 *   nonCachedInput = inputTokens - cacheReadTokens
 *   cost = nonCachedInput/1e6 * input + outputTokens/1e6 * output
 *          + cacheReadTokens/1e6 * cachePrice
 *   cachePrice = pricing.cacheHit ?? pricing.input  (无 cache 价 → 用 input 价,不产假值)
 *
 * 门控 PROXY_CURSOR_COST 默认关，本模块纯函数无门控——调用点门控在 chatHandler。
 */
import type { Pricing } from './ruleEvaluator.js';

export interface ActualCostInput {
  /** 原始 usage 对象（来自上游 API 响应的 usage / usageMetadata） */
  usage: UsageShape;
  /** 该模型对应的价表记录（来自 L0 OFFICIAL_PRICING） */
  pricing: Pricing;
}

/** 从 usage 对象提取 3 个维度（兼容 5 家 provider 字段名） */
export function extractTokens(usage: UsageShape): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
} {
  // input: OpenAI/DeepSeek → prompt_tokens；Anthropic → input_tokens
  const inputTokens =
    typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens :
    typeof usage.input_tokens    === 'number' ? usage.input_tokens  :
    0;

  // output: OpenAI/DeepSeek → completion_tokens；Anthropic → output_tokens
  const outputTokens =
    typeof usage.completion_tokens === 'number' ? usage.completion_tokens :
    typeof usage.output_tokens      === 'number' ? usage.output_tokens    :
    0;

  // cacheRead: Anthropic → cache_read_input_tokens；
  //            OpenAI → prompt_tokens_details.cached_tokens；
  //            Gemini → usageMetadata.cachedContentTokenCount
  //            custom → cacheHit（透传字段）
  const cacheReadTokens =
    typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens :
    typeof (usage.prompt_tokens_details?.cached_tokens as number) === 'number'
        ? (usage.prompt_tokens_details as any).cached_tokens :
    typeof usage.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount :
    typeof usage.cacheHit === 'number' ? usage.cacheHit :
    0;

  return { inputTokens, outputTokens, cacheReadTokens };
}

/**
 * 精确实采成本（CNY，含 cache 实采）。
 *
 * @param input    — 完整 input token 数（含 cache 命中部分）
 * @param output   — output token 数
 * @param cacheRead — 命中缓存的 token 数（0 = 无缓存）
 * @param pricing  — 该模型/渠道的价表记录
 *
 * 公式：(input - cacheRead)/1M × input + output/1M × output + cacheRead/1M × (cacheHit ?? input)
 * 本地模型（input=output=0）→ cost=0，不参与告警。
 * 门控关 → 调用点跳过本函数，零开销。
 */
export function estimateActualCost(
  input: number,
  output: number,
  cacheRead: number,
  pricing: Pricing,
): number {
  const pIn = typeof pricing.input  === 'number' ? pricing.input  : 0;
  const pOut = typeof pricing.output === 'number' ? pricing.output : 0;
  const pCache = pricing.cacheHit != null ? (typeof pricing.cacheHit === 'number' ? pricing.cacheHit : 0) : pIn;
  const nonCachedInput = Math.max(0, input - Math.max(0, cacheRead));
  return (
    (nonCachedInput / 1_000_000) * pIn +
    (output / 1_000_000) * pOut +
    (Math.max(0, cacheRead) / 1_000_000) * pCache
  );
}

/**
 * 一站式：usage + pricing → 成本 CNY。
 * 门控由调用点（chatHandler）控制，本函数始终计算（纯函数，无副作用，测试友好）。
 */
export function actualCostFromUsage(usage: UsageShape, pricing: Pricing): number {
  const { inputTokens, outputTokens, cacheReadTokens } = extractTokens(usage);
  return estimateActualCost(inputTokens, outputTokens, cacheReadTokens, pricing);
}

/** 上游 usage 字段的宽松类型（兼容 OpenAI/Anthropic/Gemini/自定义） */
export interface UsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cacheHit?: number;
  cachedContentTokenCount?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  [key: string]: unknown;
}