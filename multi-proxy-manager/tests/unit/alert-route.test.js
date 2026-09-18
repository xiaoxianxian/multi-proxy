'use strict';

// L2 P2 告警生产接线测试 — /api/alert 路由
// 非侵入：门控 off → 403 零副作用；门控开 → 从真实信号源采集 emit。
// 信号源 provider-health + error-patterns 通过 jest setup / beforeEach 重定向到 tmp。
// 第 3 路 cost：读 cost-track.getAll() × 预算 → alert.js cost-budget-exceeded 规则。
const request = require('supertest');
const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 顶层 require（jest 缓存稳定，跨测试共享同一模块实例）
const alert = require('../../../l2/alert.js');
const CT = require('../../lib/cost-track');

describe('L2 P2 alert route (/api/alert)', () => {
  let app, router;
  let ph, ep;
  let healthFile;

  beforeEach(() => {
    // 隔离 alert.js 模块级 store
    alert.reset();

    // 重定向 provider-health + error-patterns 到 tmp 文件（避免污染真实数据目录）
    healthFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-alert-')), 'ph.json');
    ph = require('../../lib/provider-health');
    ph.setHealthFile(healthFile);
    ph.resetProviderHealth();

    ep = require('../../lib/error-patterns');
    // jest.setup.js 已全局重定向 ep 到 tmp，这里确保干净
    ep.resetErrorPatterns();

    // cost-track 隔离
    CT.reset();

    // 构建 app
    app = require('express')();
    app.use(express.json());
    router = require('../../routes/alert');
    if (router._resetForTest) router._resetForTest();
    app.use('/api/alert', router);
  });

  afterEach(() => {
    delete process.env.PROXY_HEALTH_ALERT;
    delete process.env.PROXY_COST_TRACK;
    delete process.env.PROXY_COST_BUDGET;
    delete process.env.PROXY_COST_BUDGET_OPENAI;
    delete process.env.PROXY_COST_SCHEDULE;
    alert.reset();
    CT.reset();
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

  // ---- 第 3 路：cost 信号源（A 路 token×单价累计 × 预算 → cost-budget-exceeded）----
  // seed：让 cost-track 累计出 cost（门控开 + setPricing + accumulate）
  //  cost = prompt/1M × input + completion/1M × output；要 cost=C，set input=C×1M，prompt=1 → cost=C
  function seedCost(proxyName, cost) {
    process.env.PROXY_COST_TRACK = '1';
    CT.setPricing(proxyName, { input: cost * 1e6, output: 0 });
    CT.accumulate(proxyName, { prompt_tokens: 1 });
    expect(CT.getCost(proxyName).cost).toBe(cost);
  }

  test('collect：cost 超预算 → 产生 cost-budget-exceeded 事件（providerId=openai, cost=20 budget=10）', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    seedCost('openai', 20);          // cost 20
    process.env.PROXY_COST_BUDGET = '10';   // 预算 10 < 20 → 超支
    const res = await request(app).post('/api/alert/collect');
    expect(res.status).toBe(200);
    const event = res.body.alerts.find(a => a.rule === 'cost-budget-exceeded');
    expect(event).toBeTruthy();
    expect(event.providerId).toBe('openai');
    expect(event.signal.source).toBe('cost');
    expect(event.signal.cost).toBeCloseTo(20, 6);
    expect(event.signal.budget).toBe(10);
  });

  test('collect：cost 在预算内 → 不触发 cost 事件（YAGNI 正确）', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    seedCost('openai', 5);
    process.env.PROXY_COST_BUDGET = '10';    // 5 < 10 → 不超支
    const res = await request(app).post('/api/alert/collect');
    expect(res.status).toBe(200);
    expect(res.body.alerts.find(a => a.rule === 'cost-budget-exceeded')).toBeFalsy();
    expect(res.body.collected).toBe(0);
  });

  test('collect：未设预算 → 有 cost 但不触发（零误报，YAGNI 正确）', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    seedCost('openai', 100);      // 有花费但无 PROXY_COST_BUDGET
    const res = await request(app).post('/api/alert/collect');
    expect(res.status).toBe(200);
    expect(res.body.collected).toBe(0);
    expect(res.body.alerts.find(a => a.rule === 'cost-budget-exceeded')).toBeFalsy();
  });

  test('collect：per-proxy 预算覆盖全局（PROXY_COST_BUDGET_OPENAI > 全局 → openai 不触发；deepseek 用全局 → 触发）', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    seedCost('openai', 30);
    seedCost('deepseek', 30);
    process.env.PROXY_COST_BUDGET = '20';               // 全局 20
    process.env.PROXY_COST_BUDGET_OPENAI = '50';        // openai 覆盖 50 > 30 → 不触发
    const res = await request(app).post('/api/alert/collect');
    const byProvider = {};
    for (const a of res.body.alerts) { if (a.rule === 'cost-budget-exceeded') byProvider[a.providerId] = a; }
    expect(byProvider.deepseek).toBeTruthy();   // 30 > 20 全局 → 触发
    expect(byProvider.openai).toBeFalsy();       // 30 < 50 per-proxy → 不触发
  });

  test('collect：cost 边界 cost === budget 恰好触发（>= 语义）', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    seedCost('openai', 10);
    process.env.PROXY_COST_BUDGET = '10';    // 10 === 10 → 触发
    const res = await request(app).post('/api/alert/collect');
    expect(res.body.alerts.find(a => a.rule === 'cost-budget-exceeded')).toBeTruthy();
  });

  test('resolveBudget：per-proxy 优先于全局；非法/缺省返回 undefined', () => {
    delete process.env.PROXY_COST_BUDGET_OPENAI;
    process.env.PROXY_COST_BUDGET = '30';
    expect(router.resolveBudget('openai')).toBe(30);      // 无 per-proxy → 走全局
    process.env.PROXY_COST_BUDGET_OPENAI = '88';
    expect(router.resolveBudget('openai')).toBe(88);      // per-proxy 覆盖
    delete process.env.PROXY_COST_BUDGET;
    delete process.env.PROXY_COST_BUDGET_OPENAI;
    expect(router.resolveBudget('openai')).toBeUndefined(); // 全无 → undefined
  });

  test('scheduler：门控默认关 → startCostScheduler 返回 null（零副作用，不建 timer）', () => {
    delete process.env.PROXY_COST_SCHEDULE;
    expect(router.isCostScheduleOpen()).toBe(false);
    expect(router.startCostScheduler()).toBeNull();
  });

  test('scheduler：门控开 → 建 timer；stop 后清理；幂等不重复建', () => {
    process.env.PROXY_COST_SCHEDULE = '1';
    expect(router.isCostScheduleOpen()).toBe(true);
    const h1 = router.startCostScheduler({ intervalMs: 60000 });
    expect(h1).toBeTruthy();
    expect(typeof h1.handle).toBe('object');
    // 幂等：已启动再次调用返回同一 handle
    expect(router.startCostScheduler({ intervalMs: 30000 })).toBe(h1);
    h1.stop();
    // stop 后能再起一个
    const h2 = router.startCostScheduler({ intervalMs: 60000 });
    expect(h2).toBeTruthy();
    expect(h2).not.toBe(h1);
    h2.stop();
  });

  test('scheduler：tick 真的跑 collect → openai 超预算落到 events', async () => {
    process.env.PROXY_HEALTH_ALERT = '1';
    process.env.PROXY_COST_SCHEDULE = '1';
    seedCost('openai', 20);
    process.env.PROXY_COST_BUDGET = '10';
    const h = router.startCostScheduler({ intervalMs: 10 });
    await new Promise(r => setTimeout(r, 40));   // 等 ≥3 个 tick
    h.stop();
    const events = alert.list({ rule: 'cost-budget-exceeded' });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].providerId).toBe('openai');
  });
});
