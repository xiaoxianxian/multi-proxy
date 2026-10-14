// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// relay-ledger.js —— L2 编排「agent 间接力开销」账本（P2 观测件，2026-10-13）
//
// 为什么要有这个账本：
//   L2 编排里 agent 之间今天传 JSON（L2-BLUEPRINT.md:319-327 §6.1 三种文本信道），
//   每一跳都是一次完整的 prompt/completion 往返。外部研究（RecursiveMAS，arXiv
//   2604.25917v2 / NeurIPS 2026）给出量化证据：多智能体间接力靠文本是最贵的一环
//   ——r=3 时文本递归 MAS 的 output token 比隐空间交互高 75.6%。
//   multi-proxy 不可能走它的路线（API 层黑盒代理拿不到隐状态 + 铁律「不自训模型」），
//   但必须先有自己的数：**间接力开销到底集中在哪一跳**，然后才谈得上优化。
//   这个账本只回答「钱花在接力上」这一个问题，不做路由决策、不触热路径。
//
// 非侵入铁律（与 l2/ 其它内核同构）：
//   - 门控 PROXY_L2_RELAY_LEDGER 默认关 = 全 no-op（Orchestrator 不注入即零行为变更）；
//   - 零依赖（仅 node 内置）；纯函数优先（extractUsage / summarize 可单测）；
//   - 仅内存环形缓冲，默认不落盘（落盘形态留二期，与 savings-gateway 一期同纪律）；
//   - 诚实优先：拿不到 usage 的跳（shadow / h3web 任务队列 / 发现调用 / 自定义 executor）
//     **照实记 usageFound=false**，绝不填 0 冒充「没花 token」——账本里少一个数可以，
//     多一个假数不行（同 savings-gateway C0-3「假成本数字」纪律）。
//
// usage 来源链（照实读 executor-bind.js 返回形状，不臆造）：
//   Orchestrator executor 返回值（executor-bind.js:248）= { adapterId, bound, kind, ...,
//     raw: adapterInvokeResult }                     // adapter 的 return
//   adapterInvokeResult.result.raw = 上游 OpenAI 兼容响应 parsed 体（l1-agent-adapter.js:255）
//   → usage 在 value.raw.result.raw.usage（{ prompt_tokens, completion_tokens, total_tokens }）
//   另兼容两种形态：executor 直接挂 value.usage；OpenAI snake_case 字段原样读。

const GATE_ENV = 'PROXY_L2_RELAY_LEDGER';

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * 纯函数：从 executor 返回值里挖 usage。挖不到返回 null（不猜、不填 0）。
 *
 * 已核实的三条来路（2026-10-13 读码坐实）：
 *   ① value.raw.result.raw.usage —— executor-bind + l1-agent-adapter 真实链路
 *      （l1-agent-adapter.js:255 `raw: parsed.raw ? undefined : parsed`，usage 随 parsed 带回）；
 *   ② value.usage —— 调用方/未来 adapter 直接挂（forward executor 已带 usage，见
 *      savings-gateway.js:476 `const usage = parsed && parsed.usage`）；
 *   ③ value.raw.usage —— adapter 层直接挂。
 *
 * @returns {{promptTokens:number, completionTokens:number, totalTokens:number}|null}
 */
function extractUsage(value) {
    if (!value || typeof value !== 'object') return null;
    const candidates = [];
    // ① 主链：executor-bind 包装 → adapter return → 上游 parsed 响应
    const adapterResult = value.raw;
    if (adapterResult && typeof adapterResult === 'object') {
        if (adapterResult.result && typeof adapterResult.result === 'object') {
            candidates.push(adapterResult.result.raw);
            candidates.push(adapterResult.result);
        }
        candidates.push(adapterResult);
    }
    // ②③ 直挂形态
    candidates.push(value);

    for (const c of candidates) {
        if (!c || typeof c !== 'object') continue;
        const u = c.usage;
        if (u && typeof u === 'object' &&
            (u.prompt_tokens != null || u.completion_tokens != null)) {
            const promptTokens = num(u.prompt_tokens);
            const completionTokens = num(u.completion_tokens);
            const totalTokens = u.total_tokens != null
                ? num(u.total_tokens)
                : promptTokens + completionTokens;
            return { promptTokens, completionTokens, totalTokens };
        }
    }
    return null;
}

