'use strict';

// 告警服务内核（P2 健康监控增强 · L2-BLUEPRINT §4.6「告警机制」）
// 职责：信号驱动的告警规则引擎——把现成健康信号（provider-health / error-patterns 的输出）
//       判级成告警事件，按 cooldown 去重，分派到可插拔 sink。
//
// 设计原则（与 l2/ 其它内核同构，铁律一致）：
//   - 自包含：零 manager lib 依赖。信号由调用方注入（demo/jest 喂 provider-health.listIsolated() /
//     error-patterns.getHistory() 的产出），alert.js 不 require '../lib/*'、不触 manager 热路径。
//   - 非侵入（§5.2 / M2 同构）：不写 providers.json、不 flip enabled、不触路由；sink 默认 observe
//     （只把事件收集进内存 events[]，绝不真发邮件/Telegram/微信）。真发需 PROXY_HEALTH_ALERT=1。
//   - 防告警风暴：每 (rule + key) 在 cooldown 窗口内只发一次（dedup）。
//   - 可插拔：registerSink(name, fn)；内置 log（收集，默认）+ notify（observe 占位）。
//
// 四条内置规则（§4.6 增强项映射）：
//   1) provider-network-wide   ← 跨 proxy 全网故障（signal.correlation.verdict==='network-wide'）→ critical
//   2) provider-unhealthy       ← 单 provider 连续失败进入隔离窗口（signal.status==='unhealthy'）  → warning
//   3) error-pattern-frequent   ← 错误模式频次 ≥ 阈值（signal.frequency ≥ threshold）            → warning
//   4) cost-budget-exceeded     ← 累计成本 ≥ 预算（signal.cost ≥ signal.budget）                  → warning
// 成本信号默认不采集（见 §4.6 成本分析：forward.js 暂无 usage 埋点）——规则已就位，喂 signal 即触发，
// 不采集就不触发（YAGNI：埋点列「成本分析」独立增量，本内核只管"喂了就算"）。
//
// 门控 PROXY_HEALTH_ALERT：默认关 = observe（事件照常产出 + 收集进 events[]，但 sink 不"真发"）；
// 开（=1/true/on）= 真调各 sink。判级永远做，"真发"才门控。
const os = require('os');
const path = require('path');

const ALERT_EVENTS_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'alert-events.jsonl');
const DEFAULT_CONFIG = {
    cooldownMs: 5 * 60 * 1000,      // 同 (rule+key) 在窗口内只发一次（防风暴）
    errorFrequencyThreshold: 5,     // 错误模式频次 ≥ N → 告警
    maxEvents: 1000,                // 内存 events[] 上限（裁剪）
    sinks: ['log'],                // 默认只挂 log sink（收集型，零副作用）
};

let currentConfig = { ...DEFAULT_CONFIG };
let clock = () => Date.now();
let activeFile = ALERT_EVENTS_FILE;

