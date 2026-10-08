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
 * @property {number} [halfOpenMaxCalls] - HALF_OPEN 状态允许的最大探测调用数
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
  }

  /**
   * @returns {CircuitState}
   */
  get currentState() {
    // 检查是否需要从 OPEN 转为 HALF_OPEN
    if (this.#state === 'OPEN' && Date.now() - this.#lastFailureTime >= this.#config.resetTimeout) {
      this.#state = 'HALF_OPEN';
      this.#halfOpenCalls = 0;
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
     if (b.#successCount >= threshold) {
       b.#state = 'CLOSED';
       b.#failureCount = 0;
       b.#successCount = 0;
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
   return this.#resolve(providerId).currentState !== 'OPEN';
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

module.exports = { CircuitBreaker };
