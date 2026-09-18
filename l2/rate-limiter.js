'use strict';

// L2 公共模块：令牌桶限流器（RateLimiter）
// 来源：cursor-proxy/src/monitoring/rateLimiter.ts（TypeScript）
// 提取为纯 JS，按 key（如 provider_id / model）独立限流。

class RateLimiter {
  /** @type {Map<string, {tokens: number, lastRefill: number}>} */
  #buckets = new Map();
  #defaultCapacity;
  #refillRate;

  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=60] - 默认桶容量（每分钟请求数）
   * @param {number} [options.refillRate=1] - 每秒补充令牌数
   */
  constructor(options = {}) {
    this.#defaultCapacity = options.capacity || 60;
    this.#refillRate = options.refillRate || 1;
  }

  /**
   * @param {string} key - 限流维度（如 provider id 或 model name）
   * @returns {{tokens: number, lastRefill: number}}
   */
  #getBucket(key) {
    const now = Date.now();
    if (!this.#buckets.has(key)) {
      this.#buckets.set(key, { tokens: this.#defaultCapacity, lastRefill: now });
    }
    const bucket = this.#buckets.get(key);
    // 补充令牌（线性插值）
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.#defaultCapacity, bucket.tokens + elapsed * this.#refillRate);
    bucket.lastRefill = now;
    return bucket;
  }

  /**
   * 检查 key 对应的限流桶是否允许一次请求
   * @param {string} key
   * @returns {boolean}
   */
  allowRequest(key) {
    const bucket = this.#getBucket(key);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * 获取指定 key 的剩余令牌数（供监控展示）
   * @param {string} key
   * @returns {number}
   */
  getTokens(key) {
    return this.#getBucket(key).tokens;
  }

  /**
   * 重置指定 key 的桶（用于手动恢复）
   * @param {string} key
   */
  reset(key) {
    this.#buckets.set(key, { tokens: this.#defaultCapacity, lastRefill: Date.now() });
  }

  /**
   * @returns {Object} 所有限流桶的快照
   */
  getAllSnapshots() {
    const result = {};
    for (const [key, bucket] of this.#buckets) {
      // 先 refill 再读
      this.#getBucket(key);
      result[key] = { tokens: bucket.tokens, capacity: this.#defaultCapacity };
    }
    return result;
  }
}

module.exports = { RateLimiter };
