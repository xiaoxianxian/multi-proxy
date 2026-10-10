// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 公共模块：熔断器（CircuitBreaker）
// 来源：cursor-proxy/src/monitoring/circuitBreaker.ts（TypeScript）
// 提取为纯 JS，供所有 proxy 共享，避免各代理各自实现。
//
// 状态机：CLOSED → (failures>=threshold) → OPEN → (resetTimeout 到期) → HALF_OPEN
//          HALF_OPEN → (success) → CLOSED / (fail) → OPEN
//
// 门控设计：默认不启动定时器，由调用方决定是否轮询健康检查。
//
// P0-1 (cc-switch 借鉴 2026-10-08)：新增可选门控，全部默认关 → 老行为逐字不变(向后兼容)：
//   errorRateThreshold + slidingWindowSize + minRequests：CLOSED 态按「近窗错误率超阈 且 样本≥minRequests」
//     开熔断(替代纯计数，防低流量误熔断)；slidingWindowSize/errorRateThreshold 未设 → 该路径休眠。
//   successThreshold：HALF_OPEN 态需连续 N 次成功才回 CLOSED(默认 1，老行为)。
//   providerId：recordSuccess/recordFailure 可带 providerId(per-provider 维度)；不传 → 归 'default'(老行为)。

/** @typedef {'CLOSED'|'OPEN'|'HALF_OPEN'} CircuitState */

/**
 * @typedef {Object} CircuitBreakerConfig
 * @property {number} failureThreshold - 触发熔断的连续失败次数(老逻辑，始终生效)
 * @property {number} resetTimeout - OPEN→HALF_OPEN 的等待时间（ms）
 * @property {number} [halfOpenMaxCalls] - HALF_OPEN 状态允许的最大探测调用数（探测预算；不设=无限=老行为，仅靠 successThreshold 控制恢复）
 * @property {number} [errorRateThreshold] - 错误率开熔断阈值 0~1 (P0-1，默认关：未设则错误率门控不生效)
 * @property {number} [slidingWindowSize] - 错误率统计的滑动窗口大小(最近 N 次调用)；需配 errorRateThreshold 才生效
 * @property {number} [minRequests] - 错误率门控的最小样本数(样本不足不开熔断，防低流量误熔断)；默认 1
 * @property {number} [successThreshold] - HALF_OPEN→CLOSED 需连续成功次数(默认 1，老行为)
 */

class CircuitBreaker {
   /** @type {CircuitState} */
  #state = 'CLOSED';
  #failureCount = 0;
  #lastFailureTime = 0;
  #halfOpenCalls = 0;
  #halfOpenAdmitted = 0;      // HALF_OPEN 态已放行的探测数（受 halfOpenMaxCalls 预算约束）
  /** @type {CircuitBreakerConfig} */
  #config;
  // P0-1 新增(全默认 → 老行为不变)：
  #successCount = 0;          // HALF_OPEN 连续成功计数(达 successThreshold 才回 CLOSED)
  #outcomes = /** @type {Array<boolean>} */([]); // 滑窗：true=成功 false=失败，长度 ≤ slidingWindowSize
  #slidingWindowActive = false;
  /** @type {Map<string, CircuitBreaker>} */
  #siblingBreakers = new Map(); // per-provider 子熔断器(惰性 new，共享本实例的 config 副本)

  /**
   * @param {CircuitBreakerConfig} config
  */
  constructor(config) {
    this.#config = config;
    // 滑窗门控仅在显式配置 errorRateThreshold + slidingWindowSize 时打开(默认关，老行为不变)
    if (typeof config.errorRateThreshold === 'number' && typeof config.slidingWindowSize === 'number' && config.slidingWindowSize > 0) {
      this.#slidingWindowActive = true;
     }
    // §5 循环熔断协作（agent-infra/handoff-contract.md，可选注入，默认 null 零行为变更）：
    // 允许外部 HandoffGuard（l2/handoff-reason.js）在 allowRequest 放行前追加一道
    // 「乒乓 / 切换预算」门控。不注入则本熔断器行为逐字不变（向后兼容铁律）。
    this.handoffGuard = null;
  }

  /**
   * @returns {CircuitState}
   */
  get currentState() {
    // 检查是否需要从 OPEN 转为 HALF_OPEN
    if (this.#state === 'OPEN' && Date.now() - this.#lastFailureTime >= this.#config.resetTimeout) {
      this.#state = 'HALF_OPEN';
      this.#halfOpenCalls = 0;
      this.#successCount = 0;
      this.#halfOpenAdmitted = 0;
    }
    return this.#state;
  }

