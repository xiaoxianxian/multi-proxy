/**
 * Q1 P2 · L0 官方价种子 —— 单一真相源（2026-09-22 架构 §3.1/§3.7）
 *
 * 为何独立成模块：⑧ 架构评审 F1 抓到 deepseek-v4-pro input 价 `1` 与官方 `0.5` 不一致。
 * 根因是「价写死在 routeEngine、与官方价表脱节」。本模块把 L0 官方价收敛为唯一真相源，
 * refresh-pricing.cjs 产 L2 缓存、routeEngine 内联块都用它做基准，杜绝再次脱节。
 *
 * 铁律：
 *   - value 与 routeEngine.ts DEFAULT_ROUTE_CONFIG.pricing 逐字相等（tests 里加深度相等断言锁住，
 *     任何一边漂移即测试红——这正是防止 F1 复发的机制）。
 *   - 全字段可选；缺省 currency='CNY'，逐字节向后兼容。
 *   - 官方价 source 标注 official-*；本地模型 currency=CNY 不参与汇率折算（§3.5：本地部署零成本）。
 *   - 订阅模型（gpt-5.6-codex / claude-opus-4.7）带 subscriptionId，按订阅共享配额（§3.9，
 *     精确 quota 见 arch §3.9.1 回源：无官方固定 token 各档，留 estimate，不产假值）。
 */
import type { Pricing } from '../routing/ruleEvaluator.js';

// L0 官方价种子（8 家，2026-09-22）。金额单位：CNY 家为「每百万 tokens 人民币」，
// USD 家为「每百万 tokens 美元」，折算 CNY 由 P3 汇率链路（resolveFxRate）负责。
// 金额取自 deepseek 官方 2025 价 + Q4 定稿「其他模型按行业公开价填、标来源、待刷新」。
// F1 修复：deepseek-v4-pro input 1 → 0.5、output 4 → 3（§3.7 实核值）。
export const OFFICIAL_PRICING: Record<string, Pricing> = {
  // ---- 国内官方（CNY，无需币种字段，缺省即 CNY）----
  'deepseek-v4-pro': {
    input: 0.5, output: 3, cacheHit: 0.02,
    currency: 'CNY', source: 'official-deepseek', _userSet: false, updatedAt: '2025',
  },
  'deepseek-flash': {
    input: 0.2, output: 1.6, cacheHit: 0.02,
    currency: 'CNY', source: 'official-deepseek', _userSet: false, updatedAt: '2025',
  },
  'kimi-k2.6': {
   // 官方 platform.moonshot.cn 国内站实核值（CNY，2026-09-23；C4 纠正：旧 6.5/27/0.02 中 cacheHit 应为 1.10）
   input: 6.5, output: 27, cacheHit: 1.1,
   currency: 'CNY', source: 'official-kimi', _userSet: false, updatedAt: '2026-09-23',
  },
  'kimi-k3': {
   // 官方 platform.moonshot.cn 国内站实核值（CNY，2026-09-23；C4 纠正：旧 6.5/27/0.02 系误抄 k2.6，k3 实为 20/100/2.0，1M 上下文旗舰）
   input: 20, output: 100, cacheHit: 2.0,
   currency: 'CNY', source: 'official-kimi', _userSet: false, updatedAt: '2026-09-23',
  },
  'agnes-2.5-flash': {
    input: 0, output: 0, cacheHit: 0,
    currency: 'CNY', source: 'official-agnes', _userSet: false, updatedAt: '2026-09',
  },
  // 本地部署：零成本，currency=CNY（本地无官方计费，汇率对它无意义）
  'qwen3.8:27b-mlx': {
    input: 0, output: 0, cacheHit: 0,
    currency: 'CNY', source: 'local-qwen', _userSet: false, updatedAt: '2026-09',
  },
  // ---- 境外官方（USD，需汇率折算 CNY）----
  'gpt-5.6-codex': {
    input: 12.5, output: 37.5,
    currency: 'USD', source: 'official-openai', _userSet: false,
    // 订阅共享配额（§3.9）：OpenAI Codex/ChatGPT Pro 订阅下多模型共享 credit 池。
    // 精确各档见 arch §3.9.1：官方未公布固定 token 配额，此处仅记订阅归属，不产假 quota 值。
    subscriptionId: 'openai-pro',
  },
  'claude-opus-4.7': {
    input: 15, output: 75,
    currency: 'USD', source: 'official-anthropic', _userSet: false,
    subscriptionId: 'anthropic-pro',
  },
};

// 汇率种子（§3.5 + 定稿 D2：汇率非侵入，默认缓存最近值；7.2 仅作缓存兜底，非默认 1.0）。
// 1 USD → N CNY。热路径零网络：runtime 从 PROXY_FX_RATE env / pricing-cache.json 取，
// 缺失/异常 → 1.0 + fxSource='fallback'（USD 模型会显贵被降权，调用方提示「比价失真」）。
export const FX_SEED = {
  base: 'CNY',
  rates: { USD: 7.2 },   // 缓存最近值兜底（D2 定稿；真实值由 refresh 或 PROXY_FX_RATE 提供）
  source: 'seed-fallback',
  updatedAt: '2026-09-22',
} as const;

// 渠道定义（§3.4 渠道可靠性进排序权重；§3.5.1 多渠道比价）。
// reliability=1.0 为默认（不降权）；聚合渠道 openrouter 偏便宜但可能不稳 → <1.0。
export interface ChannelDef {
  id: string;            // 渠道 id（= Pricing.channel / Pricing.source 前缀）
  provider: string;      // 对应 provider 类型/名（路由层用）
  reliability: number;   // 排序权重系数（§3.11，1.0=不降）
  // 官方渠道：永远用 L0 seed 价（§3.5.1，权威、不产假）；聚合渠道才走网络刷新。
  official: boolean;
}

export const CHANNELS: ChannelDef[] = [
  { id: 'official-openai', provider: 'gpt-5.6-codex', reliability: 1.0, official: true },
  { id: 'official-anthropic', provider: 'claude-opus-4.7', reliability: 1.0, official: true },
  { id: 'official-deepseek', provider: 'deepseek', reliability: 1.0, official: true },
  { id: 'official-kimi', provider: 'kimi', reliability: 1.0, official: true },
  { id: 'official-agnes', provider: 'agnes', reliability: 1.0, official: true },
  { id: 'local-qwen', provider: 'qwen', reliability: 1.0, official: true },
  { id: 'openrouter', provider: 'aggregator', reliability: 0.8, official: false },
];

// L0 查找器（喂给 P1 resolvePricing 的 l0 参数签名：(model) => Pricing | undefined）。
// 这是「路由引擎纯函数取价」的官方种子层（§3.1 最末层）。
export function l0Lookup(model: string): Pricing | undefined {
  return OFFICIAL_PRICING[model];
}

// 默认汇率（USD→CNY 缓存兜底，D2：非 1.0 默认；缺失时 resolveFxRate 落 1.0）。
export const DEFAULT_FX_USD_CNY = FX_SEED.rates.USD;
