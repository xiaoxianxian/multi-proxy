// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 P2 成本分析 · A 路 token×单价埋点（lib/cost-track.js）
//
// 职责：在 forward.js 热路径里，门控 PROXY_COST_TRACK 开时，
// 从 upstream response 的 `usage` 字段提取 token 数，结合 provider
// 配置的 `pricing`，算出本次请求的花费，内存累计 per-proxy 总成本。
//
// 设计原则（与 l2/ 内核铁律一致）：
//   - 非侵入：门控关时热路径零开销（只调 enabled() 做布尔判断，< 1μs）；
//            门控开时只读 usage 字段（不改 response.data、不注入 header）。
//   - 门控 PROXY_COST_TRACK 默认关 = observe（热路径不提取），开 = 提取累计 + **落盘**。
//   - pricing 注入：PROXY_PRICING_<proxy> env = JSON `{input, output, cacheHit?}`（每百万 tokens，CNY/USD）。
//     与 PROVIDERS-README.md 的 pricing 字段对齐。无 env 时默认 {input:0, output:0}（本地模型 cost=0）。
//   - pricing 可由 server 启动时调 `loadPricingFromEnv()` 注入，或调 `setPricing(name, pricing)` 显式设。
//
// 接入方式：
//    1. server.js 启动：`loadPricingFromEnv()` + `loadLedger()`（读回上次进程的历史账）
//    2. forward.js res.json 前：`accumulate(proxy, response.data?.usage, { model, requestModel })`
//    3. alert-route.js collect：`getCost(proxy)` 拿累计花费
//
// 门控 env：
//   PROXY_COST_TRACK=1/true/on  → 开（提取 usage 累计 + 落盘）
//   PROXY_PRICING_<proxy>       → 每 proxy 的单价（JSON，每百万 tokens）
//   PROXY_COST_LEDGER           → 账本文件路径（默认 ~/.multi-proxy-manager/cost-ledger.jsonl）
//
// ── 三模型字段（抄 CC Switch proxy_request_logs 的「记账三件套」；2026-10-03 补）──
//   model          = **实际计费模型**（请求被 route-engine 重写后、上游真跑的那个）
//   requestModel   = 请求里填的模型（宿主要的）
//   pricingModel   = 本次按哪套价表算的账（默认 = model；价表改了，历史账单不能跟着漂）
//
// 🔴 为什么要记 model / requestModel 这一对：route-engine 天天做模型重写
// （本机实测：`model=agnes-3.0-flash` ← `request_model=claude-haiku-4-5`）。
// 只按 proxy 聚合的账本**永远答不出「那批 claude-haiku 的请求到底烧了多少」** ——
// 而这正是成本归因唯一有价值的问题。没有这一对，账只能分到「codex-proxy 花了多少」。
//
// ── 持久账本（append-only jsonl；2026-10-03 补）──
//   `lib/cost-track.js` 此前是 `const _state = {}` **全内存态**，进程一死账就没 ⇒
// 多代理环境（WorkBuddy / Hermes / Codex 各起各的）里就是一堆孤岛，合账全靠上报端凑。
// 现在每次落账往 `cost-ledger.jsonl` 追加一行；启动时 `loadLedger()` 读回合并。

const fs = require('fs');
const path = require('path');
const os = require('os');
const upstreamCheck = require('./upstream-check');
// P3 分时定价（2026-10-12）：窗口判定是纯函数，单独成模块才能被单测钉死边界。
// 本文件只负责「调它 + 把结果带进账」。
const pricingSchedule = require('./pricing-schedule');

// 模型缺失时的兜底 key：宁可叫 <unknown>，也**绝不猜模型名**（猜错就是假数据）。
const UNKNOWN = '<unknown>';

