// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 路由 e2e 测试 — POST /api/cost/report → GET /api/cost/watchtower
//
// 为什么值得单独立一个 e2e（2026-10-16）：
//   Watchtower 的三个数（实际花费 / 已省金额 / 逐 agent 明细）要经过
//   「代理上报 → usage-probe 归一 → cost-track 落账 → watchtower 纯函数」四层。
//   任何一层把 model / requestModel 合成一个值，「已省金额」就恒为 0 或 null ——
//   而这种退化**在单测里看不出来**（单测直接喂 entries，字段本来就是对的）。
//   实测踩过：generic-openai-proxy 的 reportUsage 把 currentModel 同时塞进两个字段，
//   真实账本里 model === requestModel 恒成立，反事实对比被结构性抵消。
//
// 全部走 tmp：jest.setup.js 已把 PROXY_COST_LEDGER 指到临时文件，价表也写 tmp，
// 不碰真实 ~/.multi-proxy-manager/。
const request = require('supertest');
const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CT = require('../../lib/cost-track');

// 宿主要的贵模型 / 实际跑的便宜模型 —— 两个都必须进价表，否则「已省金额」算不出。
const PRICING_FILE = [
  {
    id: 'p-watchtower',
    models: [
      { id: 'cheap-flash', pricing: { input: 1, output: 2, cacheHit: 0.5 } },
      { id: 'pricey-haiku', pricing: { input: 10, output: 30, cacheHit: 5 } }
    ]
  }
];

