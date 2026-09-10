import { CircuitBreaker } from './circuitBreaker.js';
import type { ProviderConfig } from '../providers/base.js';

const DEFAULT_TIMEOUT_MS = 5000;
const HEALTH_ENDPOINT = '/models';

export class HealthMonitor {
  private statuses = new Map<string, { state: string; lastChecked: number; error?: string }>();
  private breakers = new Map<string, CircuitBreaker>();
  private readonly interval = 30000;
  private timer: NodeJS.Timeout | null = null;

  start(configsRef: { current: ProviderConfig[] }): void {
    this.runCheck(configsRef);
    this.timer = setInterval(() => this.runCheck(configsRef), this.interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(providerId: string): { state: string; lastChecked: number; error?: string } | undefined {
    return this.statuses.get(providerId);
  }

  getAllStatuses(): Record<string, { state: string; lastChecked: number; error?: string }> {
    const result: Record<string, { state: string; lastChecked: number; error?: string }> = {};
    for (const [id, status] of this.statuses) {
      result[id] = { state: status.state, lastChecked: status.lastChecked, error: status.error };
    }
    return result;
  }

  private async runCheck(configsRef: { current: ProviderConfig[] }): Promise<void> {
    const configs = configsRef.current.filter((c) => c.enabled);
    await Promise.all(configs.map((config) => this.checkProvider(config)));
  }

  private async checkProvider(config: ProviderConfig): Promise<void> {
    const breaker = this.ensureBreaker(config.id);
    const url = `${config.baseUrl}${HEALTH_ENDPOINT}`;

    let response: Response | null = null;
    let error: string | undefined;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      error = msg;
    }

    if (response) {
      if (response.ok) {
        // 2xx but slow (timeout threshold hit) is degraded;
        // standard 2xx with normal latency is healthy.
        // Since AbortSignal.timeout throws on expiry (caught above),
        // a response means it finished within timeout — treat as healthy.
        this.updateStatus(config.id, 'healthy', undefined);
        breaker.recordSuccess();
      } else {
        error = `HTTP ${response.status}`;
        this.updateStatus(config.id, 'unhealthy', error);
        breaker.recordFailure();
      }
    } else {
      this.updateStatus(config.id, 'unhealthy', error);
      breaker.recordFailure();
    }
  }

  private ensureBreaker(id: string): CircuitBreaker {
    if (!this.breakers.has(id)) {
      this.breakers.set(id, new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 30000,
        halfOpenMaxCalls: 1,
      }));
    }
    return this.breakers.get(id)!;
  }

  private updateStatus(id: string, state: string, error: string | undefined): void {
    this.statuses.set(id, { state, lastChecked: Date.now(), error });
  }
}
