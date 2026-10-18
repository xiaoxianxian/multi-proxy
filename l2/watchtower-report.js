// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * watchtower-report · 「上周花了多少 / 省了多少」只读周报（纯函数，零依赖）
 *
 * 为什么要有这个文件（2026-10-16，对照 navige.ai Watchtower 后立项）：
 *
 *   multi-proxy 的 `lib/cost-track.js` 有 713 行——三模型字段、持久账本、幂等去重、
 *   分时价表全齐。**但数据只有一个读口：`/api/floor`**（开发者盘面，画格子的）。
 *   dashboard 的「成本」页只有 provider 余额 + 预算判级；账本里躺着的
 *   「上周烧了多少、模型重写省了多少」**没有任何地方算出来过**。
 *
 *   这就是 Navige Watchtower 打的位置：$0 永久免费只读层，每周告诉你
 *   「上周花 $242、能省 $41」，附逐 agent 明细——**先让你看见钱，再开省钱开关**。
 *
 * 🔴 我们不做「能省多少」的估算（v1 明确不做）：
 *   Navige 官网自己在估算器下面写死 `An estimate, not a savings claim`。
 *   抄一个自己都不承诺的东西没有意义。本模块只报**可回源的事实**：
 *     ① 实际花费  —— 账本行内冻结的 cost 直接求和（含价表变动也不漂）。
 *     ② 已省花费  —— 模型重写的差额：账本同时记了 `model`（实际计费模型）与
 *                     `requestModel`（宿主要的），两个都能在价表里查到价时，
 *                     差额就是「路由已经省下的」。配不齐 → null，页面画「—」。
 *     ③ 零花费占比 —— cost=0 的请求占比（本地模型 / 免费额度 / 未配单价三种都可能，
 *                     所以只报事实、不归因，见 caveats）。
 *
 * 设计纪律（与 l2/floor-view.js 同一套）：
 *   - 纯函数、零依赖：不 require 任何东西、不读盘、不碰 localStorage。
 *   - 浏览器 `<script src="./watchtower-report.js">` → `window.Watchtower`；
 *     Node `require('./watchtower-report.js')` → 同名 API。
 *   - 🔴 诚实口径：拿不到就 `null`，渲染层画「—」，**绝不折算成 0**。
 *     0 会被读成「没花钱 / 没省下」，那是假数据。同 floor-view 的 `numOrNull`。
 *
 * 跑法：node --test l2/tests/watchtower-report.test.js
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) { module.exports = api; }
    else { root.Watchtower = api; }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 与 lib/cost-track.js 同源：缺模型名时叫 <unknown>，绝不猜模型名。
    var UNKNOWN = '<unknown>';
    var DEFAULT_TZ = 'Asia/Shanghai';

    // 默认回看窗口（天）。Navige 是周报，我们也按周。
    var DEFAULT_DAYS = 7;

    function numOrNull(v) {
        return (typeof v === 'number' && isFinite(v)) ? v : null;
    }

    function str(v, fallback) {
        return (typeof v === 'string' && v.length > 0) ? v : (fallback === undefined ? null : fallback);
    }

    /**
     * 取模型名，但把 `<unknown>` 当「没有」。
     *
     * 为什么必须特殊处理：lib/cost-track.js 拿不到模型名时**不置空，而是填 `<unknown>`**
     * （见那个文件的 UNKNOWN 常量）。直接当字符串用会出两种错：
     *   ① 反事实对比时拿 '<unknown>' 去价表里查价 → 必然查不到 → 报一句
     *      「价表里没有 <unknown> 的单价」，把「没上报模型名」误导成「价表没配全」；
     *   ② byModel 拆账里多出一个叫 `<unknown>` 的假模型，还常常是花费最高的那一行。
     * 所以 `<unknown>` 一律归一成 null，让上层走「缺字段」的分支，理由说得准。
     */
    function modelOf(v) {
        var s = str(v);
        return (s === null || s === UNKNOWN) ? null : s;
    }

    /**
     * 判断一个字段是不是 `<unknown>` 哨兵值——给「要数它」的路径用（dataQuality 计量）。
     * 与 modelOf 的分工：modelOf 服务「要用这个值」的场景（归一成 null 走缺字段分支），
     * isUnknown 服务「要数它有多少」的场景。两者必须同源，否则一边修一边数错。
     */
    function isUnknown(v) {
        return str(v) === UNKNOWN;
    }

    /**
     * 本地时区日期键（2026-10-16 由 UTC 改成本地）。
     *
     * 为什么改：过去窗口边界和每条记录的日期全部按 UTC 算。中国用户按北京时间
     * 理解「上周」，UTC 口径下 23:00–24:00 的请求会被算进前一天——「上周账单」
     * 的边界因此差一天，而此前界面上没有任何提示（只在 renderText 印了「UTC 日期」）。
     *
     * tz 由调用方传入（默认 Asia/Shanghai）：本文件是零依赖 Node/浏览器双用纯函数，
     * 不直接读 process.env。route / CLI 负责把 PROXY_COST_TZ 传进来。
     *
     * 坏 ts → null（不猜日期）；时区名无效 → 回退 UTC（Intl 会抛，接住即可，
     * 不因为一个配错的时区名让整份周报生不出来）。
     */
    function dayOf(ts, tz) {
        var ms = (typeof ts === 'number') ? ts
               : (typeof ts === 'string' ? Date.parse(ts) : NaN);
        if (!isFinite(ms)) return null;
        var zone = (typeof tz === 'string' && tz) ? tz : DEFAULT_TZ;
        try {
            // en-CA 的 DateTimeFormat 产出 YYYY-MM-DD（ISO 顺序），正好当日期键用。
            return new Intl.DateTimeFormat('en-CA', {
                timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date(ms));
        } catch (e) {
            return new Date(ms).toISOString().slice(0, 10);
        }
    }

    /**
     * 一条账本记录的日期归属：**优先用落账时写好的 localDay**。
     * 存量行（2026-10-16 之前落的账）没有这个字段 → fallback 到按 ts 现算。
     * 为什么不总是现算：落账时刻和读周报时刻之间若发生过时区配置变更，
     * 现算会让同一行的日期前后不一致；行内冻结的值更诚实。
     */
    function recordDayOf(rec, tz) {
        var ld = str(rec.localDay);
        if (ld !== null && /^\d{4}-\d{2}-\d{2}$/.test(ld)) return ld;
        return dayOf(rec.ts, tz);
    }

    /**
     * 从价表取某个模型某一类的单价（每百万 tokens）。
     * pricing 形状：{ modelName: { input, output, cacheHit } }（lib/cost-track.getPricingTable() 的产出）。
     * 取不到 → null（**不是 0**——0 会被读成「这个模型免费」）。
     */
    function priceOf(pricing, model, kind) {
        if (!pricing || typeof pricing !== 'object') return null;
        var row = pricing[model];
        if (!row || typeof row !== 'object') return null;
        return numOrNull(row[kind]);
    }

    /**
     * 用「另一套价」重算一条请求的花费（每百万 tokens 单价 → 元）。
     * tokens 全部取不到时返回 null，绝不按 0 tokens 算成 0 元。
     */
    function recompute(entry, pricing, modelField) {
        var model = modelOf(entry[modelField]);
        if (!model) return null;
        var pIn = priceOf(pricing, model, 'input');
        var pOut = priceOf(pricing, model, 'output');
        var pCache = priceOf(pricing, model, 'cacheHit');
        // 三样单价一个都没有 → 这个模型完全没进价表，判为「配不齐」而不是「免费」。
        if (pIn === null && pOut === null && pCache === null) return null;
        var prompt = numOrNull(entry.prompt) || 0;
        var completion = numOrNull(entry.completion) || 0;
        var cacheHit = numOrNull(entry.cacheHit) || 0;
        var v = (prompt * (pIn || 0) + completion * (pOut || 0) + cacheHit * (pCache || 0)) / 1e6;
        return isFinite(v) ? v : null;
    }

    /**
     * buildWatchtowerReport(input) → 周报对象
     *
     * @param {Object} input
     * @param {Array}  input.entries      账本条目（lib/cost-track.readLedgerEntries() 的产出）。
     *                                     坏行 / 非对象跳过；缺 ts 的条目跳过（不猜日期）。
     * @param {Object} [input.pricing]    当前价表快照（read-only 拷贝）。**不传 = 不报已省金额**。
     * @param {Number} [input.days]       回看天数，默认 7。
     * @param {String} [input.now]        「现在」的 ISO 串（测试注入用；不传取运行时当前时间）。
     * @param {String} [input.currency]   币种（'CNY' / 'USD'）。null = 不知道，渲染层不许印符号。
     *
     * @returns {Object} 见函数内 `out` 的形状注释。
     */
    function buildWatchtowerReport(input) {
        input = input || {};
        var entries = Array.isArray(input.entries) ? input.entries : [];
        var pricing = (input.pricing && typeof input.pricing === 'object') ? input.pricing : null;
        var days = (typeof input.days === 'number' && isFinite(input.days) && input.days > 0)
                 ? Math.floor(input.days) : DEFAULT_DAYS;
        var currency = str(input.currency);
        // 时区：调用方传 PROXY_COST_TZ；没传用 Asia/Shanghai（本地部署，数据不出本机，
        // 写死北京时间比让每个用户配一遍更符合「开盒即用」）。
        var tz = str(input.tz) || DEFAULT_TZ;
        var nowMs = input.now ? Date.parse(input.now) : Date.now();
        if (!isFinite(nowMs)) nowMs = Date.now();

        var out = {
            ok: true,
            generatedAt: new Date(nowMs).toISOString(),
            window: { days: days, fromDay: null, toDay: dayOf(nowMs, tz), tz: tz },
            spend: { actualCost: null, requestCount: 0, entryCount: 0, unpricedEntryCount: 0 },
            saved: {
                // 已省金额（模型重写差额）。null = 算不出，原因在 reason。
                byRouting: null,
                baselineCost: null,
                computable: false,
                reason: null,
                pricingAsOf: null
            },
            zeroCost: { requestCount: 0, ratio: null },
            // dataQuality 必须在初始结构里就给默认值：空账本时会提前 return，
            // 若只在主循环后赋值，消费方拿到的就是 undefined（前端画卡直接崩）。
            dataQuality: {
                entryCount: 0,
                unknownModelCount: 0,
                unknownModelRatio: null,
                unknownAgentCount: 0,
                unknownAgentRatio: null,
                paidEntryCount: 0,
                baselineReadyEntryCount: 0,
                baselineReadyRatio: null
            },
            byAgent: [],
            byModel: [],
            caveats: [],
            unavailable: []
        };

        // ── 窗口过滤 ────────────────────────────────────────────────
        // 边界用「日历日」而不是滚动 168 小时：周报是给人看的，跨月的 7 天说不清。
        var fromDay = dayOf(nowMs - days * 86400000, tz);
        out.window.fromDay = fromDay;

        var kept = [];
        var skippedNoTs = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e || typeof e !== 'object') continue;
            var d = recordDayOf(e, tz);
            if (d === null) { skippedNoTs++; continue; }
            if (fromDay !== null && d < fromDay) continue;   // 字符串日期可直接比（ISO）
            if (out.window.toDay !== null && d > out.window.toDay) continue;
            kept.push(e);
        }
        if (skippedNoTs > 0) {
            out.unavailable.push('tsMissing:' + skippedNoTs);
            out.caveats.push('有 ' + skippedNoTs + ' 条账本记录缺 ts 或 ts 无法解析，未计入本期（不猜日期）。');
        }

        out.spend.entryCount = kept.length;
        if (kept.length === 0) {
            out.caveats.push('本窗口内没有账本记录。可能原因：门控 PROXY_COST_TRACK 未开、代理未上报 usage、或真的没有流量。');
            out.unavailable.push('entries:0');
            return out;
        }

        // ── ① 实际花费 + 逐 agent / 逐模型拆账 ──────────────────────
        var totalCost = 0;
        var totalRequests = 0;
        var unpriced = 0;
        var zeroCostCount = 0;
        var agentMap = {};
        var modelMap = {};
        // 反事实重算需要「付费条目全部配齐对标价」，有任何一条配不齐就整体作废——
        // 部分重算会低估省下的金额，比不报更糟。
        var baselineTotal = 0;
        var baselineOk = true;
        var baselineBlocker = null;
        // 数据质量计数器：账本缺多少字段，必须数出来印在周报上。
        var unknownModelCount = 0;
        var unknownAgentCount = 0;
        var paidEntryCount = 0;
        var baselineReadyCount = 0;

        for (var j = 0; j < kept.length; j++) {
            var rec = kept[j];
            var cost = numOrNull(rec.cost);
            if (cost === null) { unpriced++; cost = 0; }
            else { totalCost += cost; }
            if (cost === 0) zeroCostCount++;

            totalRequests++;

            var agent = str(rec.agent) || str(rec.proxy) || UNKNOWN;
            var model = modelOf(rec.model) || UNKNOWN;

            // ── 数据质量计量 ────────────────────────────────────────
            // 「按模型拆账基本是瞎的」这种事，不把它变成一个印在周报上的比例，
            // 就没人会去修上游；而它会安静地让整份周报看起来正常。
            // agent 同时缺 agent 与 proxy 两个字段才算 unknown（两者是同一来源的冗余）。
            if (isUnknown(rec.model)) unknownModelCount++;
            if (isUnknown(rec.agent) && isUnknown(rec.proxy)) unknownAgentCount++;
            if (cost > 0) {
                paidEntryCount++;
                if (modelOf(rec.requestModel)) baselineReadyCount++;
            }
            var tokens = (numOrNull(rec.prompt) || 0) + (numOrNull(rec.completion) || 0)
                       + (numOrNull(rec.cacheHit) || 0) + (numOrNull(rec.thinking) || 0);

            if (!agentMap[agent]) {
                agentMap[agent] = { agent: agent, requests: 0, tokens: 0, actualCost: 0, topModel: null, _models: {} };
            }
            var ag = agentMap[agent];
            ag.requests++;
            ag.tokens += tokens;
            ag.actualCost += cost;
            ag._models[model] = (ag._models[model] || 0) + 1;
            if (ag.topModel === null || ag._models[model] > ag._models[ag.topModel]) ag.topModel = model;

            if (!modelMap[model]) {
                modelMap[model] = { model: model, requests: 0, tokens: 0, actualCost: 0 };
            }
            var mm = modelMap[model];
            mm.requests++;
            mm.tokens += tokens;
            mm.actualCost += cost;

            // ── ② 已省金额（模型重写差额）────────────────────────────
            // 只在「这条真的花了钱」时才需要对标价——没花钱的条目省下的是 0，不影响总额。
            if (cost > 0) {
                var reqModel = modelOf(rec.requestModel);
                if (!reqModel) {
                    baselineOk = false;
                    if (!baselineBlocker) baselineBlocker = 'requestModelMissing';
                    continue;
                }
                var baseline = recompute(rec, pricing, 'requestModel');
                if (baseline === null) {
                    baselineOk = false;
                    if (!baselineBlocker) baselineBlocker = 'pricingMissing:' + reqModel;
                    continue;
                }
                baselineTotal += baseline;
            }
        }

        out.spend.actualCost = totalCost;
        out.spend.requestCount = totalRequests;
        out.spend.unpricedEntryCount = unpriced;
        if (currency) out.spend.currency = currency;

        out.zeroCost.requestCount = zeroCostCount;
        out.zeroCost.ratio = totalRequests > 0 ? (zeroCostCount / totalRequests) : null;

        // ④ 数据质量段（2026-10-16 加）：账本本身可不可信。
        // 为什么单列：周报的三个数全部建立在「账本字段齐全」上。字段缺失比例高时，
        // 按模型拆账 / 按 agent 归因 / 已省金额都会失真——而失真不报错，
        // 只会安静地给出一份看起来正常的假周报。缺多少必须印出来，否则等于没有。
        out.dataQuality = {
            entryCount: totalRequests,
            unknownModelCount: unknownModelCount,
            unknownModelRatio: totalRequests > 0 ? (unknownModelCount / totalRequests) : null,
            unknownAgentCount: unknownAgentCount,
            unknownAgentRatio: totalRequests > 0 ? (unknownAgentCount / totalRequests) : null,
            paidEntryCount: paidEntryCount,
            baselineReadyEntryCount: baselineReadyCount,
            baselineReadyRatio: paidEntryCount > 0 ? (baselineReadyCount / paidEntryCount) : null
        };
        // 阈值 20%：低于它不影响读数，高于它按模型拆账已经是多数派缺失。
        if (out.dataQuality.unknownModelRatio !== null && out.dataQuality.unknownModelRatio > 0.2) {
            out.caveats.push('账本里 ' + unknownModelCount + '/' + totalRequests
                + ' 条缺模型名（<unknown>），按模型拆账与已省金额都受影响。'
                + '接入方需在请求体里带模型名；存量账本不改写（账本冻结），只看增量。');
        }
        if (out.dataQuality.unknownAgentRatio !== null && out.dataQuality.unknownAgentRatio > 0.2) {
            out.caveats.push('账本里 ' + unknownAgentCount + '/' + totalRequests
                + ' 条不知道是哪个 agent 花的钱，按 agent 归因不可用。'
                + '接入方可加 x-agent 请求头，或用 PROXY_AGENT_UA_MAP 登记 UA 特征。');
        }

        // ③ 零花费占比的归因警告——三种来源都可能，绝不单独归因给「本地模型」。
        if (zeroCostCount > 0) {
            out.caveats.push('零花费请求占 ' + Math.round(out.zeroCost.ratio * 100) + '%。cost=0 可能来自本地模型、免费额度或未配单价三种情况，本项只报事实、不归因。');
        }

        if (baselineOk && baselineTotal > 0) {
            out.saved.computable = true;
            out.saved.baselineCost = baselineTotal;
            // 🔴 符号方向：`byRouting` = 对标花费 − 实际花费，**正数 = 省下了钱**。
            // 反一下会让「省了 9 块」显示成 -9，读者第一眼会读成「多花了 9 块」。
            // 重写选贵了时不截断——负数就是「路由帮你多花了钱」，这个信号必须看得见。
            out.saved.byRouting = baselineTotal - totalCost;
            if (currency) out.saved.currency = currency;
            out.caveats.push('已省金额按当前价表快照重算（账本只冻结了实际花费，没有冻结对标价）。若价表自记账后改过，差额含价表变动成分，不能单独归因给路由。');
        } else {
            out.saved.computable = false;
            out.saved.reason = baselineBlocker || (baselineTotal === 0 ? 'noPaidEntries' : 'unknown');
            out.unavailable.push('saved.byRouting');
            if (baselineBlocker === 'requestModelMissing') {
                out.caveats.push('有付费条目缺 requestModel，无法算「如果不重写模型会花多少」。');
            } else if (baselineBlocker && baselineBlocker.indexOf('pricingMissing:') === 0) {
                var missing = baselineBlocker.slice('pricingMissing:'.length);
                out.caveats.push('价表里没有 ' + missing + ' 的单价，已省金额算不出。给它配 PROXY_PRICING 或 provider pricing 后即有值。');
            } else {
                out.caveats.push('本窗口没有付费条目，已省金额为 0 的对比无意义，故不报。');
            }
        }

        // ── 排序：按花费降序（看不看钱是周报的第一动线）─────────────
        out.byAgent = Object.keys(agentMap).map(function (k) {
            var a = agentMap[k];
            delete a._models;
            return a;
        }).sort(function (a, b) { return b.actualCost - a.actualCost; });

        out.byModel = Object.keys(modelMap).map(function (k) { return modelMap[k]; })
            .sort(function (a, b) { return b.actualCost - a.actualCost; });

        return out;
    }

    /**
     * renderText(report) → 终端可读的纯文本周报（零依赖，给 tools/ CLI 用）。
     * 不印 emoji、不印装饰线；数字拿不到一律印「—」。
     */
    function renderText(report) {
        if (!report || typeof report !== 'object') return '';
        var L = [];
        var sym = report.spend.currency ? report.spend.currency + ' ' : '';
        function money(v) {
            if (v === null || v === undefined || !isFinite(v)) return '—';
            return sym + v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
        }

        // 日期键是 UTC（dayOf 与 l2/usage-rollup.js 同口径，改动需同步）——
        // 必须印出来：中国用户按北京时间理解"上周"会差一天，不印就是这个工具算错了。
        L.push('multi-proxy 周报 · ' + report.window.fromDay + ' ~ ' + report.window.toDay
               + '（' + report.window.days + ' 天 · ' + (report.window.tz || DEFAULT_TZ) + ' 日期）');
        L.push('生成时间 ' + report.generatedAt);
        L.push('');
        L.push('实际花费        ' + money(report.spend.actualCost)
               + '   请求 ' + report.spend.requestCount + ' 次');
        if (report.saved.computable) {
            L.push('模型重写已省    ' + money(report.saved.byRouting)
                   + '   对标花费 ' + money(report.saved.baselineCost));
        } else {
            L.push('模型重写已省    —（' + (report.saved.reason || '算不出') + '）');
        }
        if (report.zeroCost.ratio !== null) {
            L.push('零花费请求占比  ' + Math.round(report.zeroCost.ratio * 100) + '%'
                   + '（' + report.zeroCost.requestCount + '/' + report.spend.requestCount + '）');
        }
        // 账本完整度：缺字段比例高时，上面三个数都别太当真——先印这个，再印别的。
        if (report.dataQuality && report.dataQuality.unknownModelRatio !== null) {
            var dq = report.dataQuality;
            L.push('账本完整度      ' + Math.round((1 - dq.unknownModelRatio) * 100) + '%'
                   + '（缺模型名 ' + dq.unknownModelCount + '/' + dq.entryCount + ' 条'
                   + (dq.unknownAgentCount > 0
                      ? '，缺 agent 名 ' + dq.unknownAgentCount + ' 条' : '') + '）');
        }
        L.push('');
        L.push('按 agent：');
        if (report.byAgent.length === 0) {
            L.push('  （无）');
        } else {
            report.byAgent.forEach(function (a) {
                L.push('  ' + pad(a.agent, 22) + money(a.actualCost)
                       + '   ' + a.requests + ' 次   主力模型 ' + a.topModel);
            });
        }
        L.push('');
        L.push('按模型：');
        if (report.byModel.length === 0) {
            L.push('  （无）');
        } else {
            report.byModel.forEach(function (m) {
                L.push('  ' + pad(m.model, 22) + money(m.actualCost)
                       + '   ' + m.requests + ' 次');
            });
        }
        if (report.caveats && report.caveats.length) {
            L.push('');
            L.push('口径说明：');
            report.caveats.forEach(function (c) { L.push('  - ' + c); });
        }
        return L.join('\n');
    }

    function pad(s, n) {
        s = String(s === null || s === undefined ? '' : s);
        while (s.length < n) s += ' ';
        return s;
    }

    return {
        UNKNOWN: UNKNOWN,
        DEFAULT_DAYS: DEFAULT_DAYS,
        numOrNull: numOrNull,
        modelOf: modelOf,
        isUnknown: isUnknown,
        dayOf: dayOf,
        recordDayOf: recordDayOf,
        DEFAULT_TZ: DEFAULT_TZ,
        priceOf: priceOf,
        recompute: recompute,
        buildWatchtowerReport: buildWatchtowerReport,
        renderText: renderText
    };
}));