// 已见 reqId（幂等窗口）：跨进程上报踩过 `on('close')` 与 `on('finish')` 双触发 ⇒
// 同一次响应落两遍账（实测 252 = 126×2）。有 reqId 才去重；没有的照记（不猜）。
const _seen = new Set();
const SEEN_MAX = 50000;

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
// =====================================================================
// model 级价表（2026-10-12 P2）
// ---------------------------------------------------------------------
// 🔴 为什么加：此前取价只用 `st.pricing`（**per-proxy** 一套价），而 providers.json 里
//    的 pricing 是 **per-model** 的（`models[].pricing`）。PROVIDERS-README.md:30-31 自己
//    写着 pricing 字段「当前代码尚未使用，属前向兼容预留」—— 2026-10-12 全仓检索确认
//    **没有任何代码读 providers.json** ⇒ 同一网关下 deepseek / agnes / qwen 共用一套价，
//    「按模型控成本」根本不成立。这是 P3 分时价 / P7 订阅的前置：平价表不接进路由，
//    后面所有定价能力都是空转。
//
// 🔴 铁律（维护者 2026-10-12 第 3 点）：**「值是 0」和「值不存在」是不同参数**。
//    agnes 的 pricing={0,0,0} 是**真免费**（带 priceSource 注明来源与日期），
//    而「查不到这个模型」必须标 unknown，绝不静默当 0 —— 否则两者在账上长得一样，
//    后面任何按价的推导（省钱率、预算告警）都会建立在流沙上。
//    所以取价结果带 source：
//      'model'   = providers.json 里有这个模型的价格（可能是真 0，看 priceSource）
//      'proxy'   = 模型没登记，回落到 per-proxy 那套价
//      'unknown' = 都没有 ⇒ 算出来的 0 是「没价」，不是「免费」
// =====================================================================
const modelMetadata = require('./model-metadata');
const _modelPricing = new Map();   // modelId -> {input, output, cacheHit, priceSource?, providerId?, retrievedAt?}

// 读价表。失败不抛：价表读不出来只影响算钱，不该让网关起不来。
//
// 🔴 2026-10-12 实测发现（不改这里 P2/P3 全是空转）：
//    ~/.multi-proxy-manager/**providers.json 里根本没有 `models[]`** —— 它是 manager UI
//    生成的 provider 注册表（id/name/api_key/base_url），与 providers.sample.json 的
//    「provider 级 + models[]」形状**早就漂移了**。实测 loaded=0 ⇒ 真机上一个模型
//    价格都没读到，所有账的 pricingSource 都是 unknown。
//    与其去改 manager UI 的产出格式（那是它的地盘，且随时会被 UI 覆写），
//    不如让价表**独立于 providers.json**：新增 pricing.json（扁平形状），两者都读。
//
// 支持两种形状（一眼分辨，不用配置字段声明）：
//   A. provider 级：{ provider_id, models: [ { id, pricing, offPeakPricing? } ] }  ← sample 格式
//   B. 扁平：      { id, pricing, offPeakPricing? }                                ← pricing.json
// 同名模型**后面的文件覆盖前面的** ⇒ 调用方把「专门的价表」放后面。
function loadPricingFromProviders(input) {
  const files = Array.isArray(input)
    ? input
    : [input || path.join(os.homedir(), '.multi-proxy-manager', 'providers.json')];
  let loaded = 0;
  const errors = [];
  for (const f of files) {
    const r = _loadPricingFile(f);
    loaded += r.loaded;
    if (!r.ok) errors.push({ file: f, reason: r.reason });
  }
  return {
    ok: loaded > 0 || errors.every((e) => /ENOENT|no such file/i.test(e.reason || '')),
    loaded,
    errors,
  };
}

// 登记一条模型价（两种形状共用）。返回是否真的登记了。
function _registerModelPricing(m, prov) {
  if (!m || !m.id || !m.pricing) return false;
  _modelPricing.set(m.id, {
        input:       Number(m.pricing.input)  || 0,
        output:      Number(m.pricing.output) || 0,
        cacheHit:    m.pricing.cacheHit != null ? (Number(m.pricing.cacheHit) || 0) : undefined,
        priceSource: m.priceSource || undefined,
        providerId:  prov.provider_id || prov.id || undefined,
        // P4：价格采集时刻（缺失 null，不造「现在」）。
        retrievedAt: modelMetadata.extractRetrievedAt(m),
        // P3：分时档。存原样（不在加载期做窗口判定 —— 判定必须发生在**计价那一刻**）。
        offPeakPricing: m.offPeakPricing || undefined,
      });
  return true;
}

