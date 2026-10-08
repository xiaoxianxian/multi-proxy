// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 成本预警 watchdog + 自动降级（task1 二期 · 省钱网关 v2 · l2/savings-gateway/）
// 职责：在一期「难度路由省钱 + 算省账」之上，加一层**有状态**的成本预警——
//   累计成本（滑动窗口）越过 warn/critical 阈值即告警，并**推荐自动降级到更便宜档位**，
//   把 alert.js 的单阈值 cost-budget-exceeded 升级成「多档 + 自动动作」的闭环。
//
// 非侵入铁律（与 alert.js / cost.js / gateway.js 同构，l2/ 统一范式）：
//   - 信号源无关：消费抽象的「省账条目」（{ts, actualCost, actualTier, promptTokens, completionTokens}，
//     即一期 gateway.getSavingsLog() 的产出）。不 require 任何 manager lib / 不触热路径。
//   - 门控 PROXY_COST_WATCH 默认关 = observe（累计/判级/降级推荐照常进内存、绝不落盘、不真发）；
//     开(=1/true/on) = 可 best-effort 落盘 watch-alarm.jsonl（目录可注入，默认不写 home 以外）。
//   - shadow / 门控默认关：不真调上游、不真发告警；降级只是「推荐」，是否落地由调用方/操作员决定。
//   - 内核不往 process.env 注入任何键（与 gateway.js / alert.js 一致）。
//   - 零第三方依赖：node 内置 http/fs/os/path。
//
// 为什么这 1 个最稳（见 PHASE2-SPEC.md §三）：零热路径 + 复用 alert.js 既有契约 + 直接闭合
// 「一期只喂单阈值信号、无状态、无自动动作」的缺口。模型降级（cheaper fallback）已被「降级推荐」覆盖；
// 热迁移需 executor 真执行缝、agent 适配层属独立模块——均留后续。
//
// alert.js 契约对齐：produceAlertSignal() === { source:'cost', providerId, cost, budget }
//   —— 与 gateway.produceCostSignal / cost.js 完全一致，alert.js cost-budget-exceeded 直接接管。
//   注：alert.js 仅单档 severity=warning；watchdog 的 warn/critical 多档 + 降级推荐为其上层（非侵入边界）。

const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const GATE_ENV = 'PROXY_COST_WATCH';
const DEFAULT_ALARM_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'cost-watch-alarm.jsonl');

// 成本梯度（cheap→expensive），镜像 gateway.js DEFAULT_PRICING：small=免费 / medium=deepseek ¥1/¥4 / large=云端 ¥32/¥128
const TIER_ORDER = ['small', 'medium', 'large'];
const TIER_PRICING = {
    small:  { input: 0, output: 0 },
    medium: { input: 1, output: 4 },
    large:  { input: 32, output: 128 },
};

// tier → 对应 complexity（降级落地时「操作员把下一请求按推荐档位重发」的翻译；gateway 按 complexity 路由）
const TIER_COMPLEXITY = { small: 'low', medium: 'medium', large: 'high' };

const DEFAULT_CONFIG = {
    warnBudget: 0,          // CNY；>0 才启用 warn 档（=0 不告警，与 alert.js「不设预算不触发」同义，YAGNI）
    criticalBudget: 0,      // CNY；>0 才启用 critical 档
    hardCap: 0,             // CNY；>0 才启用 hard cap（G1 到限暂停/拒绝；=0 不拦，YAGNI）
    alertRatios: [0.8, 0.95], // G2：累计达 hardCap 的该比例时发告警（仅 hardCap>0 生效）；空数组=不发
    alertWebhook: '',       // G2：告警 webhook（http/https POST JSON），非空才发；默认不发（YAGNI）
    windowMs: 0,            // 0 = 全时累计；>0 = 滑动窗口
    cooldownMs: 0,          // 0 = 不复用去重（每次越级都 fire）；>0 = 同 level 窗口内只 fire 一次
    logCapacity: 1000,      // alarms[] 环形裁剪上限
    providerId: 'savings-gateway',
    currency: 'CNY',
};

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const coerceNum = (n) => { const v = parseFloat(n); return Number.isFinite(v) ? v : 0; };

// G2：告警 webhook best-effort POST（http/https 均可，fire-and-forget，超时即弃；non-fatal）
function postWebhook(urlStr, payload) {
    try {
        const u = new URL(urlStr);
        const mod = u.protocol === 'https:' ? https : http;
        const body = JSON.stringify(payload);
        const req = mod.request(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, () => {});
        req.on('error', () => {});
        req.setTimeout(2000, () => req.destroy());
        req.write(body);
        req.end();
    } catch { /* non-fatal，告警投递失败不影响主流程 */ }
}

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}
function observeOnly() { return !gateOpen(); }

