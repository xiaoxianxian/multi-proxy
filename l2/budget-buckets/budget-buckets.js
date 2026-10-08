// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// G3：per-agent / per-project 预算作用域（task1 二期 · 省钱网关 v3 · l2/budget-buckets/）
// 职责：在 G1（全局硬上限）+ G2（阈值告警）之上，按 caller / tenant / project 分桶隔离预算，
//   让单个失控 agent 不能耗尽全局预算——每个桶独立累计、独立判级、独立到限暂停（block）。
//
// 非侵入铁律（与 cost-watchdog / gateway 同构，l2/ 统一范式）：
//   - 零重复实现：每个桶就是 1 个 createCostWatchdog 实例，直接复用 G1+G2 的全部语义。
//   - 门控 PROXY_COST_BUCKETS 默认关 = 仅观测（路由 / 累计 / 判级照常，不拦、不落盘、不真发）。
//   - 默认只建一个 'default' 桶（hardCap=0 不拦），零行为变更；配了 buckets 才分桶隔离。
//   - 未知 caller（agentId/callerId/tenant/project 都没命中已配桶）落入 default 桶 ——
//     fail-safe：被全局默认硬上限兜住，不单独放行，也不因未知身份而报错中断主流程。
//   - 不直接 touch 主代理热路径（forward.js / codex-proxy）；接入方按 shouldBlock(bucketId) 在请求前判拦即可。
//
// Paperclip 参照：公司 / agent / 项目 三级预算。本模块把"三级"抽象成"任意命名桶 + 一个兜底桶"，
//   既覆盖 agent 级，也覆盖 project / tenant 级，不写死层级（YAGNI：不预先造用不上的 org 树）。

const W = require('../savings-gateway/cost-watchdog.js');

const GATE_ENV = 'PROXY_COST_BUCKETS';
const DEFAULT_BUCKET = 'default';

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const LEVEL_RANK = { ok: 0, warn: 1, critical: 2, blocked: 3 };

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

// 工厂：每实例独立桶表（测试隔离），与 l2 其它内核同构
function createBudgetBuckets(opts = {}) {
    const cfg = opts.config || opts || {};
    const defaultCfg = cfg.default || {};
    const named = (typeof cfg.buckets === 'object' && cfg.buckets) ? cfg.buckets : {};

    // 兜底桶永远存在；不传 default 时其 hardCap=0（不拦，零行为变更）
    const buckets = {};
    buckets[DEFAULT_BUCKET] = W.createCostWatchdog({ config: { ...defaultCfg } });
    for (const [name, bc] of Object.entries(named)) {
        if (name === DEFAULT_BUCKET) continue;        // 不允许覆盖 default 语义
        buckets[name] = W.createCostWatchdog({ config: { ...bc } });
    }

    // 解析桶 id：优先 entry 显式标签，命中已配桶才用，否则默认兜底
    function resolveBucketId(entry) {
        const id = entry && (entry.bucketId || entry.agentId || entry.callerId || entry.tenant || entry.project);
        return (id != null && buckets[id]) ? id : DEFAULT_BUCKET;
    }

    // 喂一条省账并判级（路由到对应桶）
    function record(entry, io = {}) {
        const bid = resolveBucketId(entry);
        const r = buckets[bid].record(entry, io);
        return { bucketId: bid, ...r };
    }

    // 纯判级（不缓冲）
    function decide(entry, io = {}) {
        const bid = resolveBucketId(entry);
        const r = buckets[bid].decide(entry, io);
        return { bucketId: bid, ...r };
    }

    // 请求前判拦：给定 caller 所在桶是否命中 block（接入方热路径调用）
    function shouldBlock(entry, io = {}) {
        const bid = resolveBucketId(entry);
        return buckets[bid].state(io).block === true;
    }

    // 当前快照：每桶独立 + 全局聚合
    function state(io = {}) {
        const per = {};
        let aggCumulative = 0;
        let aggLevel = 'ok';
        for (const [name, wd] of Object.entries(buckets)) {
            const s = wd.state(io);
            per[name] = s;
            aggCumulative += s.cumulative;
            if (LEVEL_RANK[s.level] > LEVEL_RANK[aggLevel]) aggLevel = s.level;
        }
        return {
            per,
            aggregate: {
                cumulative: round6(aggCumulative),
                level: aggLevel,
                block: aggLevel === 'blocked',
            },
            gateOpen: gateOpen(),
            bucketCount: Object.keys(buckets).length,
        };
    }

    // 喂 alert.js 的 cost 信号：取最严重桶的信号（多桶取 rank 最高）
    function produceAlertSignal(io = {}) {
        let worst = null;
        for (const wd of Object.values(buckets)) {
            const sig = wd.produceAlertSignal(io);
            if (sig.level != null && (!worst || LEVEL_RANK[sig.level] > LEVEL_RANK[worst.level])) worst = sig;
        }
        return worst || { source: 'cost', providerId: 'budget-buckets', cost: 0 };
    }

    return {
        record,
        decide,
        state,
        shouldBlock,
        produceAlertSignal,
        resolveBucketId,
        getBucket: (name) => buckets[name],
        gateOpen,
        _buckets: buckets,
    };
}

module.exports = {
    GATE_ENV,
    DEFAULT_BUCKET,
    createBudgetBuckets,
    gateOpen,
};