// 读单个价表文件（providers.json / pricing.json 共用）。
function _loadPricingFile(file) {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, loaded: 0, reason: String((e && e.message) || e) };
  }
  if (!Array.isArray(list)) return { ok: false, loaded: 0, reason: '不是数组' };
  let n = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.models)) {
      for (const m of entry.models) if (_registerModelPricing(m, entry)) n += 1;
    } else if (_registerModelPricing(entry, entry)) {
      n += 1;
    }
  }
  return { ok: true, loaded: n };
}

// 计价时刻（P3）：默认「现在」。
// 🔴 语义钉死 = **completion time**：本函数只在响应完成、usage 拿到手之后被调用，
//    所以「现在」就是响应完成那一刻。跨窗口的整单按完成时那一档算（抄 LiteLLM 规格），
//    不扯「请求发起 vs 响应结束」。
//    跨进程上报（codex-proxy → manager）时可以显式传 `at`，避免上报延迟把账算到
//    下一档去。传不了就按收到时算 —— 差几毫秒，远比不记账好。
function resolveAt(opts) {
  const v = opts && opts.at;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (isFinite(t)) return t;
  }
  return Date.now();
}

// 取价：model → proxy → unknown。返回的 source 必须跟着走完整个记账链路，
// 否则「没价」和「免费」在账上无法区分。
// 🔴 返回结构与 l2/savings-gateway/gateway.js 的 resolvePricing 对齐（{source, key, input, output}），
//    别在仓库里造第二套约定。
//
// ── P3 分时档（2026-10-12）──
//   opts.at  计价时刻（ms 或 ISO 串），默认 Date.now()（= completion time）
//   window   'standard' = 按标准价收；'w0'/'w1'… = 命中第几个 off-peak 窗口
//   scheduled  该模型**配没配**分时档。与 window 是两件事：
//      配了但在 peak 时段  → scheduled=true,  window='standard'
//      压根没配分时档      → scheduled=false, window='standard'
//    🔴 必须分得开：前者是「查过时刻表、这单该收标准价」，后者是「这个模型没有时刻表」。
//      合成一个字段的话，以后回答「哪些模型有闲时折扣可挖」就只能重扫配置。
function resolvePricing(pricingModel, st, opts) {
  const at = resolveAt(opts);
  const mp = pricingModel ? _modelPricing.get(pricingModel) : null;
  if (mp) {
    const sched = mp.offPeakPricing;
    if (sched) {
      const ov = pricingSchedule.applyOffPeak(mp, sched, at);
      return {
        source: 'model', key: pricingModel,
        input: ov.input, output: ov.output, cacheHit: ov.cacheHit,
        window: ov.window, windowIndex: ov.windowIndex, offPeak: ov.offPeak,
        scheduled: true,
        priceSource: ov.priceSource || mp.priceSource,
        retrievedAt: mp.retrievedAt == null ? null : mp.retrievedAt,
      };
    }
    return {
      source: 'model', key: pricingModel,
      input: mp.input, output: mp.output, cacheHit: mp.cacheHit,
      window: 'standard', windowIndex: -1, offPeak: false, scheduled: false,
      priceSource: mp.priceSource,
      retrievedAt: mp.retrievedAt == null ? null : mp.retrievedAt,
    };
  }
  const sp = st && st.pricing;
  if (sp && (Number(sp.input) || Number(sp.output) || Number(sp.cacheHit))) {
    return {
      source: 'proxy', key: pricingModel || UNKNOWN,
      input: Number(sp.input) || 0, output: Number(sp.output) || 0,
      cacheHit: sp.cacheHit != null ? Number(sp.cacheHit) || 0 : undefined,
      window: 'standard', windowIndex: -1, offPeak: false, scheduled: false,
      retrievedAt: null,
    };
  }
  return {
    source: 'unknown', key: pricingModel || UNKNOWN, input: 0, output: 0, cacheHit: undefined,
    window: 'standard', windowIndex: -1, offPeak: false, scheduled: false,
    retrievedAt: null,
  };
}

