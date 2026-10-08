// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * skill-ledger-diff · 账本 diff 纯函数（浏览器 / Node 双用）
 *
 * 为什么要抽成双用模块：账本 diff 有两处消费者 ——
 *   ① tools/skill-ledger.js（CLI，--diff <基线.json>）
 *   ② multi-proxy-manager/public/skills.html（页面按「基线」按钮标红「比上次多涨 X token」）
 * 两边要的是同一套口径：条目主键怎么拼、新增/消失/变动怎么分、token 增减怎么算。
 * 写两份必然漂：早先 CLI 是 `host/category/name`，页面要是顺手改成 `host+name`，
 * 同一条 skill 在 CLI 里算「没变」、在页面里算「新增」。所以只留这一份真源。
 *
 * 纯函数、零依赖：不 require 任何东西、不读盘、不碰 localStorage（存储由调用方做）。
 *
 * 浏览器：`<script src="./skill-ledger-diff.js"></script>` → 全局 `window.SkillLedgerDiff`
 * Node  ：`require('./skill-ledger-diff.js')` → `{ keyOf, diffLedger }`
 *
 * ⚠️ estTokens 是**估算口径**（CJK×系数 + 其余×系数，见 l2/token-policy.js estimateTokens），
 *    不是真实分词器、不是 provider usage。任何对外展示的 diff 都别省掉「估算」二字。
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module && module.exports) { module.exports = api; }
    else { root.SkillLedgerDiff = api; }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 条目主键 = host[/category]/name —— 跟明细表、CLI 上打出来的路径一致，
    // 别另造一套 key，否则两边对不上、diff 全是「新增 + 消失」的假噪音。
    function keyOf(e) {
        if (!e) { return ''; }
        return [e.host, e.category || '', e.name].filter(Boolean).join('/');
    }

    // 数值累加口径：null / 非数字一律当 0（只给 tokensDelta、addedTokens 这类求和用）。
    function numOf(e) {
        var v = e && e.estTokens;
        return typeof v === 'number' && isFinite(v) ? v : 0;
    }
    // 🔴 展示口径：estTokens 为 null 表示「没量过」（平铺 md 没有单体 SKILL.md 之类），
    //    **绝不折算成 0** —— 0 会被读成「这条不占 token」。所以展示字段一律保留原始 null，
    //    由渲染层自己决定画「—」。别用 numOf 的结果去填 estTokens。
    function raw(e) {
        return (e && typeof e.estTokens === 'number' && isFinite(e.estTokens)) ? e.estTokens : null;
    }

    /**
     * cur vs base 三类分开：added / removed / changed（token 变了但条目还在）。
     * 返回里带 counts 与 tokensDelta，页面可以直接拿去标红，不用再自己 reduce 一遍。
     *
     * @param {{entries:Array, totals?:Object, generatedAt?:string}} cur  当前账本
     * @param {{entries:Array, totals?:Object, generatedAt?:string}} base 基线账本
     */
    function diffLedger(cur, base) {
        var bMap = new Map((base && base.entries ? base.entries : []).map(function (e) { return [keyOf(e), e]; }));
        var cMap = new Map((cur && cur.entries ? cur.entries : []).map(function (e) { return [keyOf(e), e]; }));
        var added = [], removed = [], changed = [];
        cMap.forEach(function (e, k) {
            var b = bMap.get(k);
            if (!b) {
                added.push({ key: k, host: e.host, name: e.name, estTokens: raw(e) });
                return;
            }
            var from = raw(b), to = raw(e);
            if (from !== to) {
                // from/to 可能是 null（有一边没量过）。这时 delta/ratio 无法确定，留 null 让渲染层画「—」，
                // 千万别编一个数字出来 —— 「基线量不了 → 现在量得了」会被误读成「少了几 token」。
                changed.push({
                    key: k, host: e.host, name: e.name,
                    from: from, to: to,
                    delta: from != null && to != null ? to - from : null,
                    ratio: from != null && to != null && from ? +(to / from).toFixed(3) : null,
                });
            }
        });
        bMap.forEach(function (e, k) {
            if (!cMap.has(k)) { removed.push({ key: k, host: e.host, name: e.name, estTokens: raw(e) }); }
        });

        var bt = (base && base.totals && base.totals.tokens) || 0;
        var ct = (cur && cur.totals && cur.totals.tokens) || 0;
        var addT = added.reduce(function (n, x) { return n + x.estTokens; }, 0);
        var remT = removed.reduce(function (n, x) { return n + x.estTokens; }, 0);
        return {
            baselineAt: (base && base.generatedAt) || null,
            added: added, removed: removed, changed: changed,
            addedCount: added.length, removedCount: removed.length, changedCount: changed.length,
            addedTokens: addT,
            removedTokens: -remT,
            tokensDelta: ct - bt,
            tokensFrom: bt, tokensTo: ct,
        };
    }

    return { keyOf: keyOf, diffLedger: diffLedger };
}));