/**
 * 纯函数：一组 hop 记录 → 汇总报告。
 * 关键诚实字段：usageFound / usageMissing —— 挖不到 usage 的跳单列，
 * 免得「总 token 数」被读成「全部开销」（shadow 跑一轮也是 0 token，不是免费）。
 */
function summarize(hops) {
    const rows = Array.isArray(hops) ? hops.filter((h) => h && typeof h === 'object') : [];
    let totalTokens = 0, promptTokens = 0, completionTokens = 0;
    let usageFound = 0, usageMissing = 0, shadowHops = 0;
    const perAdapter = {};
    for (const h of rows) {
        if (h.usageFound) {
            usageFound += 1;
            promptTokens += num(h.promptTokens);
            completionTokens += num(h.completionTokens);
            totalTokens += num(h.totalTokens);
        } else {
            usageMissing += 1;
        }
        if (h.shadow) shadowHops += 1;
        const key = h.adapterId || '<unknown>';
        const row = perAdapter[key] || { hops: 0, usageFound: 0, tokens: 0 };
        row.hops += 1;
        if (h.usageFound) { row.usageFound += 1; row.tokens += num(h.totalTokens); }
        perAdapter[key] = row;
    }
    // relayRatio：全部跳的 token / 最后一跳的 token。>1 的部分就是「为接力多付的」；
    // =1 = 单跳/无中间接力（基线，不是缺失）；仅当有 usage 的最后一跳取不到（分母为 0/缺失）时 null。
    let finalHopTokens = null;
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].usageFound) { finalHopTokens = num(rows[i].totalTokens); break; }
    }
    const relayRatio = (finalHopTokens && finalHopTokens > 0)
        ? Math.round((totalTokens / finalHopTokens) * 1000) / 1000
        : null;
    const topHops = rows
        .filter((h) => h.usageFound)
        .slice()
        .sort((a, b) => num(b.totalTokens) - num(a.totalTokens))
        .slice(0, 10)
        .map((h) => ({ subtaskId: h.subtaskId, adapterId: h.adapterId, totalTokens: num(h.totalTokens) }));
    return {
        hopCount: rows.length,
        usageFound,
        usageMissing,
        shadowHops,
        promptTokens,
        completionTokens,
        totalTokens,
        perAdapter,
        finalHopTokens,
        relayRatio,
        topHops,
    };
}

// 工厂：每实例独立 store（测试隔离），与 l2 其它内核同构
function createRelayLedger(opts = {}) {
    const capacity = Number.isFinite(opts.logCapacity) ? opts.logCapacity : 1000;
    const hops = [];

    function record(entry) {
        if (!entry || typeof entry !== 'object') return null;
        const usage = extractUsage(entry.value);
        const hop = {
            ts: entry.ts != null ? entry.ts : Date.now(),
            runId: entry.runId != null ? String(entry.runId) : null,
            subtaskId: entry.subtaskId != null ? String(entry.subtaskId) : null,
            adapterId: entry.adapterId != null ? String(entry.adapterId) : null,
            tier: entry.tier != null ? String(entry.tier) : null,
            attempts: num(entry.attempts) || 1,
            viaFallback: entry.viaFallback != null ? String(entry.viaFallback) : null,
            shadow: !!entry.shadow,
            usageFound: !!usage,
            promptTokens: usage ? usage.promptTokens : null,
            completionTokens: usage ? usage.completionTokens : null,
            totalTokens: usage ? usage.totalTokens : null,
        };
        hops.push(hop);
        if (hops.length > capacity) hops.splice(0, hops.length - capacity);
        return hop;
    }

    function report(runId) {
        const rows = runId != null ? hops.filter((h) => h.runId === String(runId)) : hops;
        return summarize(rows);
    }

    function getHops(runId) {
        return runId != null ? hops.filter((h) => h.runId === String(runId)) : hops.slice();
    }

    return { record, report, getHops, summarize, size: () => hops.length };
}

const _ledger = createRelayLedger();
module.exports = {
    GATE_ENV,
    gateOpen,
    extractUsage,
    summarize,
    createRelayLedger,
    // 单例转发（进程级常驻账本；生产经 routes/orchestration.js 注入同一个实例）
    record: _ledger.record,
    report: _ledger.report,
    getHops: _ledger.getHops,
};