// 按模型拆账的**空壳条目**（三模型字段的 store）。
// 抽成函数是为了 setPricing / ensureState / _bump 三处共用一份定义，避免以后加字段漏改一处而漂移。
function emptyModelEntry() {
  return { requestCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, requestModels: {} };
}

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
      models: {},
      requestModels: {},
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
      // 2026-10-12 补（cc-switch 借鉴 P1-2）：cache 写入分项 + 首 token 延迟口径。
      // 此前只有 cacheHit（读取）折扣，写入侧完全黑 —— 而 Anthropic 的 cache write 比
      // 普通 input 更贵（官方 1.25×），记不下来就永远算不清"缓存到底省没省钱"。
      cacheCreationTokens: 0,
      firstTokenMsSum: 0,        // 首 token 延迟累加（配合下者算均值）
      firstTokenMsCount: 0,
      cost: 0,
      requestCount: 0,
      pricing: p,
      models: {},
      requestModels: {},
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
  // 2026-10-12 补：cache **写入**分项（Anthropic 的 cache_creation_input_tokens；
  // OpenAI 侧没有对应用法，故为 0）。与 cacheHit（读取）分开记：读取打折、写入加价，
  // 混在一个数里就没法判断缓存到底是省还是亏。
  const cacheCreation = typeof usage?.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens :
                        typeof usage?.cacheCreation              === 'number' ? usage.cacheCreation              : 0;
  // 推理痕迹（**只计数不计费**）：上游 output_tokens 通常已含 thinking，再算一遍就是重复计费。
  // 单列出来的理由是**可观测**——真付费上游实测（64 号 §七坑 6）：max_tokens 被 thinking 吃满时
  // 整条响应一个 text 块都没有；盘面上只看得到「输出 27」，看不出「27 里 23 是空转的思考」。
  // 这个数一旦黑着，代理层就对「钱烧在哪」彻底失明。
  const td       = usage?.output_tokens_details;
  const thinking = typeof td?.thinking_tokens === 'number' ? td.thinking_tokens :
                   typeof usage?.thinking_tokens === 'number' ? usage.thinking_tokens : 0;
  return { prompt, completion, cacheHit, cacheCreation, thinking };
}

// 单次落账的**唯一出口**：热路径 accumulate 与跨进程上报共用这一份成本公式，
// 避免以后调价/改口径时两处漂移（此前 cost 公式只在 accumulate 里写了一份）。
//
// info（全部可选）：{ model, requestModel, pricingModel, reqId, agent }
//   model / requestModel / pricingModel —— 三模型字段，见文件头注释。
//   reqId —— 幂等键（跨进程上报的 tee 双触发会重报同一条账，见 _seen）。
// givenCost —— 外部带的**已算好的 cost**（ledger 读回时用：账已按当时价表冻结，不许再用现价重算）。
// 读回历史账本时置真：loadLedger 内部走的是 applyTokens（唯一落账出口），
// 不设这个标志的话**读一遍就把整个历史账再追加一遍**（文件翻倍，且下次启动又翻倍）。
let _loading = false;

