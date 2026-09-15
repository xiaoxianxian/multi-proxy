'use strict';

// L2 P2 成本分析 · A 路 token×单价埋点（lib/cost-track.js）
//
// 职责：在 forward.js 热路径里，门控 PROXY_COST_TRACK 开时，
// 从 upstream response 的 `usage` 字段提取 token 数，结合 provider
// 配置的 `pricing`，算出本次请求的花费，内存累计 per-proxy 总成本。
//
// 设计原则（与 l2/ 内核铁律一致）：
//   - 非侵入：门控关时热路径零开销（只调 enabled() 做布尔判断，< 1μs）；
//            门控开时只读 usage 字段（不改 response.data、不注入 header、不写盘）。
//   - 门控 PROXY_COST_TRACK 默认关 = observe（热路径不提取），开 = 提取累计进内存。
//   - pricing 注入：PROXY_PRICING_<proxy> env = JSON `{input, output, cacheHit?}`（每百万 tokens，CNY/USD）。
//     与 PROVIDERS-README.md 的 pricing 字段对齐。无 env 时默认 {input:0, output:0}（本地模型 cost=0）。
//   - pricing 可由 server 启动时调 `loadPricingFromEnv()` 注入，或调 `setPricing(name, pricing)` 显式设。
//
// 接入方式：
//    1. server.js 启动：`require('./lib/cost-track').loadPricingFromEnv()`
//    2. forward.js res.json 前：`require('./lib/cost-track').accumulate(proxy, response.data?.usage)`
//    3. alert-route.js collect：`require('./lib/cost-track').getCost(proxy)` 拿累计花费
//
// 门控 env：
//   PROXY_COST_TRACK=1/true/on  → 开（提取 usage 累计）
//   PROXY_PRICING_<proxy>       → 每 proxy 的单价（JSON，每百万 tokens）

function enabled() {
  const v = String(process.env.PROXY_COST_TRACK ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// ---- 内存态 per-proxy 累计 ----
// { proxyName: { promptTokens, completionTokens, totalTokens, cost, requestCount, pricing } }
const _state = {};

// 从 env 读 pricing：PROXY_PRICING_<PROXY> = '{"input":10,"output":20,"cacheHit":3}'
// 容错：非法 JSON → 默认 {input:0, output:0}；proxy 名大写化（env 键名大写）
function readPricingFromEnv(proxyName) {
  const key = 'PROXY_PRICING_' + proxyName.toUpperCase();
  const raw = process.env[key];
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p === 'object' && p !== null) {
      return {
        input:    typeof p.input    === 'number' ? p.input    : (parseFloat(p.input)    || 0),
        output:   typeof p.output   === 'number' ? p.output   : (parseFloat(p.output)   || 0),
        cacheHit: p.cacheHit != null ? (typeof p.cacheHit === 'number' ? p.cacheHit : parseFloat(p.cacheHit) || 0) : undefined,
      };
    }
    return null;
  } catch {
    return null;   // 非法 JSON → 静默默认
  }
}

// 启动时（或手动）注入：遍历 process.env，PROXY_PRICING_* 键 → setPricing
function loadPricingFromEnv() {
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('PROXY_PRICING_')) {
       const proxyName = key.slice('PROXY_PRICING_'.length).toLowerCase();
      const p = readPricingFromEnv(proxyName);
      if (p) setPricing(proxyName, p);
     }
  }
}

// 设置 per-proxy 单价（幂等：保留已累计的 tokens/cost，只换 pricing）
// pricing: { input, output, cacheHit? } — 每百万 tokens，与 PROVIDERS-README.md 对齐
// 无 pricing 时默认 0（本地模型 type='local' 单价全 0）
function setPricing(proxyName, pricing) {
  const existing = _state[proxyName];
  _state[proxyName] = existing
    ? { ...existing, pricing: pricing || { input: 0, output: 0 } }
    : {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cost: 0,
      requestCount: 0,
      pricing: pricing || { input: 0, output: 0 },
     };
}

// 确保 proxy 有 state（首次遇到时）；无 pricing 时尝试从 env 读，读不到默认 0
function ensureState(proxyName) {
  let st = _state[proxyName];
  if (!st) {
     const p = readPricingFromEnv(proxyName) || { input: 0, output: 0 };
    st = _state[proxyName] = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cost: 0,
      requestCount: 0,
      pricing: p,
     };
  }
  return st;
}

// 从 usage 对象提取 tokens（兼容 OpenAI / Anthropic / 自定义代理字段名）
function extractTokens(usage) {
   const prompt = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens :
                  typeof usage?.input_tokens   === 'number' ? usage.input_tokens  : 0;
  const completion = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens :
                     typeof usage?.output_tokens     === 'number' ? usage.output_tokens     : 0;
  const cacheHit   = typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens :
                     typeof usage?.cacheHit               === 'number' ? usage.cacheHit              : 0;
  return { prompt, completion, cacheHit };
}

// 热路径主入口：门控关时零开销，开时从 usage 提取 + 累计 cost
function accumulate(proxyName, usage) {
  if (!enabled()) return;
  const st = ensureState(proxyName);
  const { prompt, completion, cacheHit } = extractTokens(usage || {});
  const { input: pIn, output: pOut, cacheHit: pCache } = st.pricing;
  const costDelta = (prompt - cacheHit) / 1e6 * pIn + completion / 1e6 * pOut +
                    (pCache !== undefined ? cacheHit / 1e6 * pCache : 0);
  st.promptTokens      += prompt;
  st.completionTokens += completion;
  st.totalTokens       += prompt + completion;
  st.cost              += costDelta;
  st.requestCount      += 1;
}

// 读 per-proxy 累计（对外快照，不暴露内部 timestamp）
function getCost(proxyName) {
  const st = _state[proxyName];
  if (!st) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, requestCount: 0 };
  return {
    promptTokens:     st.promptTokens,
    completionTokens: st.completionTokens,
    totalTokens:      st.totalTokens,
    cost:             Math.round(st.cost * 1e6) / 1e6,
    requestCount:     st.requestCount,
  };
}

// 读所有 proxy 的累计
function getAll() {
  const result = {};
  for (const name of Object.keys(_state)) {
    result[name] = getCost(name);
  }
  return result;
}

// 测试/重启用
function reset() {
  for (const k of Object.keys(_state)) delete _state[k];
}

module.exports = {
  enabled,
  setPricing,
  loadPricingFromEnv,
  accumulate,
  getCost,
  getAll,
  reset,
};
