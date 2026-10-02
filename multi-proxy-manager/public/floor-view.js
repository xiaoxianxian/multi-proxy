/**
 * floor-view · 代理面「floor」盘面纯函数（浏览器 / Node 双用）
 *
 * 为什么要抽成双用模块：盘面数据有两处消费者 ——
 *   ① routes/floor.js（后端聚合，返回给页面的 JSON 里直接带 cells / recentHook / agents）
 *   ② public/floor.html（页面渲染）
 * 两边必须是同一套口径：状态怎么判、null 怎么展示、格子怎么排序。
 * 写两份必然漂。所以只留这一份真源（同 skill-ledger-diff.js 的纪律）。
 *
 * 纯函数、零依赖：不 require 任何东西、不读盘、不碰 localStorage。
 *
 * 浏览器：`<script src="./floor-view.js"></script>` → 全局 `window.FloorView`
 * Node  ：`require('./floor-view.js')` → `{ STATUS, buildFloorCells, numOrNull }`
 *
 * 🔴 诚实口径：任何拿不到数据的字段一律 `null`，由渲染层画「—」，**绝不折算成 0**
 *    （0 会被读成「延迟 0ms / 没命中过 hook」，那是假数据）。见 59 号文档。
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) { module.exports = api; }
    else { root.FloorView = api; }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 状态语义色 —— 代理面语义（不是 Munder 的工位小人语义）。
    // 色值选在明/暗两套主题下都可读的中性绿/蓝/琥珀/红/灰。
    var STATUS = {
        isolated: { label: 'isolated', color: '#ef4444', hint: '已建议隔离（连续失败超阈值）' },
        degraded: { label: 'degraded', color: '#f59e0b', hint: '有失败记录，尚未触隔离' },
        active:   { label: 'active',   color: '#3b82f6', hint: '本轮有流量（无健康记录）' },
        healthy:  { label: 'healthy',  color: '#22c55e', hint: '探活正常' },
        unknown:  { label: 'unknown',  color: '#6b7280', hint: '无任何数据' },
    };

    // 展示口径：null / 非数字 → null（渲染层画「—」），绝不折算 0。
    function numOrNull(v) {
        return (typeof v === 'number' && isFinite(v)) ? v : null;
    }

    // 状态判定优先级：隔离 > 失败 > 正常 > 有流量 > 无数据。
    function statusOf(rec, hasCost) {
        if (rec && rec.isolated) return 'isolated';
        if (rec && rec.status === 'unhealthy') return 'degraded';
        if (rec && rec.status === 'healthy') return 'healthy';
        if (hasCost) return 'active';
        return 'unknown';
    }

    /**
     * buildFloorCells(input) → { cells, generatedAt, recentHook, agents, unavailable }
     *
     * @param {Object} input
     * @param {Object} input.cost      lib/cost-track.getAll() 的产出
     *                                 { proxy: { totalTokens, cost, requestCount, latencyP50 } }
     * @param {Object} input.health    { id: rec }（rec 见 lib/provider-health.js recordProbe 的形状）
     * @param {Array}  input.providers 额外要展示的 id（配置里有、但既无流量也无健康记录）
     * @param {Object} [input.recentHook] l2/floor-feed.readLastHook() 的产出，或 null
     * @param {Array}  [input.agents]     l2/floor-feed.readAgents() 的产出，或 []
     * @param {string} [input.generatedAt]
     */
    function buildFloorCells(input) {
        input = input || {};
        var cost = input.cost || {};
        var health = input.health || {};

        var ids = [], seen = {};
        function push(id) { if (id && !seen[id]) { seen[id] = 1; ids.push(id); } }
        Object.keys(cost).forEach(push);
        Object.keys(health).forEach(push);
        (input.providers || []).forEach(push);

        var cells = ids.map(function (id) {
            var c = cost[id] || null;
            var rec = health[id] || null;
            var st = statusOf(rec, !!c);
            return {
                id: id,
                status: st,
                statusColor: STATUS[st].color,
                statusLabel: STATUS[st].label,
                statusHint: STATUS[st].hint,
                totalTokens: numOrNull(c && c.totalTokens),
                cost: numOrNull(c && c.cost),
                requestCount: numOrNull(c && c.requestCount),
                // 真实 p50（来自 forward 成功转发的耗时中位数）；无样本 → null 画「—」
                latencyMs: numOrNull(c && c.latencyP50),
                failures: numOrNull(rec && rec.consecutiveFailures),
                lastProbeAt: (rec && rec.lastProbeAt) || null,
            };
        });

        // 排序：问题格在前（isolated > degraded > active > healthy > unknown），同档按 id。
        var order = { isolated: 0, degraded: 1, active: 2, healthy: 3, unknown: 4 };
        cells.sort(function (a, b) {
            var d = order[a.status] - order[b.status];
            return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
        });

        var recentHook = input.recentHook || null;
        var agents = Array.isArray(input.agents) ? input.agents : [];

        // unavailable：**当前这批数据里**没有任何值的字段（页面据此画「—」并标注原因）。
        var unavailable = [];
        if (cells.length && cells.every(function (x) { return x.latencyMs === null; })) { unavailable.push('latencyMs'); }
        if (!recentHook) { unavailable.push('recentHook'); }

        return {
            cells: cells,
            generatedAt: input.generatedAt || new Date().toISOString(),
            recentHook: recentHook,
            agents: agents,
            unavailable: unavailable,
        };
    }

    return { STATUS: STATUS, buildFloorCells: buildFloorCells, numOrNull: numOrNull };
}));