function applyTokens(proxyName, t, latencyMs, info, givenCost) {
  if (!enabled()) return;
  const i = info || {};
  // 幂等：只在拿到 reqId 时生效。没有 reqId 就照记 —— 不猜、不静默丢账。
  if (i.reqId) {
    const k = proxyName + '|' + i.reqId;
    if (_seen.has(k)) return;      // 同一次响应重复上报 ⇒ 只记一笔
    _seen.add(k);
    if (_seen.size > SEEN_MAX) _seen.clear();   // 内存兜底：本机量级够用，不引入 LRU
  }
  // pricingModel 默认 = model（实际计费模型决定用哪套价）；都没有就 <unknown>（绝不猜模型名）
  const pricingModel = i.pricingModel || i.model || UNKNOWN;
  const requestModel = i.requestModel || UNKNOWN;

  const st = ensureState(proxyName);
  // 🔴 2026-10-12 P2：取价从「per-proxy 一套价」改成 model → proxy → unknown。
  //    pricingSource 必须随账落盘 —— 不记的话，一个「没登记价格」的模型和一个
  //    「真免费」的模型在账上都记 cost=0，之后任何省钱率/预算推导都建立在流沙上。
  // 🔴 P3：at 用上报端给的完成时刻（i.at），没有就按收到时算（= completion time）。
  const pr = resolvePricing(pricingModel, st, { at: i.at });
  const pIn = pr.input, pOut = pr.output, pCache = pr.cacheHit;
  // cache 写入单价：价表里配了 cacheCreation 就用，没配则回退到 input 价（不猜折扣，
  // 宁可高估也别把"写入很贵"这件事抹掉 —— Anthropic 官方是 input 的 1.25×）。
  const pCacheWrite = pr.cacheCreation !== undefined ? pr.cacheCreation : pIn;
  const pricingSource = pr.source;
  const costDelta = givenCost != null ? givenCost
    : (t.prompt - t.cacheHit) / 1e6 * pIn + t.completion / 1e6 * pOut +
      (pCache !== undefined ? t.cacheHit / 1e6 * pCache : 0) +
      // 🔴 `|| 0` 不是防御性冗余：老账本行（loadLedger 读回）和外部调用方构造的 t
      // 都**没有** cacheCreation 字段，undefined 会让 costDelta 整个变 NaN ——
      // 一次 NaN 就把这个 proxy 的累计账彻底污染，且不会报错。宁可记 0，不许记 NaN。
      (t.cacheCreation || 0) / 1e6 * pCacheWrite;
  st.promptTokens      += t.prompt;
  st.completionTokens += t.completion;
  st.totalTokens       += t.prompt + t.completion;
  // 不进 totalTokens（保持 total = prompt + completion 的既有口径，既有测试钉死这个等式）
  st.thinkingTokens   += t.thinking;
  // 同样不进 totalTokens：cache 写入是 input 之外的独立计费项（Anthropic 口径）
  st.cacheCreationTokens += (t.cacheCreation || 0);   // 同上：NaN 比 0 危险得多
  if (typeof i.firstTokenMs === 'number') {
    st.firstTokenMsSum += i.firstTokenMs;
    st.firstTokenMsCount += 1;
  }
  st.cost              += costDelta;
  st.requestCount      += 1;

  // 按模型拆账：成本归到**实际计费模型**上，requestModel 挂在其下回答「请求侧那个模型烧了多少」
  const m = _bump(st.models, pricingModel, t, costDelta);
  _bump(m.requestModels, requestModel, t, costDelta);
  _bump(st.requestModels, requestModel, t, costDelta);

  if (typeof latencyMs === 'number') recordLatency(proxyName, latencyMs);
  // 上游横向体检喂样本（与账同源：唯一落账出口 = 这里）。
  // 🔴 必须挂在 `!_loading` 里：loadLedger() 读回历史账也走 applyTokens，
  // 照记的话每次重启都会把历史账当成新样本，体检一开就叫满屏偏离（跟账本翻倍同坑）。
  if (!_loading) {
    upstreamCheck.sample({
      model: pricingModel, upstream: proxyName,
      prompt: t.prompt, cacheHit: t.cacheHit, reported: i.reportedModel,
    });
  }

  if (!_loading) ledgerAppend({
    ts: new Date().toISOString(),
    // 本地时区日期键（2026-10-16 新增）。周报的「上周」按北京时间理解，
    // 过去只有 UTC 的 ts 可用 → 23:00–24:00 的请求会被算进前一天，
    // 窗口边界差一天且界面上没有提示。落账时就算好，读的时候直接用。
    // tz 由 PROXY_COST_TZ 覆盖，默认 Asia/Shanghai；时区名无效则不加这个字段
    // （=「不知道」），读侧会 fallback 到按 ts 现算，绝不写一个错的日期进去。
    localDay: localDayOf(new Date()),
    proxy: proxyName,
    agent: i.agent || proxyName,
    model: pricingModel,
    requestModel,
    pricingSource,          // 'model' | 'proxy' | 'unknown'（P2：区分「真免费」与「没价」）
    // P4：价格采集时刻。没有就省略该字段（=「不知道」），绝不伪造「现在」。
    pricingRetrievedAt: pr.retrievedAt || undefined,
    // P3 分时档：'standard' = 标准价；'w0'… = 命中第几个 off-peak 窗口。
    // 🔴 只记在**配了分时档**的模型上（pr.scheduled）—— 没配时刻表的模型记
    //    'standard' 是句废话，还会把「哪些模型有闲时可挖」这个问题搅浑。
    pricingWindow: pr.scheduled ? pr.window : undefined,
    prompt: t.prompt,
    completion: t.completion,
    cacheHit: t.cacheHit || 0,
    // 2026-10-12 补：cache 写入分项 + 首 token 延迟（都是"钱花在哪/慢在哪"的可观测项）
    cacheCreation: t.cacheCreation || 0,
    firstTokenMs: typeof i.firstTokenMs === 'number' ? i.firstTokenMs : undefined,
    thinking: t.thinking || 0,
    cost: costDelta,
    latencyMs: typeof latencyMs === 'number' ? latencyMs : undefined,
    reqId: i.reqId,
  });
}

