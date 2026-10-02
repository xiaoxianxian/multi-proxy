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

// 代理面 floor view：per-proxy 最近延迟样本（ms，环形裁剪到最近 N 条）。
// 用途：/api/floor 的格子显示 p50 延迟。门控与累计成本同源（PROXY_COST_TRACK）。
// 注意：本表只由 forward.js 成功转发时喂数；不碰 _state（不改现有成本语义）。
const _latency = {};
const LATENCY_WINDOW = 50;

// 记录一次成功转发的耗时。门控关时零开销（只做一次 env 判断）。永不抛。
function recordLatency(proxyName, ms) {
  if (!enabled()) return;
  if (!proxyName || typeof ms !== 'number' || !isFinite(ms) || ms < 0) return;
  const arr = _latency[proxyName] || (_latency[proxyName] = []);
  arr.push(ms);
  if (arr.length > LATENCY_WINDOW) arr.splice(0, arr.length - LATENCY_WINDOW);
}

// p50（中位数）。无样本 → null（**绝不折算 0**：0ms 会被读成「快得离谱」的假数据）。
function latencyP50(proxyName) {
  const arr = _latency[proxyName];
  if (!arr || arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const v = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return Math.round(v * 10) / 10;
}

// 从 env 读 pricing：PROXY_PRICING_<PROXY> = '{"input":10,"output":20,"cacheHit":3}'
// 容错：非法 JSON → 默认 {input:0, output:0}；proxy 名大写化（env 键名大写）
//
// 🔴 连字符必须在键名里换成下划线：代理名都是 codex-proxy / hermes-proxy 这种带横杠的，
// 而 shell 设不了 `PROXY_PRICING_CODEX-PROXY` 这种带横杠的环境变量 —— 不归一化，
// 文档承诺的 `PROXY_PRICING_<proxy>` 对线上代理一个都配不上（cost 恒 0，静默）。
function readPricingFromEnv(proxyName) {
  const key = 'PROXY_PRICING_' + proxyName.toUpperCase().replace(/-/g, '_');
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
       // 与 readPricingFromEnv 镜像：下划线还原成连字符（codex_proxy → codex-proxy）
      const proxyName = key.slice('PROXY_PRICING_'.length).toLowerCase().replace(/_/g, '-');
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
      thinkingTokens: 0,
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
      thinkingTokens: 0,
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
  // 推理痕迹（**只计数不计费**）：上游 output_tokens 通常已含 thinking，再算一遍就是重复计费。
  // 单列出来的理由是**可观测**——真付费上游实测（64 号 §七坑 6）：max_tokens 被 thinking 吃满时
  // 整条响应一个 text 块都没有；盘面上只看得到「输出 27」，看不出「27 里 23 是空转的思考」。
  // 这个数一旦黑着，代理层就对「钱烧在哪」彻底失明。
  const td       = usage?.output_tokens_details;
  const thinking = typeof td?.thinking_tokens === 'number' ? td.thinking_tokens :
                   typeof usage?.thinking_tokens === 'number' ? usage.thinking_tokens : 0;
  return { prompt, completion, cacheHit, thinking };
}

// 单次落账的**唯一出口**：热路径 accumulate 与跨进程上报共用这一份成本公式，
// 避免以后调价/改口径时两处漂移（此前 cost 公式只在 accumulate 里写了一份）。
function applyTokens(proxyName, t, latencyMs) {
  if (!enabled()) return;
  const st = ensureState(proxyName);
  const { input: pIn, output: pOut, cacheHit: pCache } = st.pricing;
  const costDelta = (t.prompt - t.cacheHit) / 1e6 * pIn + t.completion / 1e6 * pOut +
                    (pCache !== undefined ? t.cacheHit / 1e6 * pCache : 0);
  st.promptTokens      += t.prompt;
  st.completionTokens += t.completion;
  st.totalTokens       += t.prompt + t.completion;
  // 不进 totalTokens（保持 total = prompt + completion 的既有口径，既有测试钉死这个等式）
  st.thinkingTokens   += t.thinking;
  st.cost              += costDelta;
  st.requestCount      += 1;
  if (typeof latencyMs === 'number') recordLatency(proxyName, latencyMs);
}

// 热路径主入口：门控关时零开销，开时从 usage 提取 + 累计 cost
function accumulate(proxyName, usage) {
  if (!enabled()) return;
  applyTokens(proxyName, extractTokens(usage || {}));
}

/**
 * 跨进程上报入口（方案②：代理进程自己把 usage 报给 manager）。
 *
 * 为什么需要它：Anthropic 线（/v1/messages）由 codex-proxy 处理，而 floor 盘面读的是
 * manager 进程的内存态 ⇒ 两进程不通，Anthropic 线在 manager 层**零采集**（10-02 实测）。
 *
 * 设计成「声明式、开盒即用」：接入方一行解析代码都不写，只要把上游原始 usage 原样带上
 * （对象 or 流式 SSE 文本），由 lib/usage-probe 按 wire 自动归一。
 * 今后新增 agent 的代理 / 新 provider，都走这条同样的上报路径。
 */
function reportUsage(opts) {
  const o = opts || {};
  const t = require('./usage-probe').toUsage(o.raw);
  applyTokens(o.agent || o.proxy || 'gateway', t, o.latencyMs);
  return t;
}

// 读 per-proxy 累计（对外快照，不暴露内部 timestamp）
function getCost(proxyName) {
  const st = _state[proxyName];
  if (!st) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, thinkingTokens: 0, cost: 0, requestCount: 0, latencyP50: latencyP50(proxyName) };
  return {
    promptTokens:     st.promptTokens,
    completionTokens: st.completionTokens,
    totalTokens:      st.totalTokens,
    thinkingTokens:   st.thinkingTokens,
    cost:             Math.round(st.cost * 1e6) / 1e6,
    requestCount:     st.requestCount,
    latencyP50:       latencyP50(proxyName),
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
  for (const k of Object.keys(_latency)) delete _latency[k];
}

module.exports = {
  enabled,
  setPricing,
  loadPricingFromEnv,
  accumulate,
  reportUsage,
  applyTokens,
  recordLatency,
  latencyP50,
  getCost,
  getAll,
  reset,
};
