// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== 通用 failover（bounded fallback）纯函数层 · 2026-10-15 ====================
// 目的：把「上游失败自动切下一个 provider」做成 multi-proxy 的**通用基础能力**，
//       任何 provider 在 providers.json 声明 `fallback` 字段即可启用，未声明则行为逐字不变。
//
// 设计纪律（与全站同源，见 竞品机制评估-HiRoute-bounded-failover-2026-10-14.md）：
//   · 门控友好：provider 不写 fallback ⇒ 老逻辑单次直发、失败不切（零默认行为变更）。
//   · 不是每个错误都该切：瞬态（网络异常/超时/5xx/429/408）才切；确定性 4xx 不切。
//     对齐 classifyUpstreamStatus：5xx/429/408 → 上游故障（记熔断），其余 4xx → 客户端错（不记）。
//   · 有界：MAX_FALLBACK_DEPTH 强制上限 + visited 去重，A→B→A 不会无限循环。
//   · 纯函数/IO 分离：判定与链解析不碰磁盘不碰网络，测试不依赖真实 provider。
//
// 典型用法（在 /v1/chat/completions 转发循环里）：
//   for (depth...) {
//     provider = findProvider(currentModel);
//     if (!provider) break;
//     if (breakerIsOpen(provider)) { /* 记 CIRCUIT_OPEN，进 fallback 决策 */ }
//     else { response = await fetch(...); if (response.ok) { commit; return; }
//            feedCircuit(provider, classifyUpstreamStatus(response.status));
//            if (!isRetryableFailure({status: response.status})) fail-loud; }
//     next = nextFallback(currentModel, visited, provider, allProviders);
//     if (!next) break; visited.add(next); currentModel = next;
//   }

const MAX_FALLBACK_DEPTH = 5;

/**
 * 瞬态故障判定：是否值得切到 fallback。
 * 与 classifyUpstreamStatus 对齐（5xx/429/408 → 上游故障，可重试）；其余 → 确定性，不切。
 * @param {{status?:number, errored?:boolean}} opts
 *   - errored=true：fetch 抛异常（DNS/连接/超时/TLS）—— 显然是瞬态，可切。
 *   - status：HTTP 状态码。>=500 或 429(限流) 或 408(超时) → 可切；其余（含 400/401/403/404 等）→ 不切。
 * @returns {boolean}
 */
function isRetryableFailure({ status, errored } = {}) {
  if (errored) return true;
  if (status === undefined || status === null) return false;
  return status >= 500 || status === 429 || status === 408;
}

/**
 * 把 provider 的 fallback 字段展开成「model 名数组」。
 * 支持三种写法（与 findProvider 的匹配语义一致）：
 *   · model 名（精确命中某 provider.models）→ 直接作为候选
 *   · model 名数组 → 逐项展开
 *   · provider_id 子串（不命中任何 models）→ 取该 provider 的首个 enabled model 作为代表
 * 不命中 models 也不是 provider_id 的裸字符串 → 当作裸 model 名保留（交由 findProvider 决定能否路由）。
 * @param {string|string[]|undefined} fallbackField
 * @param {Array} allProviders  loadProviders() 的结果（已 filter enabled）
 * @returns {string[]}
 */
function buildFallbackTargets(fallbackField, allProviders) {
  if (!fallbackField || (Array.isArray(fallbackField) && fallbackField.length === 0)) return [];
  const raw = Array.isArray(fallbackField) ? fallbackField : [fallbackField];
  const providers = Array.isArray(allProviders) ? allProviders : [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const token = item.trim();
    // 1) 精确命中某 provider 的 models → 直接当 model 名候选
    const matched = providers.find(p => Array.isArray(p.models) && p.models.includes(token));
    if (matched) { out.push(token); continue; }
    // 2) provider_id 子串 → 取该 provider 首个 model 作为代表
    const byId = providers.find(
      p => typeof p.provider_id === 'string' && token.toLowerCase().includes(p.provider_id.toLowerCase())
    );
    if (byId && Array.isArray(byId.models) && byId.models.length) { out.push(byId.models[0]); continue; }
    // 3) 裸 model 名（可能尚未在任何 provider 注册，但 findProvider 仍能解析）→ 保留
    out.push(token);
  }
  return out;
}

/**
 * 取下一个 fallback model 名（不在 visited 中）。无 → 返回 null。
 * 有界由调用方的循环深度 + visited 共同保证（这里只做「下一个且未访问」）。
 * @param {string} currentModel
 * @param {Set<string>|string[]} visited  已尝试过的 model 名集合（防循环）
 * @param {object} provider  当前 model 对应的 provider（含 fallback 字段）
 * @param {Array} allProviders  loadProviders() 的结果
 * @returns {string|null}
 */
function nextFallback(currentModel, visited, provider, allProviders) {
  const visitedSet = visited instanceof Set ? visited : new Set(visited || []);
  const targets = buildFallbackTargets(provider && provider.fallback, allProviders);
  for (const m of targets) {
    if (!visitedSet.has(m)) return m;
  }
  return null;
}

module.exports = {
  MAX_FALLBACK_DEPTH,
  isRetryableFailure,
  buildFallbackTargets,
  nextFallback,
};
