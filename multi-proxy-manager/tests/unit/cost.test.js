'use strict';
const C = require('../../../l2/cost.js');
const A = require('../../../l2/alert.js');

// 成本分析内核（B 路余额趋势）+ 信号注入喂 alert.js cost-budget-exceeded
describe('cost (P2 成本分析内核 · B 路余额趋势)', () => {
  // 模块级 gate/file/config 是单例跨测试共享，before/afterEach 重置防串扰
  beforeEach(() => { C.setConfig(C.DEFAULT_CONFIG); C.setSnapshotsFile(C.COST_SNAPSHOTS_FILE); C.setClock(() => Date.now()); delete process.env.PROXY_COST_TRACK; });
  afterEach(() => { C.setConfig(C.DEFAULT_CONFIG); C.setSnapshotsFile(C.COST_SNAPSHOTS_FILE); C.setClock(() => Date.now()); delete process.env.PROXY_COST_TRACK; });

  test('余额下降 → 消费额 = 首−末（非负）', () => {
    const s = C.createCostService({ store: { providers: [] }, clock: () => 0 });
    s.record('openai', 100, { now: 1000 });
    s.record('openai', 40, { now: 2000, providerId: 'openai' });
    const c = s.consumption('openai');
    expect(c.total).toBe(60);
    expect(c.currentBalance).toBe(40);
    expect(c.trend).toHaveLength(1);
    expect(c.trend[0].consumed).toBe(60);
    expect(c.windowCount).toBe(1);
  });

  test('余额上升/充值 → 消费封顶 0（Math.max(0,…) 不误报负消费）', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('p', 40, { now: 1, providerId: 'p' });
    s.record('p', 100, { now: 2, providerId: 'p' });
    expect(s.consumption('p').total).toBe(0);
  });

  test('多 provider 聚合 + 窗口过滤（确定性 clock）', () => {
    const s = C.createCostService({ store: { providers: [] }, clock: () => 10000 });
    s.record('openai', 100, { now: 9500, providerId: 'openai' });
    s.record('openai', 70, { now: 10000, providerId: 'openai' });      // 消费 30，ts=10000 窗口内
    s.record('deepseek', 100, { now: 8000, providerId: 'deepseek' });
    s.record('deepseek', 10, { now: 8500, providerId: 'deepseek' });   // 消费 90，ts=8500 < cutoff=9000 窗外
    const rep = s.report({ windowMs: 1000 });
    expect(rep.total).toBe(30);   // 只有 openai 在窗口内
    expect(rep.currency).toBe('USD');
  });

  test("record() 返回 alert.js 契约信号 { source:cost, providerId, cost, budget }", () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('p', 100, { now: 1, providerId: 'p' });
    s.record('p', 30, { now: 2, providerId: 'p', budget: 50 });
    const sig = s.record('p', 20, { now: 3, providerId: 'p', budget: 50 }).signal;
    expect(sig.source).toBe('cost');
    expect(sig.providerId).toBe('p');
    expect(sig.cost).toBe(80);      // 累计 = 100−20
    expect(sig.budget).toBe(50);
  });

  // 关键架构证据：cost.js 产的信号精确喂进 alert.js.evaluate → cost-budget-exceeded
  test('端到端：cost.js 产信号 → alert.js.evaluate → cost-budget-exceeded', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('openai', 100, { now: 1, providerId: 'openai' });
    s.record('openai', 30, { now: 2, providerId: 'openai' });
    for (const sig of [s.produceAlertSignal('openai', { budget: 50 })]) {
        const alerts = A.evaluate(sig);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].rule).toBe('cost-budget-exceeded');
        expect(alerts[0].severity).toBe('warning');
      }
  });

  test('端到端：预算内 cost < budget → alert.js 不触发', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('p', 100, { now: 1, providerId: 'p' });
    s.record('p', 90, { now: 2, providerId: 'p' });
    expect(A.evaluate(s.produceAlertSignal('p', { budget: 50 }))).toHaveLength(0);
  });

  test('边界：cost === budget 恰好触发（>=）', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('p', 100, { now: 1, providerId: 'p' });
    s.record('p', 50, { now: 2, providerId: 'p' });
    expect(A.evaluate(s.produceAlertSignal('p', { budget: 50 }))).toHaveLength(1);
  });

  test('信号源无关：A 路（token×单价累成“余额下降”）喂同一 record() 入口 → 同信号形状', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('gpt', 200, { now: 1, providerId: 'gpt' });
    s.record('gpt', 150, { now: 2, providerId: 'gpt' });   // “下降”即 A 路算出的累计消耗 50
    const alerts = A.evaluate(s.produceAlertSignal('gpt', { budget: 30 }));
    expect(alerts[0].rule).toBe('cost-budget-exceeded');
    expect(alerts[0].signal.source).toBe('cost');
  });

  test('门控默认 observe：record 不落盘（即使 persist 默认 true）', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const s = C.createCostService({ store: { providers: [] } });
    const f = path.join(os.tmpdir(), `cost-observe-${Date.now()}.jsonl`);
    C.setSnapshotsFile(f);
    try {
        s.record('p', 100, { now: 1, providerId: 'p' });
        expect(fs.existsSync(f)).toBe(false);
      } finally {
        C.setSnapshotsFile(C.COST_SNAPSHOTS_FILE);
        try { fs.unlinkSync(f); } catch {}
      }
  });

  test('门控 PROXY_COST_TRACK=on：record 落盘 snapshot JSONL', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const s = C.createCostService({ store: { providers: [] } });
    const f = path.join(os.tmpdir(), `cost-on-${Date.now()}.jsonl`);
    C.setSnapshotsFile(f);
    process.env.PROXY_COST_TRACK = 'on';
    try {
        s.record('openai', 100, { now: 5, providerId: 'openai' });
        expect(fs.existsSync(f)).toBe(true);
        const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toMatchObject({ name: 'openai', providerId: 'openai', ts: 5, balance: 100 });
      } finally {
        delete process.env.PROXY_COST_TRACK;
        C.setSnapshotsFile(C.COST_SNAPSHOTS_FILE);
        try { fs.unlinkSync(f); } catch {}
      }
  });

  test('门控开时 persist:false 仍不落盘（按调用覆盖 win）', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    process.env.PROXY_COST_TRACK = 'on';
    const s = C.createCostService({ store: { providers: [] } });
    const f = path.join(os.tmpdir(), `cost-nopersist-${Date.now()}.jsonl`);
    C.setSnapshotsFile(f);
    try {
        s.record('p', 100, { now: 1, providerId: 'p', persist: false });
        expect(fs.existsSync(f)).toBe(false);
        } finally {
        delete process.env.PROXY_COST_TRACK;
        C.setSnapshotsFile(C.COST_SNAPSHOTS_FILE);
        try { fs.unlinkSync(f); } catch {}
        }
    });

  test('setConfig maxSnapshots 裁剪（丢头部保最近）', () => {
    C.setConfig({ maxSnapshots: 3 });
    const s = C.createCostService({ store: { providers: [] } });
    for (let i = 1; i <= 5; i++) { s.record('p', 100 - i, { now: i, providerId: 'p' }); }
    expect(s.snapshotCount('p')).toBe(3);
    expect(s.consumption('p').start).toBe(3);    // 1/2 被裁，首快照 ts=3
   });

  test('工厂实例隔离：两个 svc 互不影响', () => {
    const a = C.createCostService({ store: { providers: [] } });
    const b = C.createCostService({ store: { providers: [] } });
    a.record('x', 10, { now: 1, providerId: 'x' });
    expect(b.snapshotCount('x')).toBe(0);
    expect(a.consumption('x').total).toBe(0);
  });

  test('report：窗口内消费按 spent 倒序', () => {
    const s = C.createCostService({ store: { providers: [] }, clock: () => 10000 });
    s.record('openai', 100, { now: 100, providerId: 'openai' });
    s.record('openai', 50, { now: 200, providerId: 'openai' });        // 消费 50
    s.record('deepseek', 100, { now: 100, providerId: 'deepseek' });
    s.record('deepseek', 20, { now: 200, providerId: 'deepseek' });    // 消费 80
    const rep = s.report({ windowMs: 100000 });
    expect(rep.perProvider[0].name).toBe('deepseek');
    expect(rep.perProvider[0].spent).toBe(80);
    expect(rep.perProvider[1].spent).toBe(50);
    expect(rep.total).toBe(130);
    expect(rep.currency).toBe('USD');
  });

  test('容错：NaN 余额 coerce 0 / 空序列 / 未知 provider 安全', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('p', 'abc', { now: 1, providerId: 'p' });      // 'abc' → coerce 0
    s.record('p', 50, { now: 2, providerId: 'p' });
    expect(s.consumption('p').total).toBe(0);               // 0 − 50 封 0
    const empty = C.createCostService({ store: { providers: [] } });
    expect(C.seriesConsumption(null).total).toBe(0);
    expect(empty.consumption('nobody').total).toBe(0);
  });

  test('非侵入：内核默认不往 process.env 注入 COST_* 键', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('openai', 100, { now: 1, providerId: 'openai' });
    s.record('openai', 80, { now: 2, providerId: 'openai' });
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('PROXY_COST') || k.startsWith('COST_TRACK'));
    expect(leaked).toEqual([]);
    });
});
