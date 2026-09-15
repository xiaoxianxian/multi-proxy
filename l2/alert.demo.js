'use strict';
// P2 告警服务内核 · 真跑验证 demo（node l2/alert.demo.js）
// 全内存、非侵入、零 manager 依赖。信号由调用方注入（mock provider-health / error-patterns 产出）。
const A = require('./alert.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}     -- ${e.message}`); } };
const NW = { source: 'provider-health', correlation: { verdict: 'network-wide', sources: ['codex', 'hermes', 'cursor'], count: 3 }, providerId: 'openai', status: 'unhealthy', consecutiveFailures: 4 };

// 1. 规则 1：跨 proxy 全网故障 → critical
check('规则1 provider-network-wide → critical', () => {
    const r = A.evaluate(NW);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].rule, 'provider-network-wide');
    assert.strictEqual(r[0].severity, 'critical');
 });
// 2. 规则 2：单点 unhealthy → warning（非全网）
check('规则2 provider-unhealthy → warning', () => {
    const r = A.evaluate({ source: 'provider-health', correlation: { verdict: 'single-proxy', sources: ['codex'], count: 1 }, providerId: 'openai', status: 'unhealthy', consecutiveFailures: 3 });
    assert.strictEqual(r[0].rule, 'provider-unhealthy');
    assert.strictEqual(r[0].severity, 'warning');
 });
// 3. 规则 3：错误高频 → warning；≥4× 阈值 → critical
check('规则3 error-pattern-frequent（5→warning / 20→critical）', () => {
    assert.strictEqual(A.evaluate({ source: 'error-patterns', patternId: 'etimedout', frequency: 5 })[0].severity, 'warning');
    assert.strictEqual(A.evaluate({ source: 'error-patterns', patternId: 'etimedout', frequency: 20 })[0].severity, 'critical');
 });
// 4. 规则 4：成本超预算 → warning
check('规则4 cost-budget-exceeded → warning', () => {
    assert.strictEqual(A.evaluate({ source: 'cost', providerId: 'pool', cost: 120, budget: 100 })[0].rule, 'cost-budget-exceeded');
 });
// 5. 不触发：健康 / 低频 / 预算内
check('不触发：健康+低频+预算内', () => {
    assert.strictEqual(A.evaluate({ source: 'provider-health', correlation: { verdict: 'single-proxy', sources: ['codex'] }, providerId: 'p', status: 'healthy' }).length, 0);
    assert.strictEqual(A.evaluate({ source: 'error-patterns', patternId: 'x', frequency: 1 }).length, 0);
    assert.strictEqual(A.evaluate({ source: 'cost', providerId: 'p', cost: 50, budget: 100 }).length, 0);
 });
// 6. 门控默认 observe：emit 照常产出事件但 sink 不真发
check('门控默认 observe（PROXY_HEALTH_ALERT 未设）', () => {
    assert.strictEqual(A.alertEnabled(), false);
    assert.strictEqual(A.observeOnly(), true);
 });
// 7. 去重 cooldown：同 (rule+key) 窗口内第二次 deduped=true 且不再 dispatch
check('去重 cooldown（同 rule+key 窗口内只算一次）', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    const e1 = svc.emit(NW, { persist: false, now: 1000 });
    const e2 = svc.emit(NW, { persist: false, now: 1500 });
    assert.strictEqual(e1[0].deduped, false, '首次非 deduped');
    assert.strictEqual(e2[0].deduped, true, 'cooldown 内 deduped');
    assert.strictEqual(svc.count(), 2, '两条都登记进 events[]');
 });
// 8. cooldown 过后重新触发
check('cooldown 过后重新触发（deduped=false）', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    svc.emit(NW, { persist: false, now: 1000 });
    const again = svc.emit(NW, { persist: false, now: 1000 + A.DEFAULT_CONFIG.cooldownMs + 1 });
    assert.strictEqual(again[0].deduped, false, '超过 cooldown 重新触发');
 });
// 9. sink 热插拔 + 分派（门控开时真发）
check('registerSink 热插拔 + dispatch（门控开真发）', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    const captured = [];
    A.registerSink('test', (alert) => { captured.push(alert.rule); return { delivered: true }; });
    process.env.PROXY_HEALTH_ALERT = '1';
    try {
        svc.emit(NW, { persist: false, now: 2000 });
    } finally {
        delete process.env.PROXY_HEALTH_ALERT;
    }
    assert.ok(captured.includes('provider-network-wide'), '门控开 → sink 收到全网故障事件');
    assert.ok(A.getActiveSinks().includes('test'), 'test sink 已挂载');
    A.unregisterSink('test');
    assert.ok(!A.getActiveSinks().includes('test'), 'unregister 后移除');
 });
// 10. 非侵入：emit 不写 providers.json / 不翻 enabled（本内核零 fs 副作用，persist 默认 observe 关）
check('非侵入：observe 模式 emit 不落盘 / 不触 fs', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    // 设一个临时 events file，emit 在 observe 下不落盘
    const { tmpdir } = require('os');
    const path = require('path');
    const fs = require('fs');
    const f = path.join(tmpdir(), `alert-demo-${Date.now()}.jsonl`);
    A.setEventsFile(f);
    try {
        svc.emit(NW, { persist: true, now: 3000 });
        // observe 模式：persistAlerts 被 !observeOnly() 门控跳过 → 文件不存在
        assert.strictEqual(fs.existsSync(f), false, 'observe 模式即使 persist:true 也不落盘（非侵入）');
    } finally {
        A.setEventsFile(A.ALERT_EVENTS_FILE);
        try { fs.unlinkSync(f); } catch {}
    }
 });
// 11. list/count/reset 查询
check('list/count/reset 查询', () => {
    const svc = A.createAlertService({ store: { history: [] } });
    svc.emit(NW, { persist: false, now: 1 });
    svc.emit({ source: 'cost', providerId: 'p', cost: 10, budget: 1 }, { persist: false, now: 2 });
    assert.strictEqual(svc.count(), 2);
    assert.strictEqual(svc.list({ rule: 'cost-budget-exceeded' }).length, 1);
    assert.strictEqual(svc.list({ severity: 'critical' }).length, 1);
    svc.reset();
    assert.strictEqual(svc.count(), 0);
 });
// 12. 配置注入（阈值 + cooldown 可调）
check('setConfig 调 errorFrequencyThreshold + cooldown', () => {
    A.setConfig({ errorFrequencyThreshold: 10, cooldownMs: 1000 });
    try {
        // 阈值 10：freq 6 不触发，freq 12 触发
        assert.strictEqual(A.evaluate({ source: 'error-patterns', patternId: 'x', frequency: 6 }).length, 0);
        assert.strictEqual(A.evaluate({ source: 'error-patterns', patternId: 'x', frequency: 12 })[0].rule, 'error-pattern-frequent');
    } finally {
        A.setConfig(A.DEFAULT_CONFIG);
    }
 });
// 13. registerSink 参数校验
check('registerSink 参数校验（必须 name+fn）', () => {
    assert.throws(() => A.registerSink('x', null), /required/);
    assert.throws(() => A.registerSink('', {}), /required/);
 });

console.log(`\n[Alert-Service demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
