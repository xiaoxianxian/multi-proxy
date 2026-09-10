import { RouteEngine, type RouteConfig } from '../../src/routing/routeEngine.js';
import { CircuitBreaker, type CircuitBreakerConfig } from '../../src/monitoring/circuitBreaker.js';
import { RateLimiter } from '../../src/monitoring/rateLimiter.js';

// ===== RouteEngine Tests =====

describe('RouteEngine', () => {
  let engine: RouteEngine;

  beforeEach(() => {
    engine = new RouteEngine();
  });

  const priorityRoute: RouteConfig = {
    id: 'p1',
    defaultModel: 'gpt-4',
    fallbackChain: ['gpt-4', 'gpt-3.5', 'claude-3'],
    rules: [],
    maxRetries: 2,
    strategy: 'priority',
  };

  const rrRoute: RouteConfig = {
    id: 'rr1',
    defaultModel: 'model-a',
    fallbackChain: ['model-a', 'model-b', 'model-c'],
    rules: [],
    maxRetries: 1,
    strategy: 'round-robin',
  };

  it('priority strategy returns first in fallback chain', () => {
    expect(engine.getNextRoute('gpt-4', priorityRoute)).toBe('gpt-4');
  });

  it('priority strategy falls back to defaultModel when chain is empty', () => {
    const emptyChain: RouteConfig = {
      ...priorityRoute,
      fallbackChain: [],
    };
    expect(engine.getNextRoute('gpt-4', emptyChain)).toBe('gpt-4');
  });

  it('round-robin cycles through fallback chain', () => {
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(engine.getNextRoute('any', rrRoute));
    }
    expect(results).toEqual(['model-b', 'model-c', 'model-a', 'model-b', 'model-c', 'model-a']);
  });

  it('round-robin handles single-element chain', () => {
    const single: RouteConfig = { ...rrRoute, fallbackChain: ['only'] };
    expect(engine.getNextRoute('x', single)).toBe('only');
    expect(engine.getNextRoute('x', single)).toBe('only');
  });

  it('round-robin uses defaultModel when chain is empty', () => {
    const noChain: RouteConfig = { ...rrRoute, fallbackChain: [] };
    const result = engine.getNextRoute('x', noChain);
    expect(result).toBe('model-a');
  });

  it('buildFallbackChain returns the chain', () => {
    const chain = engine.buildFallbackChain(priorityRoute);
    expect(chain).toEqual(['gpt-4', 'gpt-3.5', 'claude-3']);
  });

  it('setRoutes stores configs without throwing', () => {
    expect(() => engine.setRoutes([priorityRoute, rrRoute])).not.toThrow();
  });
});

// ===== CircuitBreaker Tests =====

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  const config: CircuitBreakerConfig = {
    failureThreshold: 3,
    resetTimeout: 100,
    halfOpenMaxCalls: 2,
  };

  beforeEach(() => {
    cb = new CircuitBreaker(config);
  });

  it('starts in CLOSED state', () => {
    expect(cb.currentState).toBe('CLOSED');
  });

  it('allows requests when CLOSED', () => {
    expect(cb.allowRequest()).toBe(true);
  });

  it('transitions to OPEN after threshold failures', () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('CLOSED');
    cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');
    expect(cb.allowRequest()).toBe(false);
  });

  it('resets failure count on success', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.currentState).toBe('CLOSED');
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('CLOSED');
  });

  it('transitions to HALF_OPEN after reset timeout', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');

    // Mock Date.now to simulate time passing
    const origNow = Date.now;
    Date.now = () => origNow() + 200;
    expect(cb.currentState).toBe('HALF_OPEN');
    expect(cb.allowRequest()).toBe(true);
    Date.now = origNow;
  });

  it('recovers to CLOSED on success in HALF_OPEN', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');

    const origNow = Date.now;
    Date.now = () => origNow() + 200;
    expect(cb.currentState).toBe('HALF_OPEN');
    cb.recordSuccess();
    expect(cb.currentState).toBe('CLOSED');
    expect(cb.allowRequest()).toBe(true);
    Date.now = origNow;
  });

  it('goes back to OPEN on failure in HALF_OPEN', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');

    const origNow = Date.now;
    Date.now = () => origNow() + 200;
    expect(cb.currentState).toBe('HALF_OPEN');
    cb.recordFailure();
    expect(cb.currentState).toBe('OPEN');
    Date.now = origNow;
  });

  it('uses custom threshold of 1', () => {
    const customCb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeout: 100,
      halfOpenMaxCalls: 2,
    });
    customCb.recordFailure();
    expect(customCb.currentState).toBe('OPEN');
  });
});

// ===== RateLimiter Tests =====

describe('RateLimiter', () => {
  it('allows requests within capacity', () => {
    const limiter = new RateLimiter({ capacity: 5, refillRate: 0 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.allowRequest('user-1')).toBe(true);
    }
    expect(limiter.allowRequest('user-1')).toBe(false);
  });

  it('has separate buckets per key', () => {
    const limiter = new RateLimiter({ capacity: 2, refillRate: 0 });
    expect(limiter.allowRequest('user-a')).toBe(true);
    expect(limiter.allowRequest('user-a')).toBe(true);
    expect(limiter.allowRequest('user-a')).toBe(false);
    expect(limiter.allowRequest('user-b')).toBe(true);
    expect(limiter.allowRequest('user-b')).toBe(true);
    expect(limiter.allowRequest('user-b')).toBe(false);
  });

  it('refills tokens over time', () => {
    const limiter = new RateLimiter({ capacity: 2, refillRate: 10 });
    limiter.allowRequest('user-1');
    limiter.allowRequest('user-1');
    expect(limiter.allowRequest('user-1')).toBe(false);

    const origNow = Date.now;
    Date.now = () => origNow() + 200;
    expect(limiter.allowRequest('user-1')).toBe(true);
    Date.now = origNow;
  });

  it('uses default capacity of 60', () => {
    const limiter = new RateLimiter();
    let allowed = 0;
    for (let i = 0; i < 60; i++) {
      if (limiter.allowRequest('test')) allowed++;
    }
    expect(allowed).toBe(60);
  });

  it('caps tokens at capacity', () => {
    const limiter = new RateLimiter({ capacity: 3, refillRate: 100 });
    limiter.allowRequest('u');
    limiter.allowRequest('u');
    limiter.allowRequest('u');
    expect(limiter.allowRequest('u')).toBe(false);

    const origNow = Date.now;
    Date.now = () => origNow() + 100000;
    expect(limiter.allowRequest('u')).toBe(true);
    expect(limiter.allowRequest('u')).toBe(true);
    expect(limiter.allowRequest('u')).toBe(true);
    expect(limiter.allowRequest('u')).toBe(false);
    Date.now = origNow;
  });
});
