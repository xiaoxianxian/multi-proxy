'use strict';

// L2 P2 告警生产接线测试 — /api/alert 路由
// 非侵入：门控 off → 403 零副作用；门控开 → 从真实信号源采集 emit。
// 信号源 provider-health + error-patterns 通过 jest setup / beforeEach 重定向到 tmp。
const request = require('supertest');
const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');

describe('L2 P2 alert route (/api/alert)', () => {
  let app, router;
  let ph, ep, alert;
  let healthFile;

  beforeEach(() => {
    // 隔离 alert.js 模块级 store
    alert = require('../../../l2/alert.js');
    alert.reset();

    // 重定向 provider-health + error-patterns 到 tmp 文件（避免污染真实数据目录）
    healthFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-alert-')), 'ph.json');
    ph = require('../../lib/provider-health');
    ph.setHealthFile(healthFile);
    ph.resetProviderHealth();

    ep = require('../../lib/error-patterns');
    // jest.setup.js 已全局重定向 ep 到 tmp，这里确保干净
    ep.resetErrorPatterns();

    // 构建 app
    app = require('express')();
    app.use(express.json());
    router = require('../../routes/alert');
    if (router._resetForTest) router._resetForTest();
    app.use('/api/alert', router);
  });

  afterEach(() => {
    delete process.env.PROXY_HEALTH_ALERT;
    alert.reset();
  });

  // ---- 门控 ----
  test('门控关(默认)：GET / + POST /collect 均 403', async () => {
    const g = await request(app).get('/api/alert');
    expect(g.status).toBe(403);
    expect(g.body.error).toBe('alert-gate-closed');

    const p = await request(app).post('/api/alert/collect');
    expect(p.status).toBe(403);
  });

  test('门控开：GET / 返回 events 列表 + count=0（无采集时为空）', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    const res = await request(app).get('/api/alert');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(Array.isArray(res.body.events)).toBe(true);
  });

  test('门控开 + config 路由：返回 gateOpen=true + observeOnly=false + sinks', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    const res = await request(app).get('/api/alert/config');
    expect(res.status).toBe(200);
    expect(res.body.gateOpen).toBe(true);
    expect(res.body.observeOnly).toBe(false);
    expect(Array.isArray(res.body.activeSinks)).toBe(true);
  });

  // ---- 采集 provider-health 信号 ----
  test('collect：单点 unhealthy → 产生 provider-unhealthy 事件', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    ph.setHealthConfig({ failureThreshold: 3 });
    ph.recordProbe('test-provider', false, { source: 'codex', persist: false });
    ph.recordProbe('test-provider', false, { source: 'codex', persist: false });
    ph.recordProbe('test-provider', false, { source: 'codex', persist: false });

    const res = await request(app).post('/api/alert/collect');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.collected).toBeGreaterThanOrEqual(1);

    const alertEvent = res.body.alerts.find(a => a.rule === 'provider-unhealthy');
    expect(alertEvent).toBeTruthy();
    expect(alertEvent.providerId).toBe('test-provider');
  });

  test('collect：跨 proxy network-wide → 产生 provider-network-wide critical 事件', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    ph.setHealthConfig({ failureThreshold: 2, crossProxyThreshold: 2 });
    ph.recordProbe('cross-provider', false, { source: 'codex', persist: false });
    ph.recordProbe('cross-provider', false, { source: 'hermes', persist: false });

    const res = await request(app).post('/api/alert/collect');
    expect(res.status).toBe(200);
    const event = res.body.alerts.find(a => a.rule === 'provider-network-wide');
    expect(event).toBeTruthy();
    expect(event.severity).toBe('critical');
  });

  test('collect：error-pattern 高频触发 → 产生 error-pattern-frequent 事件', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    const threshold = alert.DEFAULT_CONFIG.errorFrequencyThreshold; // 默认 5

     // beforeEach 的 resetErrorPatterns 清空了 SEED → 先 loadPatterns 恢复种子
    ep.loadPatterns();

     // 模拟 6 次 ETIMEDOUT 错误（超过阈值 5）—— persist 写 tmp（jest.setup 已重定向 ep）
    for (let i = 0; i < threshold + 1; i++) {
      ep.recordError({ proxy: 'codex-proxy', rawMessage: 'ETIMEDOUT connecting to upstream', persist: true });
      }

    const res = await request(app).post('/api/alert/collect');
    expect(res.status).toBe(200);
    const event = res.body.alerts.find(a => a.rule === 'error-pattern-frequent');
    expect(event).toBeTruthy();
    expect(event.signal.frequency).toBe(threshold + 1);
  });

  test('collect：信号源全空 → 0 条事件，无报错', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    const res = await request(app).post('/api/alert/collect');
    expect(res.status).toBe(200);
    expect(res.body.collected).toBe(0);
    expect(res.body.alerts).toHaveLength(0);
  });

  // ---- 门控开时 collect 触发内核落盘（验证 persist 通路，非侵入由「门控关 403」测试保证）----
  test('gate on：collect 触发内核 persist，落盘到临时 events file', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    const eventsFile = path.join(os.tmpdir(), `alert-route-test-${Date.now()}.jsonl`);
    alert.setEventsFile(eventsFile);
    try {
      alert.reset();
      ph.setHealthConfig({ failureThreshold: 3 });
      ph.recordProbe('test-obs', false, { source: 'codex', persist: false });
      ph.recordProbe('test-obs', false, { source: 'codex', persist: false });
      ph.recordProbe('test-obs', false, { source: 'codex', persist: false });
      const res = await request(app).post('/api/alert/collect');
      expect(res.status).toBe(200);
      expect(res.body.collected).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(eventsFile)).toBe(true);
    } finally {
      alert.setEventsFile(alert.ALERT_EVENTS_FILE);
      try { fs.unlinkSync(eventsFile); } catch (_) {}
      ph.setHealthConfig(ph.DEFAULT_CONFIG);
    }
  });
});