describe('cost route e2e (/api/cost/report → /api/cost/watchtower)', () => {
  let app;
  let pricingFile;

  const AGENT_TOKEN = 'test-agent-token-watchtower';
  const authHdr = { 'x-agent-token': AGENT_TOKEN };

  // 100 万 prompt tokens：宿主要 pricey-haiku（¥10/M），实际跑 cheap-flash（¥1/M）
  const RAW = JSON.stringify({ usage: { prompt_tokens: 1000000, completion_tokens: 0 } });

  beforeAll(() => {
    pricingFile = path.join(os.tmpdir(), `watchtower-pricing-${process.pid}.json`);
    fs.writeFileSync(pricingFile, JSON.stringify(PRICING_FILE));
    CT.loadPricingFromProviders([pricingFile]);
  });

  afterAll(() => {
    try { fs.unlinkSync(pricingFile); } catch { /* 临时文件，删不掉无所谓 */ }
  });

  beforeEach(() => {
    CT.reset();
    // 账本文件由 jest.setup.js 指到 tmp；清掉上一轮写入的行，保证每例从零开始。
    try { fs.unlinkSync(CT.ledgerFile()); } catch { /* 不存在 */ }
    // 🔴 必须显式开门控：lib/cost-track.js 的 applyTokens 第一行就是
    //    `if (!enabled()) return`，PROXY_COST_TRACK 不开时上报静默不落账 ——
    //    这正是「底层有能力但线上没数据」的典型形态，测试里要显式避开这个坑。
    process.env.PROXY_COST_TRACK = '1';
    process.env.MANAGER_AGENT_TOKEN = AGENT_TOKEN;
    app = express();
    app.use(express.json());
    app.use('/api/cost', require('../../routes/cost-report'));
  });

  afterEach(() => {
    delete process.env.PROXY_COST_TRACK;
    delete process.env.MANAGER_AGENT_TOKEN;
    CT.reset();
  });

  test('上报带 model + requestModel → 周报算出「已省金额」', async () => {
    const post = await request(app)
      .post('/api/cost/report')
      .set(authHdr)
      .send({ agent: 'dsh', raw: RAW, model: 'cheap-flash', requestModel: 'pricey-haiku' });
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);

    const res = await request(app).get('/api/cost/watchtower?days=7').set(authHdr);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.spend.actualCost).toBeCloseTo(1, 6);        // 1M × ¥1/M
    expect(res.body.spend.requestCount).toBe(1);
    expect(res.body.saved.computable).toBe(true);
    expect(res.body.saved.baselineCost).toBeCloseTo(10, 6);    // 1M × ¥10/M
    expect(res.body.saved.byRouting).toBeCloseTo(9, 6);        // 省下 ¥9
    expect(res.body.byAgent).toHaveLength(1);
    expect(res.body.byAgent[0].agent).toBe('dsh');
    expect(res.body.byAgent[0].topModel).toBe('cheap-flash');
  });

  test('上报缺 requestModel → 已省金额为 null（不是 0）', async () => {
    await request(app)
      .post('/api/cost/report')
      .set(authHdr)
      .send({ agent: 'dsh', raw: RAW, model: 'cheap-flash' });

    const res = await request(app).get('/api/cost/watchtower').set(authHdr);
    expect(res.status).toBe(200);
    expect(res.body.spend.actualCost).toBeCloseTo(1, 6);
    expect(res.body.saved.computable).toBe(false);
    expect(res.body.saved.byRouting).toBeNull();           // 绝不折算成 0
    expect(res.body.saved.reason).toBe('requestModelMissing');
    expect(res.body.unavailable).toContain('saved.byRouting');
  });

  test('反事实选贵了 → 已省金额为负，不截断', async () => {
    await request(app)
      .post('/api/cost/report')
      .set(authHdr)
      .send({ agent: 'dsh', raw: RAW, model: 'pricey-haiku', requestModel: 'cheap-flash' });

    const res = await request(app).get('/api/cost/watchtower').set(authHdr);
    expect(res.body.spend.actualCost).toBeCloseTo(10, 6);
    expect(res.body.saved.computable).toBe(true);
    expect(res.body.saved.byRouting).toBeCloseTo(-9, 6);   // 负 = 多花了 ¥9
  });

  test('无鉴权 → 401（花多少钱是不能裸奔的数据）', async () => {
    const res = await request(app).get('/api/cost/watchtower');
    expect(res.status).toBe(401);
  });

  test('days 非法 → 400', async () => {
    const res = await request(app).get('/api/cost/watchtower?days=abc').set(authHdr);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('账本空 → entryCount 0 且 actualCost 为 null（不冒充「上周没花钱」）', async () => {
    const res = await request(app).get('/api/cost/watchtower').set(authHdr);
    expect(res.status).toBe(200);
    expect(res.body.spend.entryCount).toBe(0);
    expect(res.body.spend.actualCost).toBeNull();
    expect(res.body.byAgent).toHaveLength(0);
    expect(res.body.unavailable).toContain('entries:0');
  });

  // ── 2026-10-16 补：门控可见性 + 账本完整度 ──────────────────────
  // 这两项是「产品化」的直接体现：成本记账默认已开（OOBE 红线 2），仅显式 off 才关；
  // 开了但没流量与显式关在账本上长得不一样（enabled 字段区分），读者看到空周报能分辨原因。

  test('门控显式 off → tracking.enabled=false 且带 hint（空表要解释为什么空）', async () => {
    process.env.PROXY_COST_TRACK = 'off';   // 模拟「显式关闭记账」的态（默认已开，必须显式 off 才关）
    const res = await request(app).get('/api/cost/watchtower').set(authHdr);
    expect(res.status).toBe(200);
    expect(res.body.tracking.enabled).toBe(false);
    expect(typeof res.body.tracking.hint).toBe('string');
    expect(res.body.tracking.hint.length).toBeGreaterThan(0);
    // hint 必须点名门控变量名——不点名，读者不知道怎么开
    expect(res.body.tracking.hint).toContain('PROXY_COST_TRACK');
  });

  test('门控已开但账本空 → tracking.enabled=true，hint 指向流量路径', async () => {
    const res = await request(app).get('/api/cost/watchtower').set(authHdr);
    expect(res.status).toBe(200);
    expect(res.body.tracking.enabled).toBe(true);
    expect(res.body.tracking.hint).toContain('multi-proxy');
  });

  test('dataQuality：unknown 模型被计数，空账本也有默认值（不是 undefined）', async () => {
    // 一条带模型名 + 一条不带 → unknownModelRatio = 0.5
    await request(app)
      .post('/api/cost/report')
      .set(authHdr)
      .send({ agent: 'dsh', raw: RAW, model: 'cheap-flash', requestModel: 'pricey-haiku' });
    await request(app)
      .post('/api/cost/report')
      .set(authHdr)
      .send({ agent: 'dsh', raw: RAW });   // 不传 model → cost-track 填 <unknown>

    const res = await request(app).get('/api/cost/watchtower').set(authHdr);
    expect(res.status).toBe(200);
    expect(res.body.dataQuality).toBeDefined();          // 不能是 undefined（前端会崩）
    expect(res.body.dataQuality.entryCount).toBe(2);
    expect(res.body.dataQuality.unknownModelCount).toBe(1);
    expect(res.body.dataQuality.unknownModelRatio).toBeCloseTo(0.5, 6);
    // 第二条不传 model → 价表查不到 <unknown> → cost=0（不是"免费"，是"没价"），
    // 所以付费条目只有第一条；它的 requestModel 配齐了，对标可算。
    expect(res.body.dataQuality.paidEntryCount).toBe(1);
    expect(res.body.dataQuality.baselineReadyEntryCount).toBe(1);
    expect(res.body.dataQuality.baselineReadyRatio).toBe(1);
    expect(res.body.saved.computable).toBe(true);
    expect(res.body.saved.byRouting).toBeCloseTo(9, 6);
    // 比例超 20% 阈值 → 必须进 caveats（不印就等于没有）
    expect(res.body.caveats.some(c => c.indexOf('缺模型名') !== -1)).toBe(true);
  });

  test('空账本 → dataQuality 各字段有默认值而非 undefined', async () => {
    const res = await request(app).get('/api/cost/watchtower').set(authHdr);
    expect(res.status).toBe(200);
    expect(res.body.dataQuality).toBeDefined();
    expect(res.body.dataQuality.entryCount).toBe(0);
    expect(res.body.dataQuality.unknownModelRatio).toBeNull();
    expect(res.body.dataQuality.baselineReadyRatio).toBeNull();
  });
});
