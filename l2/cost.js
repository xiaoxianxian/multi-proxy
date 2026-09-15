'use strict';

// 成本分析内核（P2 健康监控增强 · L2-BLUEPRINT §4.6「成本分析」+ §4.6 告警「成本超预算」）
// 职责：从「账户余额快照」算消费额 + 成本趋势/报告，并产 alert.js 的 cost 信号喂 cost-budget-exceeded 规则。
//
// 为什么先做 B（余额趋势）而非 A（token×单价）：
//   §4.6 把成本分析列「需先定 A vs B」。A=`forward.js` 加 token usage 埋点+单价表——改 18792 热路径、
//   需门控+非侵入兜底、风险大；B=`/balances` 定时快照算余额变化——零热路径、数据现成。本内核做 B：
//   纯增量、零热路径、与 l2/ 其它内核（alert/memory-merge/skill-service）非侵入铁律最一致，立即收口
//   「成本分析」缺口。A 的 token 粒度是后续独立增量（换一根进料管喂同一内核，内核零重写）。
//
// 设计原则（与 l2/ 其它内核同构，铁律一致）：
//   - 自包含：零 manager lib 依赖。余额快照由调用方注入（demo/jest 喂 /balances 产出），
//     cost.js 不 require '../lib/*'、不触 manager 热路径、不读 process.env(除门控开关)。
//   - 信号源无关：内核消费抽象的「按 provider 的余额」+ 可选「单价表」；B 路从 /balances 喂余额，
//     A 路将来喂 token×单价的累计——同一 record() 入口、同一 alert 信号形状，A 是换进料管不换内核。
//   - 非侵入 + 门控：PROXY_COST_TRACK 默认关 = 只采集进内存、绝不落盘（即使 persist 也跳过，
//     门控权在内核不在调用方，镜像 alert.js 的 observe 铁律）；开(=1/true/on)= 可选落盘 cost-snapshots.jsonl。
//   - 信号契约：produceAlertSignal(s, {budget}) === { source:'cost', providerId, cost, budget }
//     ——与 l2/alert.js 的 cost-budget-exceeded 规则精确对齐（喂了 alert.js 就算）。
//
// 门控 PROXY_COST_TRACK：默认关 = observe（采集进内存、不写盘）；开 = 可落盘快照历史。
const os = require('os');
const path = require('path');

const COST_SNAPSHOTS_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'cost-snapshots.jsonl');
const DEFAULT_CONFIG = {
    maxSnapshots: 1000,   // 每 provider 快照历史裁剪上限
    reportWindowMs: 24 * 60 * 60 * 1000,   // 趋势/报告默认时间窗
    currency: 'USD',      // 余额/消费/预算统一币种（与 /balances 规范化一致）
};

let currentConfig = { ...DEFAULT_CONFIG };
let clock = () => Date.now();
let activeFile = COST_SNAPSHOTS_FILE;

