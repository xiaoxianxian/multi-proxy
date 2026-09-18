// Test: codex-proxy integrates l2 circuit-breaker
const { CircuitBreaker } = require('../../l2/circuit-breaker.js');

describe('codex-proxy circuit-breaker integration', () => {
  test('should create breaker and track failures', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 100 });
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.currentState).toBe('CLOSED');
    
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('CLOSED');
    
    breaker.recordFailure();
    expect(breaker.currentState).toBe('OPEN');
    expect(breaker.allowRequest()).toBe(false);
  });

  test('should auto-recover after resetTimeout', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 50 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('OPEN');
    
    await new Promise(r => setTimeout(r, 60));
    expect(breaker.currentState).toBe('HALF_OPEN');
    expect(breaker.allowRequest()).toBe(true);
  });
});
