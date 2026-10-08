// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 代理面 floor view —— 只读聚合（per-proxy 成本 + 延迟 + provider 健康 + 宿主事件流）
//
// 挂载：/api/floor（必须挂在代理 wildcard /api/:proxy/* 之前，与 registry /
//       provider-health / sessions 同模式）
//
// 纪律（与 routes/alert.js / provider-health.js 一致）：
//   - 本路由**只读**：不写盘、不改路由、不 flip providers.json enabled、绝不由它触发隔离。
//   - 数据源复用现成采集，不新造：
//       lib/cost-track.getAll()   → per-proxy { totalTokens, cost, requestCount, latencyP50 }
//                                    （latencyP50 由 forward.js 成功转发时喂数，门控 PROXY_COST_TRACK）
//       lib/provider-health       → listIsolated() + getProviderHealth(id)
//       l2/floor-feed             → readLastHook()（最近 hook 命中）+ readAgents()（宿主事件流）
//   - 状态判定 / null 展示 / 排序 一律走 public/floor-view.js（与页面同一份真源）。
//
// 🔴 诚实口径：拿不到就 null，页面画「—」，绝不折算 0；`unavailable` 字段告诉前端
//    「这批数据里哪些字段整体没有值」。
//
// 端点：
//   GET /api/floor — { ok, generatedAt, costTrackEnabled, cellCount, cells:[...],
//                      recentHook, agents:[...], unavailable:[] }

const express = require('express');
const router = express.Router();

const costTrack = require('../lib/cost-track');
const providerHealth = require('../lib/provider-health');
const floorFeed = require('../../l2/floor-feed');
const { buildFloorCells } = require('../public/floor-view.js');

router.get('/', (_req, res) => {
    try {
        const cost = costTrack.getAll();
        const isolatedList = providerHealth.listIsolated();
        const isoMap = {};
        isolatedList.forEach((r) => { isoMap[r.providerId] = true; });

        // provider-health 无「列全部」读口 → 对已知 id 逐个取单条（getProviderHealth 是公开读口）。
        const ids = new Set(
            Object.keys(cost).concat(isolatedList.map((r) => r.providerId))
        );
        const health = {};
        for (const id of ids) {
            const rec = providerHealth.getProviderHealth(id);
            if (rec) health[id] = Object.assign({}, rec, { isolated: !!isoMap[id] });
        }

        // 宿主事件流（Munder 等经 tools/floor-ingest.js 转写）+ 最近 hook 命中。
        // 读不到就是 null / []，不编造。
        let recentHook = null;
        let agents = [];
        try { recentHook = floorFeed.readLastHook(); } catch { /* 非致命 */ }
        try { agents = floorFeed.readAgents(); } catch { /* 非致命 */ }

        const built = buildFloorCells({
            cost,
            health,
            providers: Array.from(ids),
            recentHook,
            agents,
        });

        res.json({
            ok: true,
            generatedAt: built.generatedAt,
            costTrackEnabled: costTrack.enabled(),
            cellCount: built.cells.length,
            cells: built.cells,
            recentHook: built.recentHook,
            agents: built.agents,
            unavailable: built.unavailable,   // 前端据此把无源字段画「—」并标原因
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