function alertEnabled() {
    const v = String(process.env.PROXY_HEALTH_ALERT ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}
function observeOnly() { return !alertEnabled(); }   // 默认 observe：不真发

// ---- 信号 → 告警规则（纯判定，不触 sink/不写盘） ----
// signal 形如：
//   { source:'provider-health', correlation:{ verdict, count, sources }, status, providerId, consecutiveFailures }
//   { source:'error-patterns',  patternId, frequency }
//   { source:'cost',            providerId, cost, budget }
// 返回告警数组（0..N 条），每条 { rule, severity, key, providerId, signal, message }
function evaluate(signal) {
    const out = [];
    if (!signal || typeof signal !== 'object') { return out; }
    const cfg = currentConfig;
    switch (signal.source) {
        case 'provider-health': {
            const cor = signal.correlation;
            const networkWide = cor && cor.verdict === 'network-wide';
            const id = signal.providerId || (cor && cor.sources && cor.sources.join(',')) || 'unknown';
            if (networkWide) {
                out.push({
                    rule: 'provider-network-wide',
                    severity: 'critical',
                    key: id,
                    providerId: id,
                    signal,
                    message: `provider ${id} 全网故障（${(cor.sources || []).length} 个 proxy 同窗口报失败）`,
                });
            } else if (signal.status === 'unhealthy' || (networkWide === false && signal.status === 'unhealthy')) {
                out.push({
                    rule: 'provider-unhealthy',
                    severity: 'warning',
                    key: id,
                    providerId: id,
                    signal,
                    message: `provider ${id} 连续 ${signal.consecutiveFailures || '?'} 次失败，进入隔离窗口`,
                });
            }
            break;
        }
        case 'error-patterns': {
            const freq = signal.frequency;
            if (typeof freq === 'number' && freq >= cfg.errorFrequencyThreshold) {
                out.push({
                    rule: 'error-pattern-frequent',
                    severity: freq >= cfg.errorFrequencyThreshold * 4 ? 'critical' : 'warning',
                    key: signal.patternId || 'unknown',
                    providerId: null,
                    signal,
                    message: `错误模式 ${signal.patternId || '?'} 近窗口触发 ${freq} 次（阈值 ${cfg.errorFrequencyThreshold}）`,
                    resolution: signal.resolution,
                });
            }
            break;
        }
        case 'cost': {
            if (typeof signal.cost === 'number' && typeof signal.budget === 'number' && signal.cost >= signal.budget) {
                out.push({
                    rule: 'cost-budget-exceeded',
                    severity: 'warning',
                    key: signal.providerId || 'pool',
                    providerId: signal.providerId || null,
                    signal,
                    message: `成本 ${signal.cost} 已达/超预算 ${signal.budget}`,
                });
            }
            break;
        }
        default:
            break;
    }
    return out;
}

// ---- 门控 + 去重 + 分派 ----
// emit(signal) → 判级 → 去重 → 真发/observe → 收集 events[]。返回实际发出（去重后）的告警数组。
function emit(signal, opts = {}) {
    const now = typeof opts.now === 'number' ? opts.now : clock();
    const events = opts._events || getEventsStore();    // 测试可注入独立 store
    const alerts = [];
    for (const a of evaluate(signal)) {
        // dedup：同 (rule+key) 在 cooldown 内只发一次（observe 也照常去重，事件仍进 events[]）
        const last = events[`${a.rule}::${a.key}`];
        const due = last == null || (now - last.ts) >= currentConfig.cooldownMs;
        const stamped = { ...a, ts: now, deduped: !due, observe: observeOnly() };
        if (!due) {
            // 冷却期内：仍登记一条"已去重"事件供观测，但不进 sink
            events.history.push(stamped);
            trimEvents(events);
            alerts.push(stamped);
            continue;
        }
        events[`${a.rule}::${a.key}`] = { ts: now };
        if (!observeOnly()) {
            dispatch(stamped);     // 门控开：真发各 sink
        }
        events.history.push(stamped);
        trimEvents(events);
        alerts.push(stamped);
    }
    if (opts.persist !== false && !observeOnly()) { persistAlerts(events); }
    return alerts;
}

// ---- 分派到所有已挂 sink（每个 sink 包 try/catch，单个崩不影响其它/主流程，best-effort） ----
const sinks = { log: defaultLogSink };
function defaultLogSink(alert) {
    // log sink = 收集型（事件已在 events[].history）；默认零副作用。真实日志可在此接 appendLog。
    return { delivered: true, via: 'log' };
}
function registerSink(name, fn) {
    if (typeof name !== 'string' || !name || typeof fn !== 'function') {
        throw new Error('registerSink(name, fn): name + function required');
    }
    sinks[name] = fn;
    currentConfig.sinks = currentConfig.sinks.includes(name) ? currentConfig.sinks : [...currentConfig.sinks, name];
    return name;
}
function unregisterSink(name) { delete sinks[name]; currentConfig.sinks = currentConfig.sinks.filter((s) => s !== name); }
function getActiveSinks() { return currentConfig.sinks.slice(); }
function dispatch(alert) {
    const out = [];
    for (const name of currentConfig.sinks) {
        const fn = sinks[name];
        if (typeof fn !== 'function') { continue; }
        try { out.push({ sink: name, result: fn(alert) }); } catch { out.push({ sink: name, result: null, error: 'sink-threw' }); }
    }
    return out;
}

// ---- 查询 / 观测 ----
const _events = { history: [], };
function getEventsStore() { return _events; }
function setEventsStore(s) { if (s && typeof s === 'object') { s.history = s.history || []; return s; } return _events; }
function trimEvents(events) {
    if (!Array.isArray(events.history)) { return; }
    if (events.history.length > currentConfig.maxEvents) {
        events.history = events.history.slice(-currentConfig.maxEvents);
    }
}
function list(opts = { limit: 50, rule: null, severity: null }) {
    let out = _events.history.slice().reverse();
    if (opts.rule) { out = out.filter((a) => a.rule === opts.rule); }
    if (opts.severity) { out = out.filter((a) => a.severity === opts.severity); }
    if (opts.limit) { out = out.slice(0, opts.limit); }
    return out;
}
function count() { return _events.history.length; }
function reset() { _events.history = []; for (const k of Object.keys(_events)) { if (k !== 'history') delete _events[k]; } }

// ---- 配置 / 注入（测试 / 调度用） ----
function setConfig(patch) { currentConfig = { ...currentConfig, ...patch }; }
function setClock(fn) { if (typeof fn === 'function') { clock = fn; } }
function getEventsFile() { return activeFile; }
function setEventsFile(f) { activeFile = f; }

// ---- 持久化（镜像 provider-health 模式，best-effort，仅门控开时落盘） ----
function persistAlerts(events) {
    try {
        const dir = path.dirname(activeFile);
        if (!require('fs').existsSync(dir)) { require('fs').mkdirSync(dir, { recursive: true }); }
        require('fs').appendFileSync(activeFile, events.history.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch { /* non-fatal */ }
}

module.exports = {
    DEFAULT_CONFIG,
    createAlertService,   // 工厂：每个实例独立 store（隔离测试用；默认走模块级单例）
    evaluate, emit,
    registerSink, unregisterSink, getActiveSinks, dispatch,
    list, count, reset,
    setConfig, setClock, getEventsFile, setEventsFile,
    alertEnabled, observeOnly,
    ALERT_EVENTS_FILE,
};

// ---- 工厂：返回基于独立 store 的服务视图（共享规则/阈值，隔离 events） ----
function createAlertService(opts = {}) {
    const store = opts.store || { history: [] };
    const self = {
        evaluate: (signal) => evaluate(signal),
        emit: (signal, o = {}) => emit(signal, { ...o, _events: store }),
        list: (o = {}) => { let out = store.history.slice().reverse(); if (o.rule) out = out.filter((a) => a.rule === o.rule); if (o.severity) out = out.filter((a) => a.severity === o.severity); return o.limit ? out.slice(0, o.limit) : out; },
        count: () => store.history.length,
        reset: () => { store.history = []; for (const k of Object.keys(store)) { if (k !== 'history') delete store[k]; } },
        _store: store,
    };
    return self;
}
