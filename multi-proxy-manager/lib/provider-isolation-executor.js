'use strict';

// ==================== M2 执行层：Provider 故障隔离「执行态」（provider-health 的执行 arm）====================
//
// 角色：消费 provider-health.listIsolated() 的「建议隔离清单」，按门控决定是否真把 provider 标记隔离。
// 与 l2/alert.js 同构的「门控 + 可插拔 + 非侵入」内核，但角色相反——alert.js 消费健康/错误信号产「告警事件」，
// 本模块消费 provider-health 的「建议清单」决定并（门控下）产「隔离标记」。
//
// 核心不变式（继承 provider-health.js，绝不破，高后果动作默认关）：
//   - 默认 observe：PROXY_HEALTH_ISOLATE 关（默认）→ 只 plan + 收集进内存 markers[]，绝不写盘 / 绝不 flip。
//   - 绝不默认翻 providers.json 的 enabled：误禁用会重排全局路由=高后果
//     （ITERATION-ROADMAP M2 卡点① / M6 ①，同构安全姿态）。默认「真动作」= 写独立 sidecar
//     provider-isolation.json（.tmp→rename 原子 + backup + 幂等），**不**改 providers.json、不 flip、不触路由。
//     flip providers.json enabled 是「另一条可注入 executor」，默认不注册、需显式 opt-in + sign-off。
//   - judge 永远做、act 才门控（与 alert/cost 同构）：plan/collect 不受门控影响，executor 派发受门控。
//
// 范式（与 alert.js 1:1 对应，便于对照）：
//   evaluate(signal)        ↔  plan(rec)         —— 纯判定，不触 executor / 不写盘
//   emit(signal, opts)      ↔  emit(rec, opts)   —— 门控 + cooldown 去重 + 派发 + 收集
//   registerSink/dispatch   ↔  registerExecutor/dispatch（sink↔executor 一一对应，API 互为别名）
//   list/count/reset        ↔  list/count/reset  （markers 查询/重置）
//   createAlertService(store) ↔ createIsolationExecutor({store,clock})（工厂隔离，测试用）
//   PROXY_HEALTH_ALERT       ↔  PROXY_HEALTH_ISOLATE （门控 env，默认关）
//   alert-events.jsonl 落盘   ↔  provider-isolation.json sidecar 落盘（仅门控开且 executor 活跃）
//
// 执行态三级（与 mcp-server PROXY_ADAPTER_REAL 退化同构）：
//   门控关（默认）           → 恒 observe：plan + 收集，executor 零调用、零 fs。
//   门控开 + 无活跃 executor → 退化「仅 plan」：记录「本可隔离」，applied=false / degraded='no-executor'，零 fs（非侵入）。
//   门控开 + 活跃 executor   → 真执行：跑 active executor(s)（内置 writeMarkers 原子写 sidecar 为默认真动作），
//                              best-effort 试/抛不崩。
//
// 消费方：listIsolated() 的产出由调用方喂入 run(list, {now})；本模块不 require provider-health，保持内核自包含
// （与 alert.js 信号注入式一致），测试/demo 用 mock 产出喂入。热路径零改动。
const fs = require('fs');
const path = require('path');
const os = require('os');

const ISOLATION_MARKERS_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'provider-isolation.json');
const SPEC_VERSION = '1.0.0';
const DEFAULT_CONFIG = {
  cooldownMs: 5 * 60 * 1000,   // 同 providerId 在窗口内只「执行」一次（防隔离风暴，与 alert.js 同语义）
  maxRecords: 1000,           // 内存 markers[] 上限（裁剪）
  executors: [],             // 默认空 = 不真执行（门控开也需显式 registerExecutor 才真动作，两把钥匙）
  markersFile: ISOLATION_MARKERS_FILE,
  backup: true,              // 写 sidecar 前先备份旧文件 .bak
};

let clock = () => Date.now();

