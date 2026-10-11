// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// P7 路由测试 — /api/budget（只读判级 + 越限采集发告警）
// 全部走 tmp：PROXY_BUDGET_FILE 指到临时预算配置、PROXY_COST_LEDGER 指到临时账本，
// 不碰真实 ~/.multi-proxy-manager/。alert 内核 store 每个用例前 reset。
const request = require('supertest');
const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');

const alert = require('../../../l2/alert.js');
const CT = require('../../lib/cost-track');

describe('P7 budget route (/api/budget)', () => {
  let app;
  let tmpDir;
  let budgetFile;
  let ledgerFile;

  const writeBudget = (obj) => fs.writeFileSync(budgetFile, JSON.stringify(obj));
  const writeLedger = (rows) => fs.writeFileSync(ledgerFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  // 当月账（UTC 时区写死，预算配置也写 UTC，避免测试机时区漂移）
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const row = (over = {}) => ({
    ts: `${y}-${m}-12T09:00:00.000Z`, proxy: 'codex-proxy', agent: 'dsh',
    model: 'deepseek-v4-flash', cost: 1, pricingSource: 'model', ...over,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-route-'));
    budgetFile = path.join(tmpDir, 'budget.json');
    ledgerFile = path.join(tmpDir, 'cost-ledger.jsonl');
    process.env.PROXY_BUDGET_FILE = budgetFile;
    process.env.PROXY_COST_LEDGER = ledgerFile;
    alert.reset();
    CT.reset();
    app = express();
    app.use(express.json());
    app.use('/api/budget', require('../../routes/budget'));
  });

  afterEach(() => {
    delete process.env.PROXY_BUDGET_FILE;
    delete process.env.PROXY_COST_LEDGER;
    delete process.env.PROXY_HEALTH_ALERT;
    alert.reset();
    CT.reset();
  });

  test('没配 budget.json → enabled:false（不拦不报，零行为变更）', async () => {
    const res = await request(app).get('/api/budget');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enabled).toBe(false);
    expect(res.body.reason).toBe('no-budget-config');
  });

  test('hardCap=0 → enabled:false（配了文件但没设上限 = 关）', async () => {
    writeBudget({ period: 'monthly', hardCap: 0 });
    const res = await request(app).get('/api/budget');
    expect(res.body.enabled).toBe(false);
  });

  test('畸形 budget.json → enabled:false + 错误说清哪儿不对（不炸路由）', async () => {
    fs.writeFileSync(budgetFile, '{ not json');
    const res = await request(app).get('/api/budget');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.reason).toMatch(/budget\.json/);
  });

  test('判级快照：当前周期累计 + 按模型/按 agent 拆 + 未定价计数', async () => {
    writeBudget({ period: 'monthly', hardCap: 10, warnRatio: 0.8, timezone: 'UTC' });
    writeLedger([
      row({ cost: 3 }),
      row({ cost: 5, model: 'kimi-k2.6', agent: 'codex' }),
      row({ cost: undefined }),                            // 缺 cost
      row({ cost: 0, pricingSource: 'unknown' }),          // 0 元但没价
      row({ ts: '2020-01-01T00:00:00.000Z', cost: 999 }),  // 远古周期，不计
    ]);
    const res = await request(app).get('/api/budget');
    expect(res.body.enabled).toBe(true);
    expect(res.body.spent).toBe(8);
    expect(res.body.level).toBe('warn');                    // 8/10 = 80% ≥ warnRatio
    expect(res.body.cap).toBe(10);
    expect(res.body.remaining).toBe(2);
    expect(res.body.unpricedCount).toBe(2);
    expect(res.body.perModel).toEqual({ 'deepseek-v4-flash': 3, 'kimi-k2.6': 5 });
    expect(res.body.perAgent).toEqual({ dsh: 3, codex: 5 });
  });

  test('blocked：越上限 → remaining=0 + exceeded 带 scope', async () => {
    writeBudget({ period: 'monthly', hardCap: 5, timezone: 'UTC' });
    writeLedger([row({ cost: 6 })]);
    const res = await request(app).get('/api/budget');
    expect(res.body.level).toBe('blocked');
    expect(res.body.remaining).toBe(0);
    expect(res.body.exceeded).toEqual([{ scope: 'total', spent: 6, cap: 5 }]);
  });

  test('POST /collect：越限 → 走 alert 内核发 cost-budget-exceeded（dedup 后 fired 计数）', async () => {
    writeBudget({ period: 'monthly', hardCap: 5, timezone: 'UTC' });
    writeLedger([row({ cost: 6 })]);

    const res = await request(app).post('/api/budget/collect');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.level).toBe('blocked');
    expect(res.body.fired).toBe(1);
    expect(res.body.alerts[0]).toMatchObject({ rule: 'cost-budget-exceeded', deduped: false });

    // 同一轮再采一次 → cooldown 内 dedup，不重复发（防告警风暴）
    const again = await request(app).post('/api/budget/collect');
    expect(again.body.fired).toBe(0);
    expect(again.body.alerts[0].deduped).toBe(true);
  });

  test('POST /collect：没配预算 → 空 alerts，不误报', async () => {
    const res = await request(app).post('/api/budget/collect');
    expect(res.body).toMatchObject({ ok: true, enabled: false, alerts: [] });
  });

  test('账本不存在 → 按空账本判（不炸）', async () => {
    writeBudget({ period: 'monthly', hardCap: 5, timezone: 'UTC' });
    // 不写 ledgerFile
    const res = await request(app).get('/api/budget');
    expect(res.body.enabled).toBe(true);
    expect(res.body.spent).toBe(0);
    expect(res.body.level).toBe('ok');
  });
});