function costEnabled() {
    const v = String(process.env.PROXY_COST_TRACK ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}
function trackOnly() { return costEnabled(); }   // 默认关：内存态，不写盘

// 把任意形余额解析成有限数值（/balances 已规范化 amount，但容错兜底 NaN/非数）
function coerce(n) { const v = typeof n === 'number' ? n : parseFloat(n); return Number.isFinite(v) ? v : 0; }

// ---- 纯函数：消费额/趋势/信号形状（store 无关，单测直接核） ----
// 单 provider 余额序列 [{ ts, balance }] → 消费额 + 趋势
function seriesConsumption(snapshots, windowMs, reportWindowMs) {
    if (!Array.isArray(snapshots)) { return { total: 0, currentBalance: 0, start: 0, end: 0, trend: [], windowCount: 0 }; }
    const sorted = snapshots.slice().sort((a, b) => a.ts - b.ts);
    const window = typeof windowMs === 'number' ? windowMs : reportWindowMs;
    const start = sorted.length ? sorted[0] : null;
    const end = sorted.length ? sorted[sorted.length - 1] : null;
    const total = start && end ? Math.max(0, coerce(start.balance) - coerce(end.balance)) : 0;
    const trend = [];
    for (let i = 1; i < sorted.length; i++) {
        trend.push({ ts: sorted[i].ts, consumed: coerce(sorted[i - 1].balance) - coerce(sorted[i].balance) });
    }
    let windowCount = 0;
    for (const t of trend) { if (window > 0 && t.ts <= (end ? end.ts : Infinity) && t.ts >= (end ? end.ts - window : -Infinity)) windowCount++; }
    return { total, currentBalance: end ? coerce(end.balance) : 0, start: start ? start.ts : 0, end: end ? end.ts : 0, trend, windowCount };
}

// 把余额序列 + 预算算成 alert.js 的 cost 信号（喂 cost-budget-exceeded）
function makeCostSignal(name, s, now, providerId, opts) {
    const budget = opts && typeof opts.budget === 'number' ? opts.budget : undefined;
    const cost = seriesConsumption(s.snapshots, undefined, currentConfig.reportWindowMs).total;
    const sig = { source: 'cost', providerId: providerId || name, cost: Math.round(cost * 1e6) / 1e6 };
    if (typeof budget === 'number') { sig.budget = budget; }
    return sig;
}

// ---- 工厂：每实例独立 store（测试隔离）；信号源无关、非侵入 ----
function createCostService(opts = {}) {
    const store = opts.store || { providers: [] };
    const localClock = typeof opts.clock === 'function' ? opts.clock : clock;    // 实例可注入，默认模块 clock
    const findP = (name, providerId) => {
        for (const p of store.providers) {
            if (p.name === name || (providerId && p.providerId === providerId)) { return p; }
         }
        const p = { name, providerId: providerId || null, snapshots: [] };
        store.providers.push(p);
        return p;
     };
    function persist(provider) {
         // 仅门控开时落盘；observe(默认)恒不写盘
        if (!trackOnly()) { return; }
        try {
            const fs = require('fs');
            const dir = path.dirname(activeFile);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            fs.appendFileSync(activeFile, JSON.stringify({ name: provider.name, providerId: provider.providerId, ts: provider.snapshots[provider.snapshots.length - 1] ? provider.snapshots[provider.snapshots.length - 1].ts : localClock(), balance: provider.snapshots[provider.snapshots.length - 1] ? provider.snapshots[provider.snapshots.length - 1].balance : null }) + '\n');
         } catch { /* non-fatal, best-effort */ }
     }
     // record(name, balance, opts?) — 追加快照，返回 { snapshot, provider, consumption, signal }
    function record(name, balance, opts = {}) {
        const now = typeof opts.now === 'number' ? opts.now : localClock();
        const p = findP(name, opts.providerId);
        const snap = { ts: now, balance: coerce(balance) };
        p.snapshots.push(snap);
        if (p.snapshots.length > currentConfig.maxSnapshots) { p.snapshots = p.snapshots.slice(-currentConfig.maxSnapshots); }
        const consumption = seriesConsumption(p.snapshots, undefined, currentConfig.reportWindowMs);
        const sig = makeCostSignal(name, p, now, opts.providerId, opts);
        if (opts.persist !== false) { persist(p); }
        return { snapshot: snap, provider: p, consumption, signal: sig };
     }
     // consumption(name, opts?) — 消费额（= 首快照 − 末快照，非负）
    function consumption(name, opts = {}) {
        const p = findP(name, opts.providerId);
        return seriesConsumption(p.snapshots, opts.windowMs, currentConfig.reportWindowMs);
     }
     // trend(name, opts?) — 趋势序列
    function trend(name, opts = {}) {
        return seriesConsumption(findP(name, opts.providerId).snapshots, undefined, currentConfig.reportWindowMs).trend;
     }
     // report(opts?) — 成本报告（§4.6 每日/周/月）；窗口内消费=窗口内各段 consumed 累加
    function report(opts = {}) {
        const windowMs = opts.windowMs || currentConfig.reportWindowMs;
        const cutoff = localClock() - windowMs;
        const rows = [];
        let total = 0;
        for (const p of store.providers) {
            const cons = seriesConsumption(p.snapshots, undefined, windowMs);
            const win = cons.trend.filter((t) => t.ts >= cutoff);
            let spent = 0;
            for (const t of win) { if (typeof t.consumed === 'number' && t.consumed > 0) { spent += t.consumed; } }
            total += spent;
            rows.push({ providerId: p.providerId, name: p.name, spent: Math.round(spent * 1e6) / 1e6, currentBalance: cons.currentBalance });
         }
        rows.sort((a, b) => b.spent - a.spent);
        return { windowMs, generatedAt: localClock(), currency: currentConfig.currency, total: Math.round(total * 1e6) / 1e6, perProvider: rows };
     }
     // 喂 alert.js 的 cost 信号 —— 形状精确对齐 alert.js cost-budget-exceeded
    function produceAlertSignal(name, opts = {}) {
        const p = findP(name, opts.providerId);
        return makeCostSignal(name, p, localClock(), opts.providerId, opts);
     }
    return {
        record, consumption, trend, report, produceAlertSignal,
        snapshotCount: (name, providerId) => findP(name, providerId).snapshots.length,
        getStore, _store: store, _persist: persist,
     };
}

// ---- 模块级单例（持久 store）----
const _store = createCostService();
function getStore() { return _store._store; }
function setConfig(patch) { currentConfig = { ...currentConfig, ...patch }; }
function setClock(fn) { if (typeof fn === 'function') { clock = fn; } }
function getConfig() { return currentConfig; }
function getSnapshotsFile() { return activeFile; }
function setSnapshotsFile(f) { activeFile = f; }
function reset() { _store._store.providers = []; }

module.exports = {
    DEFAULT_CONFIG,
    createCostService,
    // 模块级单例（持久 store）—— 转调 createCostService() 产出的实例方法
    record: _store.record,
    consumption: _store.consumption,
    trend: _store.trend,
    report: _store.report,
    produceAlertSignal: _store.produceAlertSignal,
    seriesConsumption,
    setConfig, setClock, getConfig, getSnapshotsFile, setSnapshotsFile,
    costEnabled, trackOnly,
    reset,
    COST_SNAPSHOTS_FILE,
};