// cheaper 档位（成本梯度降一档；floor=small 返回 null）
function cheaperTier(tier) {
    const i = TIER_ORDER.indexOf(tier);
    if (i <= 0) return null;   // 已是最低档，无可降
    return TIER_ORDER[i - 1];
}
// 单档位给定 token 数的成本（CNY）—— 用项目基线价表（与 gateway.js 同表）
function tierCost(tier, promptTokens, completionTokens) {
    const p = TIER_PRICING[tier] || TIER_PRICING.large;
    return (coerceNum(promptTokens) / 1e6) * p.input + (coerceNum(completionTokens) / 1e6) * p.output;
}

// 工厂：每实例独立 store（测试隔离），与 l2 其它内核同构
function createCostWatchdog(opts = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(opts.config || opts) };
    // 允许用 env 覆盖 warn/critical 预算（镜像 gateway.js 的 pricing 注入约定，但不注入 env）
    if (process.env.PROXY_COST_WARN_BUDGET != null && process.env.PROXY_COST_WARN_BUDGET !== '') {
        const b = parseFloat(process.env.PROXY_COST_WARN_BUDGET); if (Number.isFinite(b)) cfg.warnBudget = b;
    }
    if (process.env.PROXY_COST_CRITICAL_BUDGET != null && process.env.PROXY_COST_CRITICAL_BUDGET !== '') {
        const b = parseFloat(process.env.PROXY_COST_CRITICAL_BUDGET); if (Number.isFinite(b)) cfg.criticalBudget = b;
    }
    if (process.env.PROXY_COST_HARDCAP != null && process.env.PROXY_COST_HARDCAP !== '') {
        const b = parseFloat(process.env.PROXY_COST_HARDCAP); if (Number.isFinite(b)) cfg.hardCap = b;
    }
    if (process.env.PROXY_COST_ALERT_WEBHOOK != null && process.env.PROXY_COST_ALERT_WEBHOOK !== '') {
        cfg.alertWebhook = process.env.PROXY_COST_ALERT_WEBHOOK;
    }
    const activeFile = typeof opts.alarmFile === 'string' ? opts.alarmFile : DEFAULT_ALARM_FILE;

    const alarms = [];            // 已判级的越级事件（环形），供观测 / 落盘
    const lastEmit = {};          // level -> ts（cooldown 去重）
    const firedRatios = new Set(); // G2：已触发的阈值档（回落到阈值以下自动 re-arm）
    let firedCount = 0;
    let dedupedCount = 0;

    function windowCutoff(now) {
        return cfg.windowMs > 0 ? now - cfg.windowMs : 0;
    }
    // 滑动窗口内累计 actualCost（CNY）
    function cumulative(now) {
        const cutoff = windowCutoff(now);
        let sum = 0;
        for (const e of alarms_src()) {   // 累计的是「原始省账条目」，非 alarms[]
            if (e.ts < cutoff) continue;
            sum += coerceNum(e.actualCost);
        }
        return sum;
    }
    // 原始省账条目缓冲（窗口累计的数据源；环形裁剪）
    const _entries = [];
    function alarms_src() { return _entries; }
    function pushEntry(entry, now) {
        const ts = entry && entry.ts != null ? entry.ts : (now ?? Date.now());
        _entries.push({ ...entry, ts });
        if (_entries.length > cfg.logCapacity) _entries = _entries.slice(-cfg.logCapacity);
    }

    // 核心：判级 + 降级推荐 + 去重。entry = 一期一条省账；返回丰富结果。
    // 越级时：level='warn'/'critical'，downgradeTo=更便宜档，perReqSaving=若按推荐档打的单请求省钱，
    //   alert=喂 alert.js 的 cost 信号（仅当 fire、未去重时附带）；同 level 在 cooldown 内 deduped=true 不再 fire。
    function decide(entry, io = {}) {
        const now = io.now != null ? io.now : (entry && entry.ts != null ? entry.ts : Date.now());
        const cost = cumulative(now);
        let level = 'ok';
        if (cfg.hardCap > 0 && cost >= cfg.hardCap) level = 'blocked';
        else if (cfg.criticalBudget > 0 && cost >= cfg.criticalBudget) level = 'critical';
        else if (cfg.warnBudget > 0 && cost >= cfg.warnBudget) level = 'warn';
        const breached = level !== 'ok';
        const block = level === 'blocked';
        const fromTier = entry && entry.actualTier;
        const downgradeTo = (breached && !block) ? cheaperTier(fromTier) : null;

        let deduped = false;
        let fired = false;
        if (breached) {
            const last = lastEmit[level];
            if (cfg.cooldownMs > 0 && last != null && (now - last) <= cfg.cooldownMs) {
                deduped = true;          // 冷却期内：登记但不再 fire
                dedupedCount++;
            } else {
                lastEmit[level] = now;   // 首次 / 过冷却：fire
                fired = true;
                firedCount++;
            }
        }

        const pTok = entry ? coerceNum(entry.promptTokens) : 0;
        const cTok = entry ? coerceNum(entry.completionTokens) : 0;
        const perReqSaving = (breached && downgradeTo)
            ? round6(tierCost(fromTier, pTok, cTok) - tierCost(downgradeTo, pTok, cTok))
            : 0;

        // G2：累计达 hardCap 的 alertRatios 比例时发阈值告警（事件型，每档只 fire 一次；回落到阈值以下自动 re-arm）
        const thresholdAlerts = [];
        if (cfg.hardCap > 0 && Array.isArray(cfg.alertRatios) && cfg.alertRatios.length) {
            for (const r of cfg.alertRatios) {
                const thr = cfg.hardCap * r;
                const key = String(r);
                const crossed = cost >= thr;
                if (crossed && !firedRatios.has(key)) {
                    firedRatios.add(key);
                    thresholdAlerts.push({
                        ratio: r,
                        level: 'warn' + Math.round(r * 100),
                        threshold: round6(thr),
                        message: `累计成本达 hardCap 的 ${Math.round(r * 100)}%（¥${round6(thr)} / ¥${cfg.hardCap}）`,
                    });
                } else if (!crossed && firedRatios.has(key)) {
                    firedRatios.delete(key);   // re-arm：窗口重置 / 成本回落后可再次告警
                }
            }
        }
        if (thresholdAlerts.length) {
            for (const a of thresholdAlerts) {
                if (cfg.alertWebhook) postWebhook(cfg.alertWebhook, { ...a, cumulative: round6(cost), providerId: cfg.providerId, currency: cfg.currency });
                if (!observeOnly()) persist({ ts: now, type: 'threshold-alert', ...a, cumulative: round6(cost), providerId: cfg.providerId });
            }
        }

        const result = {
            ts: now,
            cumulative: round6(cost),
            level,
            breached,
            fromTier,
            downgradeTo,
            block,
            downgradedComplexity: downgradeTo ? TIER_COMPLEXITY[downgradeTo] : null,  // 操作员按此 complexity 重发即落地
            perReqSaving,
            thresholdAlerts,
            deduped,
            fired,
            action: block ? 'block' : (breached ? (downgradeTo ? 'downgrade' : 'hold-floor') : 'hold'),
            warnBudget: cfg.warnBudget,
            criticalBudget: cfg.criticalBudget,
        };

        // 仅 fire（非去重）时产出 alert.js 兼容信号（多档阈值；warn→warnBudget / critical→criticalBudget）
        if (breached && fired) {
            result.alert = {
                source: 'cost',
                providerId: cfg.providerId,
                cost: round6(cost),
                budget: level === 'blocked' ? cfg.hardCap : (level === 'critical' ? cfg.criticalBudget : cfg.warnBudget),
                level,
                fromTier,
                downgradeTo,
                currency: cfg.currency,
            };
        }

        // 登记越级事件（火或去重都记录进 alarms[]，供观测/落盘）
        if (breached) {
            alarms.push({ ...result, rawEntry: entry });
            if (alarms.length > cfg.logCapacity) alarms = alarms.slice(-cfg.logCapacity);
        }

        if (!observeOnly()) persist({ ...result, alarms: alarms.length });
        return result;
    }

    // 喂一条原始省账并立即判级（一期 getSavingsLog() 条目 → 直接喂）
    function record(entry, io = {}) {
        const now = io.now != null ? io.now : (entry && entry.ts != null ? entry.ts : Date.now());
        pushEntry(entry, now);
        return decide(entry, io);
    }

    // 当前快照（不判级、不产 alert，纯观测）
    function state(io = {}) {
        const now = io.now != null ? io.now : Date.now();
        const cost = cumulative(now);
        let level = 'ok';
        if (cfg.hardCap > 0 && cost >= cfg.hardCap) level = 'blocked';
        else if (cfg.criticalBudget > 0 && cost >= cfg.criticalBudget) level = 'critical';
        else if (cfg.warnBudget > 0 && cost >= cfg.warnBudget) level = 'warn';
        return {
            cumulative: round6(cost),
            level,
            block: level === 'blocked',
            breached: level !== 'ok',
            firedCount,
            dedupedCount,
            alarmCount: alarms.length,
            firedRatiosCount: firedRatios.size,
            activeDowngrade: level === 'ok' ? null : cheaperTier(alarms.length ? alarms[alarms.length - 1].fromTier : null),
            windowMs: cfg.windowMs,
            shadow: gateOpen(),     // observe/serve 语义（门控关=shadow 观测，不真发/不落）
            gateOpen: gateOpen(),
            hardCap: cfg.hardCap,
            currency: cfg.currency,
        };
    }

    // 喂 alert.js 的 cost 信号（取最新累计；budget 取当前越级档阈值，未越级则不带 budget=不告警，YAGNI）
    function produceAlertSignal(io = {}) {
        const now = io.now != null ? io.now : Date.now();
        const cost = round6(cumulative(now));
        let level = 'ok';
        if (cfg.hardCap > 0 && cost >= cfg.hardCap) level = 'blocked';
        else if (cfg.criticalBudget > 0 && cost >= cfg.criticalBudget) level = 'critical';
        else if (cfg.warnBudget > 0 && cost >= cfg.warnBudget) level = 'warn';
        const sig = { source: 'cost', providerId: cfg.providerId, cost };
        if (level !== 'ok') {
            sig.budget = level === 'blocked' ? cfg.hardCap : (level === 'critical' ? cfg.criticalBudget : cfg.warnBudget);
            sig.level = level;
            sig.block = level === 'blocked';
        }
        return sig;
    }

    // 报告（窗口内累计 + 越级计数 + 降级命中统计）
    function report(io = {}) {
        const now = io.now != null ? io.now : Date.now();
        const cutoff = windowCutoff(now);
        const inWin = alarms.filter((a) => a.ts >= cutoff);
        let downgradedRequests = 0, totalPerReqSaving = 0;
        for (const a of inWin) {
            if (a.downgradeTo) { downgradedRequests++; totalPerReqSaving += a.perReqSaving || 0; }
        }
        return {
            windowMs: cfg.windowMs || 0,
            generatedAt: now,
            currency: cfg.currency,
            cumulative: round6(cumulative(now)),
            level: (() => { let l = 'ok'; const c = cumulative(now);
                if (cfg.hardCap > 0 && c >= cfg.hardCap) l = 'blocked';
                else if (cfg.criticalBudget > 0 && c >= cfg.criticalBudget) l = 'critical';
                else if (cfg.warnBudget > 0 && c >= cfg.warnBudget) l = 'warn'; return l; })(),
            alarmsFired: firedCount,
            alarmsDeduped: dedupedCount,
            downgradedRequests,
            estDowngradeSaving: round6(totalPerReqSaving),
            warnBudget: cfg.warnBudget,
            criticalBudget: cfg.criticalBudget,
            hardCap: cfg.hardCap,
            alertRatios: cfg.alertRatios,
            firedRatiosCount: firedRatios.size,
            gateOpen: gateOpen(),
        };
    }

    // 落盘（仅门控开；best-effort，镜像 alert.js / cost.js——observe 默认绝不写盘）
    function persist(rec) {
        try {
            const fs = require('fs');
            const dir = path.dirname(activeFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(activeFile, JSON.stringify({ ts: rec.ts, ...rec }) + '\n');
        } catch { /* non-fatal, best-effort */ }
    }

    return {
        record,            // 喂一条省账 + 判级 + 降级推荐（主入口）
        decide,            // 纯判级（不缓冲，给已有序列重算用）
        state,             // 当前快照
        produceAlertSignal, // 喂 alert.js（cost-budget-exceeded 契约）
        report,            // 窗口报告
        getAlarms: (n) => alarms.slice(-(n || 50)),
        getEntries: () => _entries.slice(),
        cheaperTier,
        tierCost,
        gateOpen,          // 实例级转发门控查询（demo/调用方观测用）
        observeOnly,
        _config: cfg,
        _firedCount: () => firedCount,
        _dedupedCount: () => dedupedCount,
    };
}

// ---- 模块级单例（持久 store，与 alert.js/cost.js 同构）----
const _wd = createCostWatchdog();
module.exports = {
    GATE_ENV,
    TIER_ORDER,
    TIER_PRICING,
    TIER_COMPLEXITY,
    DEFAULT_CONFIG,
    DEFAULT_ALARM_FILE,
    createCostWatchdog,
    cheaperTier,
    tierCost,
    gateOpen,
    observeOnly,
    // 单例转发
    record: _wd.record,
    state: _wd.state,
    produceAlertSignal: _wd.produceAlertSignal,
    report: _wd.report,
    getAlarms: _wd.getAlarms,
};
