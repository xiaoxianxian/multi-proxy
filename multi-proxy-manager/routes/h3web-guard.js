// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// h3web Guard API — 外部本地服务（h3web :8731）检测 / 提醒 / 可选一键开启的展示层。
// 挂载到 /api/h3web/*（必须挂在代理 wildcard /api/:proxy/* 之前，否则被 :proxy=h3web 误捕获）
//
// 分工原则（维护者 2026-10-10）：不给 h3web 配 launchd 常驻；由 multi-proxy 在使用侧
// 「发现没起就提醒」+ 留显式授权的「一键开启」。默认态零副作用。
//
// 端点：
//   GET  /api/h3web/status — 只读快照：{ up, port, statusCode, script, advice }（不鉴权，同 provider-health）
//   POST /api/h3web/start  — 一键开启；受 PROXY_H3WEB_AUTOSTART 门控（默认关 → 403）+ requireAuth
//
// 不变式：本路由绝不自行拉起进程；真动作在 lib/h3web-guard.js 内受门控，且 GET 永远只读。

const express = require('express');
const router = express.Router();

const guard = require('../lib/h3web-guard');
const { requireAuth } = require('../lib/auth');

// 只读状态 + 提醒（探活严格只读：只发 GET /，绝不触发 /api/gen）。
router.get('/status', function (_req, res) {
  guard.snapshot().then(function (snap) {
    // 服务 down 时给 200 + up:false（不是错误响应）——「没起」是正常状态，不该是 HTTP 错误。
    res.json(snap);
  }).catch(function (e) {
    res.status(500).json({ ok: false, error: e && e.message });
  });
});

// 一键开启：门控关时 403 并告知怎么开；门控开时真 spawn（detached，脱离 manager 生命周期）。
router.post('/start', requireAuth, function (req, res) {
  guard.start({ script: req.body && req.body.script }).then(function (r) {
    if (r.gated) return res.status(403).json({ ok: false, gated: true, error: r.error });
    if (!r.ok) return res.status(500).json(r);
    res.json({ ok: true, pid: r.pid, port: r.port, probe: r.probe });
  }).catch(function (e) {
    res.status(500).json({ ok: false, error: e && e.message });
  });
});

module.exports = router;
