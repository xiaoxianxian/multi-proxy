// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * P7-2 wiring gate — 预算预检接进三条转发路由后的行为锁。
 * 跑真 app（supertest + HOME 重定向到 tmp + fetch mock），覆盖四类：
 *   1. 门控关        → 零行为变更，请求照常打上游（= 上线前）
 *   2. exact 放行    → 问到 manager /api/budget，剩额足 → 放行打上游
 *   3. exact 拦截    → 估的最坏情况超剩额 → 429 BUDGET_EXCEEDED，且**没碰上游**
 *   4. open          → manager 不可达 + 无快照 → fail-open 放行（只警告一次）
 *   5. degraded      → manager 挂 + 新鲜本地快照 → 对快照判 + 本地累加，耗尽即拦
 *
 * fetch mock 按 URL 分流：/api/budget → 预算响应（由 budgetResponse 控制）；其余 → 上游响应。
 * reportUsage 上报 manager 的 /api/cost/report 也会过 mock，断言用 upstreamCalls() 过滤掉 localhost。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-p7-wire-'));
process.env.HOME = tmp;
delete process.env.PROXY_AUTH_TOKEN;
const SNAP_FILE = path.join(tmp, 'budget-snapshot.json');
process.env.PROXY_BUDGET_SNAPSHOT_FILE = SNAP_FILE;

const MODEL = 'deepseek-v4-flash';
const PRICES = { [MODEL]: { input: 1, output: 2 } };
const currentMonth = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit' }).format(new Date());

let fetchCalls = [];
// 由各测试控制 manager /api/budget 的返回：{snap} | {ok:false} | {throw:true} | null(不调用)
let budgetResponse = null;
const mockFetch = jest.fn(async (url, opts) => {
  const u = String(url);
  fetchCalls.push({ url: u, opts });
  if (u.includes('/api/budget')) {
    if (budgetResponse && budgetResponse.throw) throw new Error('ECONNREFUSED');
    if (budgetResponse && budgetResponse.ok === false) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => budgetResponse.snap };
  }
  // 上游转发响应
  return {
    ok: true, status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
    json: async () => ({ id: 'chatcmpl-mock', model: MODEL, choices: [] }),
    body: null,
  };
});
const upstreamCalls = () => fetchCalls.filter(c => !c.url.includes('127.0.0.1') && !c.url.includes('localhost'));
const budgetCalls = () => fetchCalls.filter(c => c.url.includes('/api/budget'));

const snap = (over = {}) => ({
  enabled: true, period: currentMonth(), remaining: 100, configHash: 'h1', prices: PRICES,
  caps: { total: 100, perModel: {}, perAgent: {} }, ...over,
});

describe('P7-2 wiring gate OFF（PROXY_BUDGET_GUARD 不设）', () => {
  let app;
  beforeAll(() => {
    jest.isolateModules(() => {
      delete process.env.PROXY_BUDGET_GUARD;
      global.fetch = mockFetch;
      app = require('../proxy.js').app;
    });
  });
  test('零行为变更：请求照常打上游', async () => {
    fetchCalls = [];
    const res = await request(app).post('/v1/chat/completions').send({ model: MODEL, max_tokens: 1000 });
    expect(res.status).toBe(200);
    expect(upstreamCalls().length).toBe(1);
    expect(budgetCalls().length).toBe(0); // 门控关时根本不打 /api/budget
  });
});

describe('P7-2 wiring gate ON（PROXY_BUDGET_GUARD=1）', () => {
  let app, proxy;
  beforeAll(() => {
    jest.isolateModules(() => {
      process.env.PROXY_BUDGET_GUARD = '1';
      global.fetch = mockFetch;
      proxy = require('../proxy.js');
      app = proxy.app;
    });
  });
  beforeEach(() => {
    fetchCalls = [];
    budgetResponse = null;
    if (fs.existsSync(SNAP_FILE)) fs.unlinkSync(SNAP_FILE);
    proxy.budgetCheck.resetStateForTest();
  });

  test('exact 放行：问到 manager，剩额足 → 打上游', async () => {
    budgetResponse = { snap: snap({ remaining: 100 }) };
    const res = await request(app).post('/v1/chat/completions').send({ model: MODEL, max_tokens: 1000 });
    expect(res.status).toBe(200);
    expect(budgetCalls().length).toBe(1);
    expect(upstreamCalls().length).toBe(1);
  });

  test('exact 拦截：最坏估计超剩额 → 429 BUDGET_EXCEEDED，且没碰上游', async () => {
    // estimate = 1000/1e6*2 = 0.002；remaining 0.001 < 0.002 → 拦
    budgetResponse = { snap: snap({ remaining: 0.001 }) };
    const res = await request(app).post('/v1/chat/completions').send({ model: MODEL, max_tokens: 1000 });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('BUDGET_EXCEEDED');
    expect(upstreamCalls().length).toBe(0);
  });

  test('open：manager 不可达 + 无快照 → fail-open 放行', async () => {
    budgetResponse = { throw: true };
    const res = await request(app).post('/v1/chat/completions').send({ model: MODEL, max_tokens: 1000 });
    expect(res.status).toBe(200); // 放行
    expect(upstreamCalls().length).toBe(1);
  });

  test('degraded：manager 挂 + 新鲜本地快照 → 累加耗尽即拦', async () => {
    // 先写一份新鲜快照（remaining 0.003，每笔估 0.002），seed 进内存
    const seeded = { ...snap({ remaining: 0.003 }), at: Date.now(), mode: 'exact', source: 'manager', accLocal: 0 };
    fs.writeFileSync(SNAP_FILE, JSON.stringify(seeded));
    proxy.seedBudgetSnapshot();
    budgetResponse = { throw: true }; // 之后 manager 一直挂
    // 第 1 发：降级，remaining 0.003 - 0 = 0.003 >= 0.002 放行，accLocal=0.002
    const r1 = await request(app).post('/v1/chat/completions').send({ model: MODEL, max_tokens: 1000 });
    expect(r1.status).toBe(200);
    // 第 2 发：降级，remaining 0.003 - 0.002 = 0.001 < 0.002 → 拦
    const r2 = await request(app).post('/v1/chat/completions').send({ model: MODEL, max_tokens: 1000 });
    expect(r2.status).toBe(429);
    expect(r2.body.code).toBe('BUDGET_EXCEEDED');
  });
});
