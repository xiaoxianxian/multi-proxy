'use strict';

// L2 公共模块：健康监控器（HealthMonitor）
// 来源：cursor-proxy/src/monitoring/healthMonitor.ts（TypeScript）
// 提取为纯 JS，聚合各 provider 的健康状态 + 熔断器联动。
//
// 注意：本模块依赖 fetch（Node 18+ 内置），不引入外部依赖。
// 调用方需提供 configsRef（含 baseUrl / apiKey / id），本模块只读不写配置。

const { CircuitBreaker } = require('./circuit-breaker.js');

const DEFAULT_TIMEOUT_MS = 5000;
const HEALTH_ENDPOINT = '/models';

class HealthMonitor {
  /** @type {Map<string, {state: string, lastChecked: number, error?: string}>} */
  #statuses = new Map();
  /** @type {Map<string, CircuitBreaker>} */
  #breakers = new Map();
  #interval = 30000; // 30s 轮询间隔
  #timer = null;

  /**
   * 启动健康检查定时器
   * @param {{current: Array<{id: string, baseUrl: string, apiKey: string, enabled?: boolean}>}} configsRef
   */
  start(configsRef) {
    this.#runCheck(configsRef);
    this.#timer = setInterval(() => this.#runCheck(configsRef), this.#interval);
    // unref 以便 timer 不阻塞进程退出
    if (this.#timer.unref) this.#timer.unref();
  }

  /**
   * 停止健康检查定时器
   */
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * 获取单个 provider 的健康状态
   * @param {string} providerId
   * @returns {{state: string, lastChecked: number, error?: string} | undefined}
   */
  getStatus(providerId) {
    return this.#statuses.get(providerId);
  }

  /**
   * 获取所有 provider 的健康状态
   * @returns {Record<string, {state: string, lastChecked: number, error?: string}>}
   */
  getAllStatuses() {
    const result = {};
    for (const [id, status] of this.#statuses) {
      result[id] = { state: status.state, lastChecked: status.lastChecked, error: status.error };
    }
    return result;
  }

  /**
   * 获取所有熔断器状态快照
   * @returns {Record<string, Object>}
   */
  getAllCircuitBreakers() {
    const result = {};
    for (const [id, breaker] of this.#breakers) {
      result[id] = breaker.getStateSnapshot();
    }
    return result;
  }

  /**
   * 手动触发一次健康检查（供测试或按需刷新）
   * @param {{current: Array<{id: string, baseUrl: string, apiKey: string, enabled?: boolean}>}} configsRef
   */
  async refresh(configsRef) {
    await this.#runCheck(configsRef);
  }

  /**
   * 清除指定 provider 的状态（用于重置）
   * @param {string} providerId
   */
  clearStatus(providerId) {
    this.#statuses.delete(providerId);
    this.#breakers.delete(providerId);
  }

  /**
   * @param {string} id
   * @returns {CircuitBreaker}
   */
  #ensureBreaker(id) {
    if (!this.#breakers.has(id)) {
      this.#breakers.set(id, new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 30000,
        halfOpenMaxCalls: 1,
      }));
    }
    return this.#breakers.get(id);
  }

  /**
   * @param {{current: Array<{id: string, baseUrl: string, apiKey: string, enabled?: boolean}>}} configsRef
   */
  async #runCheck(configsRef) {
    const configs = configsRef.current.filter((c) => c.enabled !== false);
    await Promise.all(configs.map((config) => this.#checkProvider(config)));
  }

  /**
   * @param {{id: string, baseUrl: string, apiKey: string}} config
   */
  async #checkProvider(config) {
    const breaker = this.#ensureBreaker(config.id);
    const url = `${config.baseUrl}${HEALTH_ENDPOINT}`;

    let response = null;
    let error = undefined;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (response) {
      if (response.ok) {
        this.#updateStatus(config.id, 'healthy', undefined);
        breaker.recordSuccess();
      } else {
        error = `HTTP ${response.status}`;
        this.#updateStatus(config.id, 'unhealthy', error);
        breaker.recordFailure();
      }
    } else {
      this.#updateStatus(config.id, 'unhealthy', error);
      breaker.recordFailure();
    }
  }

  /**
   * @param {string} id
   * @param {string} state
   * @param {string|undefined} error
   */
  #updateStatus(id, state, error) {
    this.#statuses.set(id, { state, lastChecked: Date.now(), error });
  }
}

module.exports = { HealthMonitor };