  /**
   * P0-1：解析 providerId 到目标熔断器(向后兼容)。
   * 不传 / 'default' → 本实例(老行为)；其余 → 惰性创建共享 config 副本的子熔断器(per-provider 维度)。
   * @param {string} [providerId='default']
   * @returns {CircuitBreaker}
   */
  #resolve(providerId) {
   const key = providerId || 'default';
   if (key === 'default') return this;
   if (!this.#siblingBreakers.has(key)) {
     this.#siblingBreakers.set(key, new CircuitBreaker({ ...this.#config }));
    }
   return this.#siblingBreakers.get(key);
  }

  /**
   * P0-1：把一次结果推进滑窗(仅在本实例打开滑窗时；子 breaker 各有自己的窗)。
   * @param {boolean} success
   */
  #pushOutcome(success) {
   if (!this.#slidingWindowActive) return;
   this.#outcomes.push(success);
   while (this.#outcomes.length > this.#config.slidingWindowSize) this.#outcomes.shift();
  }

  /**
   * P0-1：错误率门控 —— 仅当滑窗激活 且 样本数 ≥ minRequests 时，错误率超阈即开熔断。
   * minRequests 默认 1；errorRateThreshold 默认未设(滑窗不激活 → 本检查永不触发)。
   * @returns {boolean}
   */
  #errorRateExceeds() {
   const min = typeof this.#config.minRequests === 'number' ? this.#config.minRequests : 1;
   if (this.#outcomes.length < min) return false;
   const failures = this.#outcomes.filter((o) => o === false).length;
   return failures / this.#outcomes.length > this.#config.errorRateThreshold;
  }

  /**
   * 记录一次成功调用。
   * P0-1：HALF_OPEN 态需连续 successThreshold 次成功才回 CLOSED(默认 1，老行为)；
   * 可选 providerId(per-provider 维度，不传=本实例，老行为)。
   * @param {string} [providerId='default']
   */
  recordSuccess(providerId = 'default') {
   const b = this.#resolve(providerId);
   b.#pushOutcome(true);
   const threshold = typeof b.#config.successThreshold === 'number' ? b.#config.successThreshold : 1;
    if (b.#state === 'HALF_OPEN') {
      b.#successCount++;
      const maxProbes = typeof b.#config.halfOpenMaxCalls === 'number' ? b.#config.halfOpenMaxCalls : Infinity;
      if (b.#successCount >= threshold) {
        // 连续成功达阈值 → 恢复
        b.#state = 'CLOSED';
        b.#failureCount = 0;
        b.#successCount = 0;
        b.#halfOpenAdmitted = 0;
      } else if (b.#halfOpenAdmitted >= maxProbes) {
        // 探针预算用尽仍未达恢复阈值 → 回 OPEN（重新计时，避免无限半开）
        b.#state = 'OPEN';
        b.#lastFailureTime = Date.now();
        b.#successCount = 0;
        b.#halfOpenAdmitted = 0;
      }
    } else {
     b.#failureCount = 0;
     b.#successCount = 0;
    }
   b.#halfOpenCalls = 0;
  }

  /**
   * 记录一次失败调用。
   * P0-1：① HALF_OPEN / 连续计数达 threshold 开熔断(老逻辑不变)；② 新增错误率滑窗门控 ——
   * CLOSED 态样本≥minRequests 且错误率>errorRateThreshold 提前开熔断(默认关，老行为不变)。
   * 可选 providerId(per-provider 维度，不传=本实例，老行为)。
   * @param {string} [providerId='default']
   */
  recordFailure(providerId = 'default') {
   const b = this.#resolve(providerId);
   b.#pushOutcome(false);
   b.#failureCount++;
   b.#lastFailureTime = Date.now();

    if (b.#state === 'HALF_OPEN') {
      b.#state = 'OPEN';
      b.#halfOpenAdmitted = 0;
    } else if (b.#failureCount >= b.#config.failureThreshold) {
     b.#state = 'OPEN';
    } else if (b.#slidingWindowActive && b.#errorRateExceeds()) {
     b.#state = 'OPEN';
    }
  }

  /**
   * 判断是否允许发起新请求。
   * P0-1：可选 providerId(per-provider 维度，不传=本实例，老行为)。
   * @param {string} [providerId='default']
   * @returns {boolean}
   */
  allowRequest(providerId = 'default') {
    const b = this.#resolve(providerId);
    const st = b.currentState;
    if (st === 'OPEN') return false;
    if (st === 'HALF_OPEN') {
      // 半开探测预算：放行满 halfOpenMaxCalls 个探针后即不再放行（避免恢复期 provider 被探针洪泛）
      const maxProbes = typeof b.#config.halfOpenMaxCalls === 'number' ? b.#config.halfOpenMaxCalls : Infinity;
      if (b.#halfOpenAdmitted >= maxProbes) return false;
      b.#halfOpenAdmitted++;
    }
    // §5 循环熔断协作：注入 handoffGuard 后，放行前再问一道「该不该切到下一个 owner」。
    // guard 拒绝（乒乓 / 切换预算耗尽 / 超时）则不放行——防多 agent 互相甩锅。
    // 未注入（this.handoffGuard == null）时本行永不命中，行为逐字不变（向后兼容铁律）。
    if (this.handoffGuard && !this.handoffGuard.shouldHandoff(providerId).allow) return false;
    return true;
  }

  /**
   * 重置到 CLOSED 状态（用于手动恢复）。
   * P0-1：可选 providerId(per-provider 维度，不传=本实例，老行为)。
   * @param {string} [providerId='default']
   */
  reset(providerId = 'default') {
   this.#resolve(providerId).#resetAll();
  }

  /** @private P0-1：重置单 breaker 全状态 */
  #resetAll() {
    this.#state = 'CLOSED';
    this.#failureCount = 0;
    this.#lastFailureTime = 0;
    this.#halfOpenCalls = 0;
    this.#successCount = 0;
    this.#halfOpenAdmitted = 0;
    this.#outcomes.length = 0;
  }

  /**
   * P0-1：列出已知的 per-provider 子熔断器快照(default 实例本身不含在内)。
   * @returns {Record<string, Object>}
   */
  getProviders() {
   const result = {};
   for (const [id, breaker] of this.#siblingBreakers) {
     result[id] = breaker.getStateSnapshot();
    }
   return result;
  }

  /**
   * @returns {Object} 当前状态快照（供监控展示）
   */
  getStateSnapshot() {
   const snap = {
     state: this.currentState,
     failureCount: this.#failureCount,
     lastFailureTime: this.#lastFailureTime,
    halfOpenCalls: this.#halfOpenCalls,
    halfOpenAdmitted: this.#halfOpenAdmitted,
    config: { ...this.#config },
   };
    // P0-1：滑窗激活时附带错误率观测
   if (this.#slidingWindowActive) {
     const failures = this.#outcomes.filter((o) => o === false).length;
     snap.outcomes = this.#outcomes.length;
     snap.errorRate = this.#outcomes.length ? failures / this.#outcomes.length : 0;
    }
   return snap;
  }
  }

/**
 * cc-switch 借鉴（2026-10-08）：推荐默认熔断器配置。
 * 来源：对照研究文档里「cc-switch 非 claude 行默认 errorRate 0.6 / slidingWindow 10 / minRequests 4 / successThreshold 2」+ halfOpenMaxCalls 3。
 * 全部为「推荐值」，调用方按需采用；本模块不强制、不默认启用（门控仍由调用方各自控制）。
 *   failureThreshold 4 + resetTimeout 30000：兜底纯计数路径（滑窗未激活时也生效，避免低流量 4 连败误熔断的宽松版）
 *   errorRateThreshold 0.6 + slidingWindowSize 10 + minRequests 4：近 10 次样本≥4 时错误率>0.6 才 OPEN（防低流量误熔断）
 *   successThreshold 2：HALF_OPEN 需连续 2 次成功才回 CLOSED
 *   halfOpenMaxCalls 3：半开态最多 3 个探测，避免恢复期 provider 被探针洪泛
 */
const RECOMMENDED_CONFIG = Object.freeze({
  failureThreshold: 4,
  resetTimeout: 30000,
  errorRateThreshold: 0.6,
  slidingWindowSize: 10,
  minRequests: 4,
  successThreshold: 2,
  halfOpenMaxCalls: 3,
});

/**
 * 用推荐默认配置创建一个熔断器实例（不修改本模块任何默认行为，仅提供便捷构造）。
 * @returns {CircuitBreaker}
 */
function createRecommendedBreaker() {
  return new CircuitBreaker({ ...RECOMMENDED_CONFIG });
}

module.exports = { CircuitBreaker, RECOMMENDED_CONFIG, createRecommendedBreaker };
