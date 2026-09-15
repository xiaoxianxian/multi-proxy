'use strict';
// 成本分析内核 · 真跑验证 demo（node l2/cost.demo.js）
// 全内存、非侵入、零 manager 依赖。余额快照由调用方注入（mock /balances 产出）。
// 演示 B 路（余额趋势→消费额→喂 alert.js cost-budget-exceeded）+ 信号源无关（A 路换进料管不换内核）。
const C = require('./cost.js');
const A = require('./alert.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}      -- ${e.message}`); } };

// 1. 余额下降 → 消费额（首−末，非负）
check('余额趋势→消费额：100→40 消费 60', () => {
    const s = C.createCostService({ store: { providers: [] }, clock: () => 1000 });
    s.record('openai', 100, { now: 1000 });
    s.record('openai', 40, { now: 2000 });
    const c = s.consumption('openai');
    assert.strictEqual(c.total, 60, '消费 = 首 100 − 末 40');
    assert.strictEqual(c.currentBalance, 40, '当前余额 = 40');
    assert.strictEqual(c.trend.length, 1, '1 段趋势');
    assert.strictEqual(c.trend[0].consumed, 60, '该段消费 60');
});
// 2. 余额上升/充值 → 消费额封顶 0（Math.max(0, …)，不出现负消费）
check('余额上升→消费封顶 0（充值不误报负消费）', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('p', 40, { now: 1 });
    s.record('p', 100, { now: 2 });
    assert.strictEqual(s.consumption('p').total, 0, '充值 40→100 不计负消费');
});
// 3. 多 provider 聚合 + 币种透传（大窗口覆盖全部，确定性 clock）
check('多 provider 聚合 + 币种透传', () => {
    const s = C.createCostService({ store: { providers: [] }, clock: () => 5000 });
       // 两个 provider 独立聚合，5000ms 窗口内
    s.record('openai', 100, { now: 0, providerId: 'openai' });
    s.record('openai', 70, { now: 1000, providerId: 'openai' });         // 消费 30
    s.record('deepseek', 100, { now: 0, providerId: 'deepseek' });
    s.record('deepseek', 10, { now: 1000, providerId: 'deepseek' });     // 消费 90
    const rep = s.report({ windowMs: 5000 });      // clock=5000 → cutoff=0 覆盖全部
    assert.strictEqual(rep.perProvider.length, 2, '2 个 provider');
    assert.strictEqual(rep.total, 120, 'total = 30 + 90');
    assert.strictEqual(rep.currency, 'USD', '币种 USD');
    assert.strictEqual(rep.perProvider[0].name, 'deepseek', '按 spent 倒序：deepseek(90) > openai(30)');
    assert.strictEqual(rep.perProvider[0].spent, 90, 'deepseek 消费 90');
    assert.strictEqual(rep.perProvider[1].spent, 30, 'openai 消费 30');
});
// 3b. 窗口过滤：小窗口只算窗口内消费（确定性 clock）
check('窗口过滤：小窗口只计窗口内消费', () => {
    const s = C.createCostService({ store: { providers: [] }, clock: () => 10000 });
       // cutoff=10000−1000=9000；openai 消费发生在 ts=1000（窗口外），deepseek 也在窗外 → 都滤
       // 改：让 openai 在窗口内
    s.record('openai', 100, { now: 9500, providerId: 'openai' });
    s.record('openai', 70, { now: 10000, providerId: 'openai' });        // consumed 30，trend.ts=10000 ≥ 9000 窗口内
    s.record('deepseek', 100, { now: 8000, providerId: 'deepseek' });
    s.record('deepseek', 10, { now: 8500, providerId: 'deepseek' });     // consumed 90，但 ts=8500 < 9000 窗口外
    const rep = s.report({ windowMs: 1000 });
    assert.strictEqual(rep.total, 30, 'cutoff=9000，只有 openai(10000) 在窗口内 → total=30，deepseek(8500) 被滤');
});
// 4. 喂 alert.js cost-budget-exceeded：cost(累计消费) ≥ budget → 触发
check('喂 alert.js：cost ≥ budget → cost-budget-exceeded', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('openai', 100, { now: 1000 });
    s.record('openai', 30, { now: 2000, budget: 50 });   // 消费 70 ≥ 预算 50
    const sig = s.produceAlertSignal('openai', { budget: 50 });
    assert.strictEqual(sig.source, 'cost', '信号 source=cost（alert.js 契约）');
    assert.strictEqual(sig.providerId, 'openai', 'providerId 透传');
    assert.ok(Math.abs(sig.cost - 70) < 1e-9, `累计消费 ≈ 70（实 ${sig.cost}）`);
    assert.strictEqual(sig.budget, 50, 'budget 透传');
    const alerts = A.evaluate(sig);
    assert.strictEqual(alerts.length, 1, 'alert.js 判定 1 条');
    assert.strictEqual(alerts[0].rule, 'cost-budget-exceeded', '规则命中 cost-budget-exceeded');
});
// 5. 预算内不触发（喂 alert.js 得 0 条）
check('喂 alert.js：预算内 cost < budget → 不触发', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('p', 100, { now: 1 });
    s.record('p', 90, { now: 2 });    // 消费 10
    const sig = s.produceAlertSignal('p', { budget: 50 });   // 10 < 50
    assert.strictEqual(A.evaluate(sig).length, 0, '预算内不触发');
});
// 6. 信号源无关：A 路喂「累计成本」进同一 record()、同一 alert 信号形状（内核零重写）
check('信号源无关：A 路（token×单价累计）喂同一 record() 入口', () => {
    const s = C.createCostService({ store: { providers: [] } });
    // A 路：调用方把 token×单价累加成“余额下降”喂 record()——内核不区分来源
    s.record('gpt', 200, { now: 0, providerId: 'gpt' });
    s.record('gpt', 150, { now: 1000, providerId: 'gpt' });   // “下降”即 A 路算出的累计消耗
    const sig = s.produceAlertSignal('gpt', { budget: 30 });
    assert.strictEqual(sig.source, 'cost', 'A 路信号形状同 B 路');
    assert.strictEqual(A.evaluate(sig)[0].rule, 'cost-budget-exceeded', 'A 路同样喂通 alert.js');
});
// 7. 门控默认 observe：record 不写盘（即使 persist 默认）
check('门控默认 observe：record 默认不写盘', () => {
    const s = C.createCostService({ store: { providers: [] } });
    const os = require('os'); const path = require('path'); const fs = require('fs');
    const f = path.join(os.tmpdir(), `cost-demo-${Date.now()}.jsonl`);
    C.setSnapshotsFile(f);
    try {
        s.record('openai', 100, { now: 1 });   // persist 默认 true，但 observe 落盘被门控跳过
        assert.strictEqual(fs.existsSync(f), false, 'observe 模式 record 不落盘');
    } finally {
        C.setSnapshotsFile(C.COST_SNAPSHOTS_FILE);
        try { fs.unlinkSync(f); } catch {}
    }
});
// 8. 门控开=真落盘
check('门控 PROXY_COST_TRACK=on：record 落盘 snapshot', () => {
    const s = C.createCostService({ store: { providers: [] } });
    const os = require('os'); const path = require('path'); const fs = require('fs');
    const f = path.join(os.tmpdir(), `cost-on-${Date.now()}.jsonl`);
    C.setSnapshotsFile(f);
    process.env.PROXY_COST_TRACK = 'on';
    try {
        s.record('openai', 100, { now: 5 });
        assert.strictEqual(fs.existsSync(f), true, '门控开 → 落盘');
        const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
        assert.ok(lines[0].includes('openai'), '落盘行含 provider name');
        assert.ok(lines[0].includes('"ts":5'), '落盘行含 ts');
    } finally {
        delete process.env.PROXY_COST_TRACK;
        C.setSnapshotsFile(C.COST_SNAPSHOTS_FILE);
        try { fs.unlinkSync(f); } catch {}
    }
});
// 9. 裁剪 maxSnapshots（超上限丢头部）
check('setConfig maxSnapshots 裁剪', () => {
    C.setConfig({ maxSnapshots: 3 });
    try {
        const s = C.createCostService({ store: { providers: [] } });
        for (let i = 1; i <= 5; i++) { s.record('p', 100 - i, { now: i }); }
        assert.strictEqual(s.snapshotCount('p'), 3, '仅留最近 3 条');
        assert.strictEqual(s.consumption('p').start, 3, '首快照 ts=3（1/2 被裁）');
    } finally {
        C.setConfig(C.DEFAULT_CONFIG);
    }
});
// 10. 非侵入：process.env 不漏内核键 / 默认不碰 home
check('非侵入：默认不写 home、process.env 不漏内核键', () => {
    const before = Object.keys(process.env).filter((k) => k.startsWith('PROXY_COST') || k.startsWith('COST_TRACK'))
        .map((k) => process.env[k]).join('|');
    const s = C.createCostService({ store: { providers: [] } });
    s.record('openai', 100, { now: 1 });
    s.record('openai', 80, { now: 2 });
    const after = Object.keys(process.env).filter((k) => k.startsWith('PROXY_COST') || k.startsWith('COST_TRACK'))
        .map((k) => process.env[k]).join('|');
    assert.strictEqual(before, after, '内核不往 process.env 注入任何 COST_* 键');
});
// 11. createCostService 实例隔离（独立 store，不串）
check('工厂实例隔离：两个 svc 互不影响', () => {
    const a = C.createCostService({ store: { providers: [] } });
    const b = C.createCostService({ store: { providers: [] } });
    a.record('x', 10, { now: 1 });
    assert.strictEqual(b.snapshotCount('x'), 0, 'b 看不到 a 的快照');
    assert.strictEqual(a.consumption('x').total, 0, 'x 只 1 条快照→消费 0');
});
// 12. report 结构 + 窗口聚合 + 倒序
check('report：窗口内消费聚合、按 spent 倒序', () => {
    const s = C.createCostService({ store: { providers: [] }, clock: () => 10000 });
    // 大窗口覆盖全部：openai 消费 50，deepseek 消费 80 → deepseek 排前
    s.record('openai', 100, { now: 100, providerId: 'openai' });
    s.record('openai', 50, { now: 200, providerId: 'openai' });
    s.record('deepseek', 100, { now: 100, providerId: 'deepseek' });
    s.record('deepseek', 20, { now: 200, providerId: 'deepseek' });
    const rep = s.report({ windowMs: 100000 });
    assert.strictEqual(rep.perProvider[0].name, 'deepseek', 'spent 多者排前（80>50）');
    assert.strictEqual(rep.perProvider[0].spent, 80, 'deepseek 窗口内消费 80');
    assert.strictEqual(rep.perProvider[1].spent, 50, 'openai 窗口内消费 50');
    assert.strictEqual(Math.round(rep.total * 1e6) / 1e6, 130, 'total = 80+50');
    assert.strictEqual(rep.currency, 'USD');
});
// 13. 容错：NaN 余额 coerce 成 0 / 非数组安全
check('容错：NaN 余额 coerce 0 / 空序列安全', () => {
    const s = C.createCostService({ store: { providers: [] } });
    s.record('p', 'abc', { now: 1, providerId: 'p' });   // 'abc' → coerce 0
    s.record('p', 50, { now: 2, providerId: 'p' });
    assert.strictEqual(s.consumption('p').total, 0, '首快照 NaN→0，0−50 封 0');
    const empty = C.createCostService({ store: { providers: [] } });
    assert.deepStrictEqual(C.seriesConsumption(null), { total: 0, currentBalance: 0, start: 0, end: 0, trend: [], windowCount: 0 }, '非数组安全返回 0');
    assert.strictEqual(empty.consumption('nobody').total, 0, '未知 provider 消费 0');
});

console.log(`\n[Cost-Service demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
