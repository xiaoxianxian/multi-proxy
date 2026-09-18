'use strict';

// L2 P2 告警生产接线 — /api/alert 把 l2/alert.js 内核接上真实信号源。
//
// 设计（与 orchestration.js 门控路由同构）：
//   门控 PROXY_HEALTH_ALERT 默认 off → 全部路由 403，热路径零副作用。
//   开启 = 显式 opt-in：PROXY_HEALTH_ALERT=1 node server.js
//
// 非侵入铁律（与 l2/ 其它内核一致）：
//   只读收集 — 不写 provider-health.json / error-patterns.json / providers.json / cost-snapshots.jsonl。
//   告警事件落盘由 alert.js 内核在 PROXY_HEALTH_ALERT=1 时执行。
//
// 三路信号源：
//   1. provider-health.js  → ph.listIsolated() + correlateCrossProxy() → alert signal
//   2. error-patterns.js   → ep.getHistory(limit) 统计 pattern_id 频次 → alert signal
//   3. cost-track.js       → costTrack.getAll() 读 per-proxy A路累计花费 × 预算 → alert signal
//      A 路 token×单价埋点 09-15 已在 forward.js:168 落地（门控 PROXY_COST_TRACK 默认关，关闭时零开销）。
//      预算 opt-in：PROXY_COST_BUDGET（全局）/ PROXY_COST_BUDGET_<PROXY>（per-proxy 覆盖）；
//      无预算 = 无阈值 = 该 proxy 不触发（YAGNI 正确：没设预算就不报超支，零误报）。
//
// 路由面：
//   GET    /api/alert             → 已采集事件列表 + count
//   GET    /api/alert/config      → 门控/阈值/cooldown/激活 sink
//   POST   /api/alert/collect     → 即时从三路真实信号源产 alert signal → A.emit()
//   schedule startCostScheduler() → 门控 PROXY_COST_SCHEDULE 默认关 = 不建 timer；开 = 定时跑 runAllCollects
//   （由 server.js 启动调用；默认 off 时零副作用，不改动「无 schedule」现状）

const express = require('express');
const router = express.Router();

const alertSvc = require('../../l2/alert.js');
const ph = require('../lib/provider-health');
const ep = require('../lib/error-patterns');
const costTrack = require('../lib/cost-track');

