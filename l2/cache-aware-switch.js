// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under the AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 缓存感知切档（外部对照 #71 PilotDeck 落地件 · 2026-10-18）
//
// 来源：PilotDeck `RouterRuntime.ts` 的 maybePreserveStickyForCache（AGPL-3.0，
// 2026-10-18 经 7897 代理直读 GitHub 核证，母本 docs/10-initiatives/90-PilotDeck外部对照与路由工程设计对照-2026-10-18.md）。
// 抄它的度量衡：**换模型 = 丢 prompt cache = 全量重新 prefill**。切档前用
// 上轮观测的 cache 命中率估算两本账——
//   · 留在 current：估计命中部分按 cacheRead 价 + 未命中部分按 input 价；
//   · 切到 next：全量 input 价（新模型这边没有 cache）。
// 差额即「切档的隐性成本」。PilotDeck 的结论是「为保 cache 宁可留在当前档」，
// 本模块只算账不下结论（keepCurrent 是算出来的参考值，采不采由调用方定）。
//
// ⚠️ 数据源说明（2026-10-18 订正，勿再当缺口）：
//   首版注释写「账本未记 cacheRead」是**检索疏漏**——字段早就入账本了，键名叫
//   **cacheHit**（不是 cacheRead）：usage-probe 归一出 cacheHit/cacheCreation
//   （2026-10-12 补的 cache 写入分项），cost-track.applyTokens 按它计价，
//   账本行（cost-ledger.jsonl）每行都带 `prompt` / `cacheHit` / `cacheCreation`。
//   所以本函数的 lastUsage 可以从账本行直接构造：
//     { inputTokens: row.prompt, cacheReadTokens: row.cacheHit }
//   **真正缺的是消费方**（拿它做切档决策的那一跳），不是数据。
//   函数对无观测输入恒返回 keepCurrent:false（没依据不硬留）。
//
// 口径：pricing 单位 = 每百万 token（CNY），与 cost-track / cost.js 同口径。
//   cacheRead 价键名兼容两个：pricing.cacheRead ?? pricing.cacheHit
//   （cost-track 的 PROXY_PRICING 用 cacheHit，此处不擅自改对端口径，两个都收）。

const GATE_ENV = 'PROXY_CACHE_AWARE_SWITCH';