// 往 { [model]: entry } 字典里累加一条（entry 结构见 emptyModelEntry）
function _bump(bag, key, t, costDelta) {
  const e = bag[key] || (bag[key] = emptyModelEntry());
  e.requestCount      += 1;
  e.promptTokens      += t.prompt;
  e.completionTokens += t.completion;
  e.totalTokens       += t.prompt + t.completion;
  e.cost              += costDelta;
  return e;
}

// 热路径主入口：门控关时零开销，开时从 usage 提取 + 累计 cost。
// info 可选，透传给 applyTokens（model / requestModel 由 forward.js 从请求/响应体取）。
function accumulate(proxyName, usage, info) {
  if (!enabled()) return;
  applyTokens(proxyName, extractTokens(usage || {}), undefined, info);
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
  applyTokens(o.agent || o.proxy || 'gateway', t, o.latencyMs, {
    model:         o.model,          // 实际计费模型
    requestModel:  o.requestModel,    // 请求里填的模型（route-engine 可能已经重写过）
    pricingModel:  o.pricingModel,    // 用哪套价表算的（默认回落 model）
    reqId:         o.reqId,           // 幂等键（跨进程 tee 双触发靠它去重）
    agent:         o.agent,
    at:            o.at,              // P3：完成时刻（跨进程上报时带上，避免上报延迟跨档）
  });
  return t;
}

// ── 持久账本：append-only jsonl ──
// 落点默认 ~/.multi-proxy-manager/cost-ledger.jsonl —— 那是既定的**运行时数据目录**
// （providers.json / agent-token 都住那儿）；PROXY_COST_LEDGER 可覆盖（测试用 tmp 目录）。
//
// 为什么 append-only 而不用重写整个 JSON：代理进程被 kill / 崩的瞬间，重写文件可能写坏
// 整个账本；追加一行最多丢最后一条（而且 appendFileSync 是同步的，一般连这条都保得住）。
function ledgerFile() {
  const env = process.env.PROXY_COST_LEDGER;
  return env && env.trim() ? env.trim()
    : path.join(os.homedir(), '.multi-proxy-manager', 'cost-ledger.jsonl');
}

