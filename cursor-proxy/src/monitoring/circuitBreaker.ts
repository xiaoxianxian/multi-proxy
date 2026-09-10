// 熔断器状态
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number; // ms
  halfOpenMaxCalls: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenCalls = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  get currentState(): CircuitState {
    // 检查是否需要从 OPEN 转为 HALF_OPEN
    if (this.state === 'OPEN' && Date.now() - this.lastFailureTime >= this.config.resetTimeout) {
      this.state = 'HALF_OPEN';
      this.halfOpenCalls = 0;
    }
    return this.state;
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.failureCount = 0;
    } else {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  allowRequest(): boolean {
    return this.currentState !== 'OPEN';
  }
}