function gateOpen() {
  const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// 两个模型引用是否同一个（provider + model 双等）
function sameModel(a, b) {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

/**
 * 算「切档的 cache 账」。
 *
 * @param {object} input
 * @param {{provider: string, model: string}} [input.current] 当前档/模型引用
 * @param {{provider: string, model: string}} input.next 候选档/模型引用
 * @param {number} input.estimatedInputTokens 本轮估算输入 token（>0 才算）
 * @param {{inputTokens?: number, cacheReadTokens?: number}} [input.lastUsage] 上轮观测 usage
 * @param {object} [input.pricing] 价表 { [provider/model 或 model]: { input, output, cacheRead?|cacheHit? } }
 * @returns {{keepCurrent: boolean, cacheLoss: number|null, cachedCost: number|null, prefillCost: number|null,
 *            hitRatio: number, reason: string}}
 *           keepCurrent=false 且 reason 非空 = 不该/不能留（调用方照常切）
 */
function evaluateCacheAwareSwitch(input = {}) {
  const { current, next, estimatedInputTokens, lastUsage, pricing } = input;

  // 无参照系（没 current / 同一个模型）⇒ 无所谓切不切
  if (!current || !next) return { keepCurrent: false, cacheLoss: null, cachedCost: null, prefillCost: null, hitRatio: 0, reason: 'no current reference' };
  if (sameModel(current, next)) return { keepCurrent: false, cacheLoss: null, cachedCost: null, prefillCost: null, hitRatio: 0, reason: 'same model' };

  // 无本轮输入估算 ⇒ 没有计算对象
  if (!(estimatedInputTokens > 0)) return { keepCurrent: false, cacheLoss: null, cachedCost: null, prefillCost: null, hitRatio: 0, reason: 'no estimated input tokens' };

  // 上轮无 cache 观测 ⇒ 没依据，放行切换（对齐 PilotDeck：hitRatio<=0 直接 next）
  const inTok = Number(lastUsage && lastUsage.inputTokens) || 0;
  const cacheTok = Number(lastUsage && lastUsage.cacheReadTokens) || 0;
  const hitRatio = inTok > 0 ? Math.min(1, Math.max(0, cacheTok / inTok)) : 0;
  if (hitRatio <= 0) return { keepCurrent: false, cacheLoss: null, cachedCost: null, prefillCost: null, hitRatio, reason: 'no cache observation (hitRatio=0)' };

  // 价表：缺任一侧 ⇒ 算不出，放行切换（不拿 0 冒充「免费」，cost.js 同款纪律）
  const pCur = lookupPricing(pricing, current);
  const pNext = lookupPricing(pricing, next);
  if (!pCur || !pNext) return { keepCurrent: false, cacheLoss: null, cachedCost: null, prefillCost: null, hitRatio, reason: `missing pricing for ${!pCur ? 'current' : 'next'}` };

  const perM = 1e6; // 每百万 token
  const estCacheRead = Math.floor(estimatedInputTokens * hitRatio);
  const estUncached = Math.max(0, estimatedInputTokens - estCacheRead);

  const cacheReadPrice = pCur.cacheRead != null ? pCur.cacheRead : pCur.cacheHit;
  if (cacheReadPrice == null) return { keepCurrent: false, cacheLoss: null, cachedCost: null, prefillCost: null, hitRatio, reason: 'current pricing missing cacheRead/cacheHit rate' };

  const cachedCost = (estCacheRead * cacheReadPrice + estUncached * pCur.input) / perM;
  const prefillCost = (estimatedInputTokens * pNext.input) / perM;

  const cacheLoss = Math.round((prefillCost - cachedCost) * 1e6) / 1e6; // 正 = 切档要额外付的钱
  return {
    keepCurrent: cachedCost < prefillCost,
    cacheLoss: Math.round((prefillCost - cachedCost) * 1e6) / 1e6,
    cachedCost: Math.round(cachedCost * 1e6) / 1e6,
    prefillCost: Math.round(prefillCost * 1e6) / 1e6,
    hitRatio: Math.round(hitRatio * 1e4) / 1e4,
    reason: cachedCost < prefillCost ? 'staying keeps cache cheaper' : 'switch cost covered by pricing gap',
  };
}

// 价表查找：先 provider/model 复合键，再裸 model 键（两种写法都收）
function lookupPricing(pricing, ref) {
  if (!pricing || !ref) return null;
  const composite = pricing[`${ref.provider}/${ref.model}`];
  if (composite) return composite;
  return pricing[ref.model] || null;
}

module.exports = {
  evaluateCacheAwareSwitch,
  gateOpen,
  GATE_ENV,
};

// ---- 接线（2026-10-18 落地记录）----
// ① 数据源（已现成，无需新接）：cost-ledger.jsonl 每行带 prompt/cacheHit/cacheCreation。
//    调用方按 model 取该模型最近一行 ⇒ { inputTokens: prompt, cacheReadTokens: cacheHit }
//    喂本函数；pricing 用 cost-track.getPricingTable()（含 input/output/cacheHit 三价）。
// ② 决策：本函数为纯算账；「切档前调用它」的接线点在各 proxy 的 fallback/路由
//    决策处（generic-openai-proxy 的 nextFallback 之前），本轮**未接**——
//    先让观测值攒一阵（哪些模型真有 cache 命中、命中率多少），再谈决策接线
//    （shadow 先行纪律）。接线时门控 PROXY_CACHE_AWARE_SWITCH 默认关，关时零开销。