/**
 * 本地时区日期键（YYYY-MM-DD）。tz 来自 PROXY_COST_TZ，默认 Asia/Shanghai。
 *
 * 为什么需要它：账本行里的 ts 是 UTC ISO 串，`ts.slice(0,10)` 拿到的是 UTC 日期。
 * 周报的「上周」由用户按北京时间理解，UTC 口径下 23:00–24:00 的请求会被算进
 * 前一天——窗口边界差一天，而此前界面上没有任何提示。
 *
 * 时区名无效 → 返回 null（Intl 会抛 RangeError）。调用方省略该字段，
 * 读侧 fallback 到按 ts 现算。**不静默用 UTC 冒充**：那会让「配错了时区」
 * 和「配对了」在账本上长得一样。
 */
function localDayOf(d) {
  const zone = process.env.PROXY_COST_TZ || 'Asia/Shanghai';
  try {
    // en-CA 的 DateTimeFormat 产出 YYYY-MM-DD（ISO 顺序），正好当日期键用。
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d);
  } catch {
    return null;
  }
}

function ledgerAppend(rec) {
  try {
    const file = ledgerFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch {
    // 记账失败绝不拖累热路径：可以少记一笔账，不能让请求挂在这。
  }
}

/**
 * 读回历史账本并合并进内存态（server.js 启动时调一次）。
 * 返回读到的行数（0 = 无账本 / 门控关 / 读失败，三种都不算错）。
 *
 * 🔴 读回时用**行内冻结的 cost**，不用当前价表重算 —— 价表一改，历史账单就会跟着漂，
 * 去年记的账今年自己变了，那账本就白记了。这正是 `pricingModel` 字段存在的理由。
 */
function loadLedger(fileOverride) {
  const file = fileOverride || ledgerFile();
  let text;
  try {
    if (!fs.existsSync(file)) return 0;
    text = fs.readFileSync(file, 'utf8');
  } catch { return 0; }

  let n = 0;
  _loading = true;                    // 见 _loading 注释：读回期间禁止回写账本
  try {
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let r;
      try { r = JSON.parse(s); } catch { continue; }   // 半行/损坏 → 跳过（append 写不会破坏前面的行）
      if (!r || typeof r !== 'object') continue;
      applyTokens(
      r.proxy || UNKNOWN,
      {
        prompt: r.prompt || 0, completion: r.completion || 0,
        cacheHit: r.cacheHit || 0, thinking: r.thinking || 0,
      },
      undefined,
      { model: r.model, requestModel: r.requestModel, pricingModel: r.pricingModel, agent: r.agent },
      r.cost,
      );
      n++;
    }
  } finally {
    _loading = false;
  }
  return n;
}

// P7：**只读**账本条目出口（预算闸门吃它）。与 loadLedger 的区别：
//   loadLedger        —— 读回并**应用进内存态**（启动期恢复用，有副作用：_state 被改写、
//                        还会喂 upstreamCheck 样本外的路径，见 applyTokens 的 !_loading 注释）
//   readLedgerEntries —— 只解析返回 [{...}]，**不碰 _state、不喂样本、不记 seen**
// 预算判定是「看一眼历史」，不能因为看了一眼就把账本重新应用一遍（那会让
// upstreamCheck 的样本、getAll 的累计全部翻倍——与「重启一次账本翻倍」同坑）。
// 解析容错与 loadLedger 相同：坏行跳过（append 写不会破坏前面的行）。
function readLedgerEntries(fileOverride) {
  const file = fileOverride || ledgerFile();
  let text;
  try {
    if (!fs.existsSync(file)) return [];
    text = fs.readFileSync(file, 'utf8');
  } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r && typeof r === 'object') out.push(r);
    } catch { /* 半行/损坏 → 跳过 */ }
  }
  return out;
}

