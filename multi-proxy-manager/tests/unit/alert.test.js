'use strict';
const A = require('../../../l2/alert.js');

describe('alert (P2 告警服务内核)', () => {
  const NW = { source: 'provider-health', correlation: { verdict: 'network-wide', sources: ['a', 'b'], count: 2 }, providerId: 'p', status: 'unhealthy', consecutiveFailures: 3 };

  test('rule1: provider-network-wide → critical', () => {
    const r = A.evaluate(NW);
    expect(r).toHaveLength(1);
    expect(r[0].rule).toBe('provider-network-wide');
    expect(r[0].severity).toBe('critical');
   });

  test('rule2: single-proxy unhealthy → warning', () => {
    const r = A.evaluate({ source: 'provider-health', correlation: { verdict: 'single-proxy', sources: ['a'], count: 1 }, providerId: 'p', status: 'unhealthy', consecutiveFailures: 3 });
    expect(r[0].rule).toBe('provider-unhealthy');
    expect(r[0].severity).toBe('warning');
   });

  test('rule3: error frequency 5→warning / 20→critical', () => {
    expect(A.evaluate({ source: 'error-patterns', patternId: 'x', frequency: 5 })[0].severity).toBe('warning');
    expect(A.evaluate({ source: 'error-patterns', patternId: 'x', frequency: 20 })[0].severity).toBe('critical');
   });

  test('rule4: cost over budget → warning', () => {
    expect(A.evaluate({ source: 'cost', providerId: 'p', cost: 120, budget: 100 })[0].rule).toBe('cost-budget-exceeded');
   });

  test('does not fire: healthy / low-freq / under-budget', () => {
    expect(A.evaluate({ source: 'provider-health', correlation: { verdict: 'single-proxy', sources: ['a'] }, providerId: 'p', status: 'healthy' })).toHaveLength(0);
    expect(A.evaluate({ source: 'error-patterns', patternId: 'x', frequency: 1 })).toHaveLength(0);
    expect(A.evaluate({ source: 'cost', providerId: 'p', cost: 50, budget: 100 })).toHaveLength(0);
   });

  test('gate default observe', () => {
    expect(A.alertEnabled()).toBe(false);
    expect(A.observeOnly()).toBe(true);
   });

  test('dedup cooldown per rule+key', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    const e1 = svc.emit(NW, { persist: false, now: 1000 });
    const e2 = svc.emit(NW, { persist: false, now: 1500 });
    expect(e1[0].deduped).toBe(false);
    expect(e2[0].deduped).toBe(true);
    expect(svc.count()).toBe(2);
   });

  test('cooldown expiry re-fires', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    svc.emit(NW, { persist: false, now: 1000 });
    const again = svc.emit(NW, { persist: false, now: 1000 + A.DEFAULT_CONFIG.cooldownMs + 1 });
    expect(again[0].deduped).toBe(false);
   });

  test('registerSink + dispatch when gate open', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    const captured = [];
    A.registerSink('jest-a', (al) => { captured.push(al.rule); return { delivered: true }; });
    process.env.PROXY_HEALTH_ALERT = '1';
    try {
        svc.emit(NW, { persist: false, now: 2000 });
     } finally {
        delete process.env.PROXY_HEALTH_ALERT;
     }
    expect(captured).toContain('provider-network-wide');
    expect(A.getActiveSinks()).toContain('jest-a');
    A.unregisterSink('jest-a');
    expect(A.getActiveSinks()).not.toContain('jest-a');
   });

  test('non-invasive: observe mode emit does not write fs even with persist:true', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    const os = require('os'); const path = require('path'); const fs = require('fs');
    const f = path.join(os.tmpdir(), `alert-jest-${Date.now()}.jsonl`);
    A.setEventsFile(f);
    try {
        svc.emit(NW, { persist: true, now: 3000 });
        expect(fs.existsSync(f)).toBe(false);
     } finally {
        A.setEventsFile(A.ALERT_EVENTS_FILE);
        try { fs.unlinkSync(f); } catch {}
     }
   });

  test('list / count / reset', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    svc.emit(NW, { persist: false, now: 1 });
    expect(svc.count()).toBe(1);
    expect(svc.list({ rule: 'provider-network-wide' })).toHaveLength(1);
    expect(svc.list({ severity: 'critical' })).toHaveLength(1);
    svc.reset();
    expect(svc.count()).toBe(0);
   });

  test('setConfig adjusts threshold + cooldown', () => {
    A.setConfig({ errorFrequencyThreshold: 10, cooldownMs: 1000 });
    try {
        expect(A.evaluate({ source: 'error-patterns', patternId: 'x', frequency: 6 })).toHaveLength(0);
        expect(A.evaluate({ source: 'error-patterns', patternId: 'x', frequency: 12 })[0].rule).toBe('error-pattern-frequent');
     } finally {
        A.setConfig(A.DEFAULT_CONFIG);
     }
   });

  test('registerSink param validation', () => {
    expect(() => A.registerSink('x', null)).toThrow(/required/);
    expect(() => A.registerSink('', {})).toThrow(/required/);
   });
});
