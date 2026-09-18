'use strict';

// L2 公共模块：熔断器（CircuitBreaker）
// 来源：cursor-proxy/src/monitoring/circuitBreaker.ts（TypeScript）
// 提取为纯 JS，供所有 proxy 共享，避免各代理各自实现。
//
// 状态机：CLOSED → (failures>=threshold) → OPEN → (resetTimeout 到期) → HALF_OPEN
//          HALF_OPEN → (success) → CLOSED / (fail) → OPEN
//
// 门控设计：默认不启动定时器，由调用方决定是否轮询健康检查。

/** @typedef {'CLOSED'|'OPEN'|'HALF_OPEN'} CircuitState */

/**
 * @typedef {Object} CircuitBreakerConfig
 * @property {number} failureThreshold - 触发熔断的连续失败次数
 * @property {number} resetTimeout - OPEN→HALF_OPEN 的等待时间（ms）
 * @property {number} [halfOpenMaxCalls] - HALF_OPEN 状态允许的最大探测调用数
 */

class CircuitBreaker {
  /** @type {CircuitState} */
  #state = 'CLOSED';
  #failureCount = 0;
  #lastFailureTime = 0;
  #halfOpenCalls = 0;
  /** @type {CircuitBreakerConfig} */
  #config;

  /**
   * @param {CircuitBreakerConfig} config
   */
  constructor(config) {
    this.#config = config;
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
   * 记录一次成功调用
   */
  recordSuccess() {
    if (this.#state === 'HALF_OPEN') {
      this.#state = 'CLOSED';
      this.#failureCount = 0;
    } else {
      this.#failureCount = 0;
    }
    this.#halfOpenCalls = 0;
  }

  /**
   * 记录一次失败调用
   */
  recordFailure() {
    this.#failureCount++;
    this.#lastFailureTime = Date.now();

    if (this.#state === 'HALF_OPEN') {
      this.#state = 'OPEN';
    } else if (this.#failureCount >= this.#config.failureThreshold) {
      this.#state = 'OPEN';
    }
  }

  /**
   * 判断是否允许发起新请求
   * @returns {boolean}
   */
  allowRequest() {
    return this.currentState !== 'OPEN';
  }

  /**
   * 重置到 CLOSED 状态（用于手动恢复）
   */
  reset() {
    this.#state = 'CLOSED';
    this.#failureCount = 0;
    this.#lastFailureTime = 0;
    this.#halfOpenCalls = 0;
  }

  /**
   * @returns {Object} 当前状态快照（供监控展示）
   */
  getStateSnapshot() {
    return {
      state: this.currentState,
      failureCount: this.#failureCount,
      lastFailureTime: this.#lastFailureTime,
      halfOpenCalls: this.#halfOpenCalls,
      config: { ...this.#config },
    };
  }
}

module.exports = { CircuitBreaker };