// P7-2（2026-10-12）：价表只读出口（预算预检的快照字段之一）。
// codex-proxy 的热路径预检要算「这个请求最坏情况花多少」，需要单价；
// manager 不可达时 proxy 用上次同步下来的快照，价格就在快照里。
// 🔴 返回**拷贝**：直接给 _modelPricing 的引用会让调用方改到内部价表（同 cloneModels 的理由）。
// 只带 model 级价（proxy 级 fallback 价是 manager 路由时的兜底，预检估不出就放行，不猜）。
function getPricingTable() {
  const out = {};
  for (const [modelId, mp] of _modelPricing) {
    if (!mp || typeof mp !== 'object') continue;
    out[modelId] = {
      input: mp.input,
      output: mp.output,
      cacheHit: mp.cacheHit != null ? mp.cacheHit : undefined,
    };
  }
  return out;
}

// 按模型拆账的对外拷贝（**必须拷贝**：直接给引用会让调用方改到内部 _state，账就脏了）
function cloneModels(bag) {
  const out = {};
  for (const k of Object.keys(bag)) {
    const e = bag[k];
    out[k] = {
      requestCount:     e.requestCount,
      promptTokens:     e.promptTokens,
      completionTokens: e.completionTokens,
      totalTokens:      e.totalTokens,
      cost:             Math.round(e.cost * 1e6) / 1e6,
      requestModels:    { ...e.requestModels },
    };
  }
  return out;
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
    // 没按模型拆过 = null（与 latencyP50 同一口径：**绝不折算成空字典充数**）
    models:           Object.keys(st.models).length ? cloneModels(st.models) : null,
    requestModels:    Object.keys(st.requestModels).length ? cloneModels(st.requestModels) : null,
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

// 测试/重启用（**只清内存，不删账本文件** —— 账本是持久资产，reset 不该销毁历史）
function reset() {
  for (const k of Object.keys(_state)) delete _state[k];
  for (const k of Object.keys(_latency)) delete _latency[k];
  _seen.clear();
}

module.exports = {
  localDayOf,
  enabled,
  setPricing,
  loadPricingFromEnv,
  accumulate,
  reportUsage,
  applyTokens,
  recordLatency,
  latencyP50,
  getCost,      // → models / requestModels 两个按模型的拆账视图
  getAll,
  loadLedger,
  // P7（2026-10-12）：只读账本条目（预算闸门用）。**不应用进内存态**——
  // 与 loadLedger 的副作用边界见函数注释。budget-guard 的纯函数吃这个数组。
  readLedgerEntries,
  // P7-2（2026-10-12）：价表只读拷贝（预算预检快照用，见函数注释）。
  getPricingTable,
  ledgerFile,
  reset,
  // P2（2026-10-12）：model 级价表。loadPricingFromProviders 在 server 启动时调一次；
  // resolvePricing 是取价唯一出口（model → proxy → unknown），导出便于单测钉死 fallback 链。
  loadPricingFromProviders,
  resolvePricing,
  // P3（2026-10-12）：分时档。validatePricingSchedule 是**启动期静态体检** —— 运行期
  // 对畸形一律 fail-safe 走标准价（安全），但畸形必须报出来，否则「配了却没生效」
  // 会永远查不出来（与「宁可留个明处的缺口」同一条纪律）。
  validatePricingSchedule,
  // 纯函数层也导出：测成本轨的测试可以直接钉窗口边界，不用绕着 state 走。
  pricingSchedule,
};

// 启动期体检：扫已登记的 model 级价表，把**会静默退化成标准价**的分时配置报出来。
// 返回 [{ model, problems: [...] }]；空数组 = 没问题。
// 🔴 只报不改：运行期行为由 pricing-schedule 的 fail-safe 保证，这里只负责让人看见。
function validatePricingSchedule() {
  const out = [];
  for (const [modelId, mp] of _modelPricing) {
    if (!mp.offPeakPricing) continue;
    const problems = pricingSchedule.validateSchedule(mp.offPeakPricing);
    if (problems.length) out.push({ model: modelId, problems });
  }
  return out;
}
