'use strict';

// Provider Health API — M2 方向二「Provider 故障自动标记与隔离」展示层
// 挂载到 /api/provider-health/*（必须挂在代理 wildcard /api/:proxy/* 之前）
//
// 不变式：本路由为只读展示，绝不执行隔离动作。listIsolated 在 observe 模式
// 下（默认）只是「建议隔离」清单，真正 flip enabled 由受 PROXY_HEALTH_ISOLATE
// 门控的上层执行（默认关）。见 l2 provider-health.js 头注 + ITERATION-ROADMAP M2。
//
// 端点：
//   GET /api/provider-health  — { isolateEnabled, threshold, isolated:[{...rec, correlation}] }
//   GET /api/provider-health/:id — 单 provider 健康记录（404 若无）

const express = require('express');
const router = express.Router();

const providerHealth = require('../lib/provider-health');

// 列表（只读，不挂 auth，与 manager 其它 GET 一致）。
router.get('/', (_req, res) => {
    try {
        const isolated = providerHealth.listIsolated().map(function(rec) {
            return Object.assign({}, rec, {
                correlation: providerHealth.correlateCrossProxy(rec.providerId),
            });
        });
        res.json({
            ok: true,
            isolateEnabled: providerHealth.isolateEnabled(),
            threshold: providerHealth.DEFAULT_CONFIG.failureThreshold,
            count: isolated.length,
            isolated: isolated,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 单 provider（:id 在 GET / 之后，无静态路径冲突）
router.get('/:id', (req, res) => {
    try {
        const rec = providerHealth.getProviderHealth(req.params.id);
        if (!rec) return res.status(404).json({ ok: false, error: 'unknown provider' });
        res.json({
            ok: true,
            correlation: providerHealth.correlateCrossProxy(req.params.id),
            ...rec,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