// ---- 门控（与 alert.js observeOnly 同门控：PROXY_HEALTH_ISOLATE，默认关 = observe）----
function isolationEnabled() {
  const v = String(process.env.PROXY_HEALTH_ISOLATE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
function observeOnly() { return !isolationEnabled(); }

// ---- 纯判定：一条 provider-health record → 是否建议隔离 + 原因（不触 executor / 不写盘）----
// rec 形如 provider-health.listIsolated() 产出的条目：
//   { providerId, status, consecutiveFailures, unhealthySince, unhealthyUntil, lastSource, correlation? }
// correlation（可选，由 correlateCrossProxy 富化）: { verdict:'single-proxy'|'network-wide', sources, count }
function plan(rec, now) {
  const t = typeof now === 'number' ? now : clock();
  if (!rec || typeof rec !== 'object') { return { isolate: false, reason: 'no-record', providerId: null }; }
  if (rec.status !== 'unhealthy') { return { isolate: false, reason: 'healthy', providerId: rec.providerId || null }; }
  if (rec.unhealthyUntil == null || t >= rec.unhealthyUntil) {
    return { isolate: false, reason: 'window-expired', providerId: rec.providerId || null };
  }
  const cor = rec.correlation || null;
  const verdict = (cor && cor.verdict) ? cor.verdict : 'single-proxy';
  const reason = verdict === 'network-wide' ? 'network-wide' : 'consecutive-failures';
  return {
    isolate: true,
    reason,
    verdict,
    consecutiveFailures: typeof rec.consecutiveFailures === 'number' ? rec.consecutiveFailures : null,
    sources: cor && Array.isArray(cor.sources) ? cor.sources.slice()
             : (rec.lastSource ? [rec.lastSource] : []),
    unhealthySince: rec.unhealthySince,
    unhealthyUntil: rec.unhealthyUntil,
    providerId: rec.providerId,
  };
}

// ---- 标记构造（从判定结果）—— 隔离 sidecar 的条目形态 ----
function markerFromPlan(p, now, extra = {}) {
  return Object.assign({
    providerId: p.providerId,
    reason: p.reason,
    verdict: p.verdict,
    consecutiveFailures: p.consecutiveFailures,
    sources: p.sources,
    unhealthySince: p.unhealthySince,
    unhealthyUntil: p.unhealthyUntil,
  }, extra);
}

// 幂等判定：除瞬时字段（isolatedAt/viaExecutor/applied）外的稳定键；相同 → 不重写（「不重复写」）
function stableKey(m) {
  const { isolatedAt, viaExecutor, applied, observe, executed, flippedEnabled, deduped, ...rest } = m;
  return JSON.stringify(rest);
}

// ---- 原子写 sidecar（镜像 session-store.js 的 .tmp→rename + 0o600）+ backup；best-effort 不抛 ----
function atomicWriteMarkers(svc, now) {
  try {
    const dir = path.dirname(svc.file);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    const doc = {
      specVersion: SPEC_VERSION,
      updatedAt: new Date(typeof now === 'number' ? now : Date.now()).toISOString(),
      // entries: providerId → marker；按 providerId upsert，天然去重（幂等的存储层保证）
      entries: {},
    };
    for (const [id, m] of svc.state.markers) {
      const { isolatedAt, deduped, ...persisted } = m;
      persisted.isolatedAt = isolatedAt;
      doc.entries[id] = persisted;
    }
    if (svc.cfg.backup && fs.existsSync(svc.file)) {
      try { fs.copyFileSync(svc.file, svc.file + '.bak'); } catch { /* backup best-effort */ }
    }
    const tmp = svc.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, svc.file);        // 原子提交：要么旧、要么新，永不半写
    return true;
  } catch (e) {
    console.error('[provider-isolation] marker write failed:', e.message);
    return false;
  }
}

// 把一条 marker 落进内存权威表并按稳定键比对决定是否真写盘（幂等）
function commit(svc, marker, ctx) {
  svc.state.markers.set(marker.providerId, marker);
  const stable = stableKey(marker);
  const prev = svc.state.lastWritten.get(marker.providerId);
  if (prev === stable) {
    return { applied: false, skipped: 'no-change', idempotent: true, marker };
  }
  const wrote = atomicWriteMarkers(svc, ctx.now);
  if (wrote) { svc.state.lastWritten.set(marker.providerId, stable); }
  return { applied: wrote, skipped: wrote ? null : 'write-failed', idempotent: false, marker };
}

// ---- 可插拔 executor（是「动作」；alert.js 的 sink 在本层的对应物）----
// contract：(plan, ctx) => { via, applied, ...? }。每个 executor 派发时包 try/catch（best-effort）。
// 内置 writeMarkers：把判定结果写成 sidecar（默认绝不 flip providers.json）。
// flip/notify 是注入缝：默认 ctx 不带 → 永不执行高后果动作。
function makeWriteMarkersExecutor() {
  return function writeMarkers(plan, ctx /* = { now, commit } */) {
    const marker = markerFromPlan(plan, ctx.now, {
      viaExecutor: ['writeMarkers'],
      executed: true,
      flippedEnabled: false,           // 显式声明：默认绝不 flip providers.json enabled
    });
    const r = ctx.commit(marker);
    return { via: 'writeMarkers', applied: !!r.applied, skip: r.skipped };
  };
}
// 默认 observe 收集器（alert.js 的 log sink 对应物）：门控关时只产建议，零副作用。
function makeObserveExecutor() {
  return function observe(plan, ctx) {
    return { via: 'observe', applied: false, observed: true };
  };
}

// ---- 服务（工厂）：独立 store（markers/cooldown/lastWritten/executors），测试隔离 ----
function makeService(opts = {}) {
  const state = {
    markers: new Map(),    // providerId → marker（隔离标记内存权威表）
    cooldown: new Map(),   // providerId → 最近一次执行时刻（防风暴去重）
    lastWritten: new Map(),// providerId → 最近一次写盘稳定键（幂等去重）
    execs: {},             // name → executor fn（全部已知 executor）
  };
  // 内置 executor 默认可用但**不活跃**（不写盘）：两把钥匙之一——注册进活跃表才真执行。
  state.execs.writeMarkers = makeWriteMarkersExecutor();
  state.execs.observe = makeObserveExecutor();

  const svc = {
    file: opts.file || ISOLATION_MARKERS_FILE,
    cfg: { ...DEFAULT_CONFIG, ...(opts.config || {}) },
    state,

    registerExecutor(name, fn) {
      if (typeof name !== 'string' || !name) { throw new Error('registerExecutor(name, fn): name required'); }
      if (fn !== undefined) {
        if (typeof fn !== 'function') { throw new Error('registerExecutor(name, fn): fn must be a function'); }
        state.execs[name] = fn;
      }
      // 活跃表（active = 门控开时真派发的 executor）
      if (!svc.cfg.executors.includes(name)) { svc.cfg.executors = [...svc.cfg.executors, name]; }
      return name;
    },
    unregisterExecutor(name) {
      delete state.execs[name];
      svc.cfg.executors = svc.cfg.executors.filter((s) => s !== name);
    },
    getActiveExecutors() { return svc.cfg.executors.slice(); },
    setConfig(patch) { svc.cfg = { ...svc.cfg, ...patch }; },
    setFile(f) { svc.file = f; },
    getFile() { return svc.file; },
    setClock(fn) { if (typeof fn === 'function') { clock = fn; } },

    // sink ↔ executor 一一对应（alert.js 同构别名）
    registerSink: (n, f) => svc.registerExecutor(n, f),
    unregisterSink: (n) => svc.unregisterExecutor(n),
    getActiveSinks: () => svc.getActiveExecutors(),

    emit: (rec, o = {}) => emit(svc, rec, o),
    run: (list, o = {}) => runAll(svc, list, o),
    rollback: (id, o = {}) => rollback(svc, id, o),
    heal: (o = {}) => heal(svc, o),
    list: (o = {}) => listMarkers(svc, o),
    count: () => svc.state.markers.size,
    reset() { svc.state.markers.clear(); svc.state.cooldown.clear(); svc.state.lastWritten.clear(); },
  };
  return svc;
}

// ---- 门控 + cooldown 去重 + 派发 + 收集（emit 单条；alert.js emit 的对应物）----
function emit(svc, rec, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : clock();
  const p = plan(rec, now);
  if (!p.isolate) {
    return { isolate: false, reason: p.reason, observe: observeOnly(), applied: false, executed: false };
  }
  const key = p.providerId;
  const observe = observeOnly();

  // 1) cooldown 去重（防隔离风暴）：同 providerId 窗口内第二次 → 登记 plan 但不再派发
  const last = svc.state.cooldown.get(key);
  const due = last == null || (now - last) >= svc.cfg.cooldownMs;
  if (!due) {
    const marker = markerFromPlan(p, now, {
      viaExecutor: null, executed: false, deduped: true, flippedEnabled: false, observe, applied: false,
    });
    svc.state.markers.set(key, marker);
    trimRecords(svc);
    return { isolate: true, marker, applied: false, deduped: true, observe, executed: false, reason: 'cooldown' };
  }
  svc.state.cooldown.set(key, now);

  // 2) 非侵入核心：observe（门控关）→ 只收集 plan，绝不派 executor / 绝不写盘。
  //    即使调用方传 persist:true 也无法绕过门控（门控权在内核，与 alert.js emit 同构）。
  if (observe) {
    const marker = markerFromPlan(p, now, {
      viaExecutor: null, executed: false, deduped: false, flippedEnabled: false, observe: true, applied: false,
    });
    svc.state.markers.set(key, marker);
    trimRecords(svc);
    return { isolate: true, marker, applied: false, deduped: false, observe: true, executed: false, reason: 'observe' };
  }

  // 3) 门控开：有活跃 executor → 真执行；无 → 退化「仅 plan」（非侵入，不触 fs，类比 mcp 的「仅路由」退化）
  const active = svc.cfg.executors.filter((n) => typeof svc.state.execs[n] === 'function');
  if (active.length === 0) {
    const marker = markerFromPlan(p, now, {
      viaExecutor: [], executed: false, deduped: false, flippedEnabled: false, observe: false,
      applied: false, degraded: 'no-executor',
    });
    svc.state.markers.set(key, marker);
    trimRecords(svc);
    return { isolate: true, marker, applied: false, deduped: false, observe: false, executed: false, reason: 'degraded-no-executor' };
  }

  // 4) 真派发（best-effort：单个 executor 抛不崩、不影响其它/主流程）
  const ctx = buildCtx(svc, p, now, opts);
  const results = dispatch(svc, ctx, p);
  const anyApplied = results.some((r) => r && r.applied === true && !r.skip);
  const anyFlip = results.some((r) => r && r.flip === true);
  const usedVia = results.filter((r) => r && r.via).map((r) => r.via);
  const marker = markerFromPlan(p, now, {
    viaExecutor: usedVia, executed: true, deduped: false, observe: false,
    flippedEnabled: anyFlip, applied: anyApplied, executorResults: results,
  });
  svc.state.markers.set(key, marker);
  trimRecords(svc);
  return { isolate: true, marker, applied: anyApplied, deduped: false, observe: false, executed: true, executorResults: results };
}

// 组装 executor 执行上下文（注入缝）。默认 ctx 不带 flipEnabled/notify → 高后果动作永不触发；
// 调用方（demo/生产接线）可经 opts.context 注入 flipEnabled/notify，opt-in 且需 sign-off。
function buildCtx(svc, p, now, opts) {
  return {
    now,
    providerId: p.providerId,
    plan: p,
    // 隔离 sidecar 原子写（默认真动作）。
    commit: (marker) => commit(svc, marker, { now }),
    // 可选注入缝：默认 null → 绝不 flip providers.json / 绝不发通知。
    flipEnabled: opts.context && typeof opts.context.flipEnabled === 'function' ? opts.context.flipEnabled : null,
    notify: opts.context && typeof opts.context.notify === 'function' ? opts.context.notify : null,
  };
}

// 派发到全部活跃 executor（best-effort，单个崩不影响其它/主流程）
function dispatch(svc, ctx, p) {
  const out = [];
  for (const name of svc.cfg.executors) {
    const fn = svc.state.execs[name];
    if (typeof fn !== 'function') { continue; }
    try {
      const r = fn(p, ctx) || {};
      out.push(Object.assign({ executor: name, ok: true, via: r.via || name }, r));
    } catch (e) {
      out.push({ executor: name, ok: false, via: null, applied: false, error: e && e.message || String(e) });
     }
  }
  return out;
}

// ---- 消费 provider-health.listIsolated()（批量）----
function runAll(svc, list, opts = {}) {
  const summary = { processed: 0, isolated: 0, applied: 0, deduped: 0, observed: 0, degraded: 0, markers: [] };
  const out = [];
  for (const rec of (Array.isArray(list) ? list : [])) {
    const r = emit(svc, rec, opts);
    out.push(r);
    summary.processed++;
    if (r.isolate) {
      summary.isolated++;
      if (r.marker) summary.markers.push(r.marker);
      if (r.deduped) summary.deduped++;
      if (r.applied) summary.applied++;
      if (r.observe) summary.observed++;
      if (r.degraded === 'no-executor' || (r.reason === 'degraded-no-executor')) summary.degraded++;
    }
  }
  summary.results = out;
  return summary;
}

// ---- 回滚 / 自愈（解除隔离；默认 observe 仅清内存标记、不写盘，门控开才重写 sidecar 反映解除）----
function rollback(svc, providerId, opts = {}) {
  if (!svc.state.markers.has(providerId)) { return { removed: false, reason: 'not-isolated' }; }
  svc.state.markers.delete(providerId);
  svc.state.lastWritten.delete(providerId);
  svc.state.cooldown.delete(providerId);
  let written = null;
  if (!observeOnly()) { written = atomicWriteMarkers(svc, opts.now != null ? opts.now : clock()); }
  return { removed: true, observed: observeOnly(), written, providerId };
}

// 自愈：窗口已到期（unhealthyUntil<=now）或 provider 已不在 live 表的标记自动解除
function heal(svc, opts = {}) {
  const now = opts.now != null ? opts.now : clock();
  const live = opts.liveSet instanceof Set ? opts.liveSet : null;
  const removed = [];
  for (const [id, m] of svc.state.markers) {
    const expired = m.unhealthyUntil != null && now >= m.unhealthyUntil;
    const notLive = live && !live.has(id);
    if (expired || notLive) {
      svc.state.markers.delete(id);
      svc.state.lastWritten.delete(id);
      removed.push(id);
    }
  }
  let written = null;
  if (removed.length && !observeOnly()) { written = atomicWriteMarkers(svc, now); }
  return { healed: removed.length, removed, observed: observeOnly(), written };
}

// ---- 查询 / 重置（markers）----
function listMarkers(svc, opts = { limit: 50, reason: null }) {
  let out = [...svc.state.markers.values()];
  if (opts.reason) { out = out.filter((m) => m.reason === opts.reason); }
  if (opts.limit) { out = out.slice(-opts.limit).reverse(); }
  return out;
}
function trimRecords(svc) {
  if (svc.state.markers.size > svc.cfg.maxRecords) {
    const ids = [...svc.state.markers.keys()].slice(0, svc.state.markers.size - svc.cfg.maxRecords);
    for (const id of ids) { svc.state.markers.delete(id); svc.state.lastWritten.delete(id); }
  }
}

// ---- 配置 / 注入（测试 / 调度用）----
function setConfig(patch) { singleton.setConfig(patch); }
function setClock(fn) { if (typeof fn === 'function') { clock = fn; } }
function getMarkersFile() { return singleton.file; }
function setMarkersFile(f) { singleton.file = f; }
function reset() { singleton.reset(); }

// 模块级单例（生产接线 / 直接调用）
const singleton = makeService({ file: ISOLATION_MARKERS_FILE });
function registerExecutor(name, fn) { return singleton.registerExecutor(name, fn); }
function unregisterExecutor(name) { singleton.unregisterExecutor(name); }
function getActiveExecutors() { return singleton.getActiveExecutors(); }
const registerSink = registerExecutor;
const unregisterSink = unregisterExecutor;
const getActiveSinks = getActiveExecutors;

// 工厂：独立 store（测试隔离），默认不挂内置 executor（与 singleton 一致：内置可用但不活跃）
function createIsolationExecutor(opts = {}) {
  return makeService(opts);
}

module.exports = {
  DEFAULT_CONFIG,
  SPEC_VERSION,
  ISOLATION_MARKERS_FILE,
  // 工厂 + 单例 API
  createIsolationExecutor,
  makeWriteMarkersExecutor,
  makeObserveExecutor,
  // 判定 / 执行
  plan,
  markerFromPlan,
  // 单例操作（生产接线）
  run: (list, o = {}) => runAll(singleton, list, o),
  emit: (rec, o = {}) => emit(singleton, rec, o),
  rollback: (id, o = {}) => rollback(singleton, id, o),
  heal: (o = {}) => heal(singleton, o),
  list: (o = {}) => listMarkers(singleton, o),
  count: () => singleton.state.markers.size,
  reset,
  // 可插拔 executor（sink 别名）
  registerExecutor, unregisterExecutor, getActiveExecutors,
  registerSink, unregisterSink, getActiveSinks,
  // 门控 / 观测
  isolationEnabled, observeOnly,
  // 注入
  setConfig, setClock, getMarkersFile, setMarkersFile,
};
