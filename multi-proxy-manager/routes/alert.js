'use strict';

// L2 P2 告警生产接线 — /api/alert 把 l2/alert.js 内核接上真实信号源。
//
// 设计（与 orchestration.js 门控路由同构）：
//   门控 PROXY_HEALTH_ALERT 默认 off → 全部路由 403，热路径零副作用。
//   开启 = 显式 opt-in：PROXY_HEALTH_ALERT=1 node server.js
//
// 非侵入铁律（与 l2/ 其它内核一致）：
//   只读收集 — 不写 provider-health.json / error-patterns.json / providers.json。
//   告警事件落盘由 alert.js 内核在 PROXY_HEALTH_ALERT=1 时执行。
//
// 三路信号源：
//   1. provider-health.js  → ph.listIsolated() + correlateCrossProxy() → alert signal
//   2. error-patterns.js   → ep.getHistory(limit) 统计 pattern_id 频次 → alert signal
//   3. cost.js (deferred)  → 需 budget 数据源，暂无（YAGNI：无信号源则不触发，正确）
//
// 路由面（最小 YAGNI）：
//   GET  /api/alert           → 已采集事件列表 + count
//   GET  /api/alert/config    → 门控/阈值/cooldown/激活 sink
//   POST /api/alert/collect   → 即时从两路真实信号源产 alert signal → A.emit()

const express = require('express');
const router = express.Router();

const alertSvc = require('../../l2/alert.js');
const ph = require('../lib/provider-health');
const ep = require('../lib/error-patterns');

// ---- 门控（与 alert.js observeOnly 同门控：PROXY_HEALTH_ALERT）----
function isGatedOpen() {
  const v = String(process.env.PROXY_HEALTH_ALERT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
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
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/alert/collect — 从真实信号源即时采集
router.post('/collect', (_req, res) => {
  try {
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

    res.json({ ok: true, collected: alerts.length, alerts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
// 测试用：清空 alert.js 模块级 store（dedup 状态 + events history）
module.exports._resetForTest = () => { alertSvc.reset(); };