// ---- 门控（与 alert.js observeOnly 同门控：PROXY_HEALTH_ALERT）----
function isGatedOpen() {
  const v = String(process.env.PROXY_HEALTH_ALERT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// cost 定时调度门控：默认关 = 零副作用（不建 timer）
function isCostScheduleOpen() {
  const v = String(process.env.PROXY_COST_SCHEDULE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// 解析某 proxy 的预算：per-proxy env > 全局 env > undefined（无预算 = 该 proxy 不触发）
//   PROXY_COST_BUDGET          全局默认预算
//   PROXY_COST_BUDGET_<PROXY>  per-proxy 覆盖（键名大写化，env 惯例，如 PROXY_COST_BUDGET_OPENAI）
// 非法/缺省 → 返回 undefined → 跳过该 proxy（YAGNI：没设预算就不报超支）
function resolveBudget(proxyName) {
  if (proxyName) {
    const raw = process.env['PROXY_COST_BUDGET_' + String(proxyName).toUpperCase()];
    if (raw != null && raw !== '') {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) return n;
      }
  }
  const raw = process.env.PROXY_COST_BUDGET;
  if (raw != null && raw !== '') {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
   }
  return undefined;
}

router.use((req, res, next) => {
  if (!isGatedOpen()) return res.status(403).json({
    error: 'alert-gate-closed',
    hint: "PROXY_HEALTH_ALERT 未开启（默认 off）。开灰度：PROXY_HEALTH_ALERT=1 node server.js",
  });
  next();
});

// GET /api/alert — 已采集事件列表
router.get('/', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, alertSvc.DEFAULT_CONFIG.maxEvents);
    res.json({
      ok: true,
      count: alertSvc.count(),
      events: alertSvc.list({ limit }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/alert/config — 门控状态 + 配置
router.get('/config', (_req, res) => {
  try {
    res.json({
      ok: true,
      gateOpen: isGatedOpen(),
      observeOnly: alertSvc.observeOnly(),
      activeSinks: alertSvc.getActiveSinks(),
      threshold: alertSvc.DEFAULT_CONFIG.errorFrequencyThreshold,
      cooldownMs: alertSvc.DEFAULT_CONFIG.cooldownMs,
      costScheduleOpen: isCostScheduleOpen(),
      costBudget: resolveBudget('') || null,
     });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- 三路基座：抽取成纯函数供 /collect + 定时调度复用 ----
// 从三路真实信号源即时产 alert signal → alertSvc.emit()，返回实际发出（去重后）的告警数组。
// 第 3 路 cost：读 costTrack.getAll()（A 路 per-proxy 累计花费 × 当前预算），
//  形状 { source:'cost', providerId, cost, budget } 精确喂 alert.js cost-budget-exceeded 规则。
//  无预算（resolveBudget → undefined）的 proxy 跳过 = 不触发（YAGNI 正确）。
function runAllCollects() {
  const alerts = [];
  const threshold = alertSvc.DEFAULT_CONFIG.errorFrequencyThreshold;

   // 1. provider-health 信号（只读 ph.listIsolated + correlateCrossProxy）
  for (const rec of ph.listIsolated()) {
    const correlation = ph.correlateCrossProxy(rec.providerId);
    const sig = {
      source: 'provider-health',
      correlation,
      providerId: rec.providerId,
      status: rec.status,
      consecutiveFailures: rec.consecutiveFailures,
       };
    const fired = alertSvc.emit(sig, { persist: true });
    for (const a of fired) alerts.push(a);
    }

   // 2. error-patterns 信号（从 getHistory 统计 pattern_id 频次）
  const history = ep.getHistory(200);
  const freqByPattern = {};
  for (const entry of history) {
    if (entry.pattern_id) {
      freqByPattern[entry.pattern_id] = (freqByPattern[entry.pattern_id] || 0) + 1;
        }
    }
  const patterns = ep.getPatterns(false); // 按 id 升序，稳定
  for (const p of patterns) {
    const freq = freqByPattern[p.id];
    if (freq && freq >= threshold) {
      const sig = {
          source: 'error-patterns',
        patternId: p.id,
        frequency: freq,
        resolution: p.resolution,
          };
      const fired = alertSvc.emit(sig, { persist: true });
      for (const a of fired) alerts.push(a);
        }
    }

   // 3. cost 信号（A 路 token×单价累计 × 预算）
  const allCost = costTrack.getAll();
  for (const proxyName of Object.keys(allCost)) {
    const budget = resolveBudget(proxyName);
    if (budget == null) { continue; } // 没设预算 → 不报超支（零误报）
    const sig = { source: 'cost', providerId: proxyName, cost: allCost[proxyName].cost, budget };
    const fired = alertSvc.emit(sig, { persist: true });
    for (const a of fired) alerts.push(a);
    }

  return alerts;
}

// POST /api/alert/collect — 从三路真实信号源即时采集
router.post('/collect', (_req, res) => {
  try {
    const alerts = runAllCollects();
    res.json({ ok: true, collected: alerts.length, alerts });
    } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
    }
});

// ---- 定时调度：门控 PROXY_COST_SCHEDULE 默认关 = 零副作用（不建 timer）----
// 开 = 每 intervalMs 跑一次 runAllCollects（unref：不阻塞进程退出；clearInterval 可控）。
// 幂等：已启动不重复建。由 server.js 启动时调用。
function startCostScheduler(opts = {}) {
  if (schedulerHandle) { return schedulerHandle; } // 幂等
  if (!isCostScheduleOpen()) { return null; }      // 门控关 → 不建 timer（零副作用）
  const intervalMs = Number(opts.intervalMs) || Number(process.env.PROXY_COST_SCHEDULE_INTERVAL_MS) || 10 * 60 * 1000;
  const timer = setInterval(() => {
    try { runAllCollects(); } catch { /* best-effort：单次崩不影响后续 tick */ }
    }, intervalMs);
  if (typeof timer.unref === 'function') { timer.unref(); } // 不阻塞进程退出
  schedulerHandle = {
    handle: timer,
    intervalMs,
    stop() { clearInterval(timer); schedulerHandle = null; },
        };
  return schedulerHandle;
}
let schedulerHandle = null;

module.exports = router;
// 测试用 / 生命周期钩子
module.exports._resetForTest = () => {
  alertSvc.reset();
  costTrack.reset();
  if (schedulerHandle) { schedulerHandle.stop(); }
};
module.exports.startCostScheduler = startCostScheduler;
module.exports.stopCostScheduler = () => { if (schedulerHandle) { schedulerHandle.stop(); } };
module.exports.runAllCollects = runAllCollects;
module.exports.resolveBudget = resolveBudget;
module.exports.isCostScheduleOpen = isCostScheduleOpen;
