// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * l2/watchtower-report.js 单元测试（node:test，零第三方依赖）。
 *
 * 覆盖：
 *   1. dayOf：epoch ms / ISO 串两种 ts 形态；坏 ts → null（不猜日期）。
 *   2. 窗口过滤：窗口外条目剔除；缺 ts 条目剔除并记 unavailable。
 *   3. 实际花费：cost 求和；cost 非有限数 → 计 unpriced 且按 0 计（不猜价）。
 *   4. 已省金额：价表配齐 → 可算；缺 requestModel → null；缺对标单价 → null
 *      （**不是 0**）；没有付费条目 → null 且 reason=noPaidEntries。
 *   5. 反向重写（实际比请求的还贵）→ 省下额为负，**不截断**。
 *   6. 零花费占比：只报事实不归因，caveats 里有三种来源警告。
 *   7. byAgent / byModel 按 actualCost 降序；agent 缺省回落 proxy，再回落 <unknown>。
 *   8. renderText：null 值印「—」，不印 0。
 *   9. 浏览器 / Node 双端导出形状一致。
 *
 * 跑法：node --test l2/tests/watchtower-report.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../watchtower-report');

const NOW = '2026-10-16T08:00:00.000Z';

// 窗口内（2026-10-15，7 天窗口覆盖）的一条付费记录：
// 宿主要 claude-haiku（贵），被 route-engine 重写成 agnes（便宜）。
function paidEntry(over) {
    return Object.assign({
        ts: '2026-10-15T10:00:00.000Z',
        proxy: 'codex-proxy',
        agent: 'codex-proxy',
        model: 'agnes-3.0-flash',
        requestModel: 'claude-haiku-4-5',
        prompt: 1000000,
        completion: 0,
        cacheHit: 0,
        thinking: 0,
        cost: 1.0,            // agnes：input ¥1/M
        latencyMs: 900
    }, over || {});
}

// 两套单价：实际模型便宜、宿主要的贵。
const PRICING = {
    'agnes-3.0-flash': { input: 1, output: 2, cacheHit: 0.5 },
    'claude-haiku-4-5': { input: 10, output: 30, cacheHit: 5 }
};

// 2026-10-16：dayOf 由 UTC 口径改成本地时区口径（默认 Asia/Shanghai）。
// 改动的动机：周报的「上周」由用户按北京时间理解，UTC 口径下 23:00–24:00 的
// 请求会被算进前一天，窗口边界差一天，而此前界面上没有任何提示。
// 下面第一条就是那个边界：UTC 2026-10-15 23:59:59 = 北京 2026-10-16 07:59:59，
// 本地日期是 10-16 而不是 10-15。
test('dayOf: 本地时区日期键（默认 Asia/Shanghai），坏 ts → null', () => {
    assert.equal(W.dayOf(Date.parse('2026-10-15T23:59:59.999Z')), '2026-10-16');
    assert.equal(W.dayOf('2026-10-15T00:00:00.000Z'), '2026-10-15');   // 北京 08:00，同日
    assert.equal(W.dayOf('not-a-date'), null);
    assert.equal(W.dayOf(undefined), null);
    assert.equal(W.dayOf({}), null);
    assert.equal(W.dayOf(NaN), null);
});

test('dayOf: 显式 tz 覆盖默认（PROXY_COST_TZ 走这条路进来）', () => {
    // 同一个时刻：北京 10-16、UTC 10-15、纽约 10-15
    const ms = Date.parse('2026-10-15T23:00:00.000Z');
    assert.equal(W.dayOf(ms, 'Asia/Shanghai'), '2026-10-16');
    assert.equal(W.dayOf(ms, 'UTC'), '2026-10-15');
    assert.equal(W.dayOf(ms, 'America/New_York'), '2026-10-15');
});

test('dayOf: 时区名无效 → 回退 UTC，不让整份周报生不出来', () => {
    const ms = Date.parse('2026-10-15T23:00:00.000Z');
    assert.equal(W.dayOf(ms, 'Not/AZone'), '2026-10-15');   // Intl 会抛，接住回退
});

test('recordDayOf: 优先用行内 localDay，存量行 fallback 按 ts 现算', () => {
    const ms = Date.parse('2026-10-15T23:00:00.000Z');
    // 有 localDay → 用它（落账时刻冻结的值，比读时刻现算更诚实）
    assert.equal(W.recordDayOf({ ts: ms, localDay: '2026-10-16' }), '2026-10-16');
    // localDay 与 ts 冲突时也信 localDay：那是落账时算好的
    assert.equal(W.recordDayOf({ ts: ms, localDay: '2026-01-01' }), '2026-01-01');
    // 存量行没有 localDay → 按 ts 现算
    assert.equal(W.recordDayOf({ ts: ms }), '2026-10-16');
    // localDay 形状不对（不是 YYYY-MM-DD）→ 不当键用，退回现算
    assert.equal(W.recordDayOf({ ts: ms, localDay: 'garbage' }), '2026-10-16');
    assert.equal(W.recordDayOf({ ts: ms, localDay: null }), '2026-10-16');
});

test('窗口边界按本地时区算：UTC 23 点的 now 在北京是第二天', () => {
    // now = UTC 2026-10-15T23:00 = 北京 2026-10-16 07:00
    // 窗口 toDay 应是 10-16（UTC 口径会给 10-15）
    const r = W.buildWatchtowerReport({
        entries: [],
        pricing: PRICING,
        days: 7,
        now: '2026-10-15T23:00:00.000Z'
    });
    assert.equal(r.window.toDay, '2026-10-16');
    assert.equal(r.window.tz, 'Asia/Shanghai');
    assert.equal(r.window.fromDay, '2026-10-09');
});

test('跨 UTC 日边界的记录按 localDay 归进北京日期', () => {
    // 一条 ts 在 UTC 10-15 23:00（北京 10-16）的记录，
    // 过去按 UTC 算会归到 10-15，若窗口 toDay 是 10-15 之前就被切掉。
    const r = W.buildWatchtowerReport({
        entries: [paidEntry({ ts: '2026-10-15T23:00:00.000Z', localDay: '2026-10-16' })],
        pricing: PRICING,
        days: 7,
        now: '2026-10-15T23:30:00.000Z'    // 北京 10-16 07:30
    });
    assert.equal(r.window.toDay, '2026-10-16');
    assert.equal(r.spend.entryCount, 1, '这条应算进本期（北京 10-16）');
});

test('renderText 印出时区名，日期口径不再是无提示的 UTC', () => {
    const r = W.buildWatchtowerReport({ entries: [], pricing: PRICING, days: 7, now: NOW });
    const txt = W.renderText(r);
    assert.equal(txt.indexOf('Asia/Shanghai 日期') !== -1, true, '应印出时区名，实际: ' + txt.split('\n')[0]);
});

test('窗口过滤：窗口外剔除，缺 ts 剔除并记 unavailable', () => {
    const r = W.buildWatchtowerReport({
        entries: [
            paidEntry({ ts: '2026-10-15T10:00:00.000Z' }),   // 窗内
            paidEntry({ ts: '2026-09-01T10:00:00.000Z' }),   // 窗外（太老）
            paidEntry({ ts: 'garbage' }),                    // 坏 ts
            { cost: 5 }                                       // 完全缺 ts
        ],
        pricing: PRICING,
        days: 7,
        now: NOW
    });
    assert.equal(r.window.fromDay, '2026-10-09');
    assert.equal(r.window.toDay, '2026-10-16');
    assert.equal(r.spend.entryCount, 1);
    assert.equal(r.spend.requestCount, 1);
    assert.ok(r.unavailable.indexOf('tsMissing:2') !== -1);
    assert.equal(r.caveats.some(c => c.indexOf('未计入本期') !== -1), true);
});

test('实际花费：cost 求和；非有限数计 unpriced 且不猜价', () => {
    const r = W.buildWatchtowerReport({
        entries: [
            paidEntry({ cost: 1.0, agent: 'a' }),
            paidEntry({ cost: 2.5, agent: 'a' }),
            paidEntry({ cost: null, agent: 'b' }),      // 缺价 → 按 0 计，但要报出来
            paidEntry({ cost: 'x', agent: 'b' })        // 坏值同上
        ],
        days: 7,
        now: NOW
    });
    assert.equal(r.spend.actualCost, 3.5);
    assert.equal(r.spend.unpricedEntryCount, 2);
    assert.equal(r.spend.requestCount, 4);
    assert.equal(r.byAgent.length, 2);
    assert.equal(r.byAgent[0].agent, 'a');       // 3.5 > 0
    assert.equal(r.byAgent[1].agent, 'b');
});

test('已省金额：价表配齐 → 可算，正数表示省下了钱', () => {
    // 100 万 prompt tokens：宿主要 haiku ¥10/M，实际走 agnes ¥1/M → 省 ¥9
    const r = W.buildWatchtowerReport({
        entries: [paidEntry()],
        pricing: PRICING,
        days: 7,
        now: NOW
    });
    assert.equal(r.saved.computable, true);
    assert.equal(r.saved.baselineCost, 10);
    assert.equal(r.spend.actualCost, 1);
    // 符号方向：byRouting = 对标花费 − 实际花费，正数 = 省下了钱
    assert.equal(r.saved.byRouting, 9);
    assert.equal(r.saved.reason, null);
});

test('已省金额：省下额为负时不截断（重写选贵了要看得见）', () => {
    const r = W.buildWatchtowerReport({
        // 宿主要 agnes（¥1/M），实际走了 haiku（¥10/M）→ 路由帮你多花了 ¥9
        entries: [paidEntry({ model: 'claude-haiku-4-5', requestModel: 'agnes-3.0-flash', cost: 10 })],
        pricing: PRICING,
        days: 7,
        now: NOW
    });
    assert.equal(r.saved.computable, true);
    assert.equal(r.saved.baselineCost, 1);
    assert.equal(r.spend.actualCost, 10);
    // 负 = 多花了，绝不截断成 0（截断会把「路由选贵了」这个信号藏掉）
    assert.equal(r.saved.byRouting, -9);
});

test('已省金额：缺 requestModel → null 且 reason=requestModelMissing', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry({ requestModel: undefined })],
        pricing: PRICING,
        days: 7,
        now: NOW
    });
    assert.equal(r.saved.computable, false);
    assert.equal(r.saved.byRouting, null);
    assert.equal(r.saved.reason, 'requestModelMissing');
    assert.ok(r.unavailable.indexOf('saved.byRouting') !== -1);
});

test('已省金额：价表缺对标单价 → null（不是 0）', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry({ requestModel: 'some-unlisted-model' })],
        pricing: PRICING,
        days: 7,
        now: NOW
    });
    assert.equal(r.saved.computable, false);
    assert.equal(r.saved.byRouting, null);
    assert.equal(r.saved.reason, 'pricingMissing:some-unlisted-model');
    assert.equal(r.caveats.some(c => c.indexOf('some-unlisted-model') !== -1), true);
});

test('已省金额：一个付费条目配不齐 → 整体作废（部分重算会低估）', () => {
    const r = W.buildWatchtowerReport({
        entries: [
            paidEntry({ requestModel: 'claude-haiku-4-5' }),        // 配齐
            paidEntry({ requestModel: 'some-unlisted-model' })      // 配不齐
        ],
        pricing: PRICING,
        days: 7,
        now: NOW
    });
    assert.equal(r.saved.computable, false);
    assert.equal(r.saved.byRouting, null);
});

test('已省金额：没有付费条目 → null 且 reason=noPaidEntries', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry({ cost: 0 })],
        pricing: PRICING,
        days: 7,
        now: NOW
    });
    assert.equal(r.saved.computable, false);
    assert.equal(r.saved.byRouting, null);
    assert.equal(r.saved.reason, 'noPaidEntries');
});

test('已省金额：不传 pricing → null（不许默认免费）', () => {
    const r = W.buildWatchtowerReport({ entries: [paidEntry()], days: 7, now: NOW });
    assert.equal(r.saved.computable, false);
    assert.equal(r.saved.byRouting, null);
    assert.equal(r.saved.reason, 'pricingMissing:claude-haiku-4-5');
});

test('零花费占比：只报事实，caveats 警告三种来源', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry({ cost: 0 }), paidEntry({ cost: 2 })],
        days: 7,
        now: NOW
    });
    assert.equal(r.zeroCost.requestCount, 1);
    assert.equal(r.zeroCost.ratio, 0.5);
    assert.equal(r.caveats.some(c => c.indexOf('不归因') !== -1), true);
});

test('空窗口：早退 + caveats 说明三种可能原因', () => {
    const r = W.buildWatchtowerReport({ entries: [], days: 7, now: NOW });
    assert.equal(r.spend.entryCount, 0);
    assert.equal(r.spend.actualCost, null);
    assert.equal(r.byAgent.length, 0);
    assert.equal(r.caveats.some(c => c.indexOf('PROXY_COST_TRACK') !== -1), true);
    assert.ok(r.unavailable.indexOf('entries:0') !== -1);
});

test('agent 缺省回落 proxy，再回落 <unknown>', () => {
    const r = W.buildWatchtowerReport({
        entries: [
            paidEntry({ agent: undefined, proxy: 'codex-proxy' }),
            paidEntry({ agent: undefined, proxy: undefined })
        ],
        days: 7,
        now: NOW
    });
    const names = r.byAgent.map(a => a.agent).sort();
    assert.deepEqual(names, ['<unknown>', 'codex-proxy']);
});

test('renderText：null 值印「—」，不印 0', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry({ requestModel: 'nope' })],
        pricing: PRICING,
        currency: 'CNY',
        days: 7,
        now: NOW
    });
    const text = W.renderText(r);
    assert.equal(text.indexOf('已省    —') !== -1, true);
    assert.equal(text.indexOf('已省    ¥0') !== -1, false);
    assert.equal(text.indexOf('实际花费        CNY 1') !== -1, true);
});

test('renderText：可算时印差额与对标花费', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry()],
        pricing: PRICING,
        currency: 'CNY',
        days: 7,
        now: NOW
    });
    const text = W.renderText(r);
    assert.equal(text.indexOf('已省    CNY 9') !== -1, true);
    assert.equal(text.indexOf('对标花费 CNY 10') !== -1, true);
});

test('<unknown> 哨兵值一律当「没有」，不当成真模型名', () => {
    // lib/cost-track.js 拿不到模型名时填 '<unknown>' 而不是置空。若不当成缺失，
    // 反事实对比会拿 '<unknown>' 去价表查价 → 必然查不到 → 把「没上报模型名」
    // 误报成「价表里没有 <unknown> 的单价」。
    assert.equal(W.modelOf('<unknown>'), null);
    assert.equal(W.modelOf('agnes-3.0-flash'), 'agnes-3.0-flash');
    assert.equal(W.modelOf(undefined), null);
    assert.equal(W.modelOf(''), null);

    const r = W.buildWatchtowerReport({
        entries: [paidEntry({ model: '<unknown>', requestModel: '<unknown>' })],
        pricing: PRICING,
        days: 7,
        now: NOW
    });
    assert.equal(r.saved.computable, false);
    assert.equal(r.saved.reason, 'requestModelMissing');   // 不是 pricingMissing:<unknown>
    // byModel 里仍保留一行 <unknown>（花费是真的，只是归不到模型）——
    // 但那是展示层的占位，不参与反事实对比。
    assert.equal(r.byModel[0].model, '<unknown>');
});

test('浏览器 / Node 双端导出形状一致', () => {
    const api = W;
    ['UNKNOWN', 'DEFAULT_DAYS', 'numOrNull', 'modelOf', 'isUnknown', 'dayOf', 'priceOf', 'recompute',
     'buildWatchtowerReport', 'renderText'].forEach(k => {
        assert.equal(typeof api[k] !== 'undefined', true, '缺导出 ' + k);
    });
    assert.equal(W.DEFAULT_DAYS, 7);
    assert.equal(W.UNKNOWN, '<unknown>');
});

// ── dataQuality：账本缺多少字段，必须数出来印在周报上（2026-10-16 加）──────
// 为什么单列一组：「按模型拆账基本是瞎的」这种事不变成一个比例就没人去修上游，
// 而它会安静地让整份周报看起来正常。真实账本 42 条里 32 条缺模型名（76%）。

test('dataQuality：unknown 模型 / unknown agent 分别计数', () => {
    const r = W.buildWatchtowerReport({
        entries: [
            paidEntry(),                                    // 有 model + agent
            paidEntry({ model: '<unknown>' }),              // 缺模型名
            paidEntry({ agent: '<unknown>', proxy: '<unknown>' })  // 缺 agent（model 继承默认值，有）
        ],
        pricing: PRICING, days: 7, now: NOW
    });
    assert.equal(r.dataQuality.entryCount, 3);
    assert.equal(r.dataQuality.unknownModelCount, 1);   // 只有第二条显式缺
    assert.equal(r.dataQuality.unknownModelRatio, 1 / 3);
    assert.equal(r.dataQuality.unknownAgentCount, 1);
    assert.equal(r.dataQuality.unknownAgentRatio, 1 / 3);
});

test('dataQuality：只缺 agent 不缺 proxy → 不算 unknown（同源冗余）', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry({ agent: '<unknown>', proxy: 'codex-proxy' })],
        pricing: PRICING, days: 7, now: NOW
    });
    assert.equal(r.dataQuality.unknownAgentCount, 0);
});

test('dataQuality：缺模型名超 20% → 进 caveats（不印就等于没有）', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry(), paidEntry({ model: '<unknown>' })],
        pricing: PRICING, days: 7, now: NOW
    });
    assert.equal(r.dataQuality.unknownModelRatio, 0.5);
    assert.equal(r.caveats.some(c => c.indexOf('缺模型名') !== -1), true);
});

test('dataQuality：缺 agent 超 20% → caveats 指向 x-agent 与 PROXY_AGENT_UA_MAP', () => {
    const entries = [paidEntry(), paidEntry({ agent: '<unknown>', proxy: '<unknown>' })];
    const r = W.buildWatchtowerReport({ entries: entries, pricing: PRICING, days: 7, now: NOW });
    assert.equal(r.dataQuality.unknownAgentRatio, 0.5);
    const hit = r.caveats.find(c => c.indexOf('不知道是哪个 agent') !== -1);
    assert.equal(typeof hit, 'string');
    // 必须给出可操作的修法，不能只报「有问题」
    assert.equal(hit.indexOf('x-agent') !== -1, true);
    assert.equal(hit.indexOf('PROXY_AGENT_UA_MAP') !== -1, true);
});

test('dataQuality：baselineReadyRatio 只数付费条目', () => {
    const r = W.buildWatchtowerReport({
        entries: [
            paidEntry(),                                        // 付费 + requestModel 配齐 → ready
            paidEntry({ requestModel: '<unknown>' }),           // 付费但缺对标模型 → 不 ready
            paidEntry({ cost: 0 })                              // 没花钱 → 不计入分母
        ],
        pricing: PRICING, days: 7, now: NOW
    });
    assert.equal(r.dataQuality.paidEntryCount, 2);
    assert.equal(r.dataQuality.baselineReadyEntryCount, 1);
    assert.equal(r.dataQuality.baselineReadyRatio, 0.5);
});

test('dataQuality：空窗口也有默认值（不是 undefined，前端画卡不崩）', () => {
    const r = W.buildWatchtowerReport({ entries: [], pricing: PRICING, days: 7, now: NOW });
    assert.equal(typeof r.dataQuality, 'object');
    assert.equal(r.dataQuality.entryCount, 0);
    assert.equal(r.dataQuality.unknownModelRatio, null);
    assert.equal(r.dataQuality.baselineReadyRatio, null);
});

test('renderText：印「账本完整度」行，缺 agent 时一并印', () => {
    const r = W.buildWatchtowerReport({
        entries: [paidEntry(), paidEntry({ model: '<unknown>', agent: '<unknown>', proxy: '<unknown>' })],
        pricing: PRICING, days: 7, now: NOW
    });
    const txt = W.renderText(r);
    assert.equal(txt.indexOf('账本完整度') !== -1, true);
    assert.equal(txt.indexOf('缺模型名 1/2 条') !== -1, true);
    assert.equal(txt.indexOf('缺 agent 名 1 条') !== -1, true);
    // 2026-10-16：日期口径必须印出来。中国用户按北京时间理解"上周"，
    // 而窗口按 UTC 算时会差一天——所以**必须是本地时区名**，不能再是 UTC。
    assert.equal(txt.indexOf('Asia/Shanghai 日期') !== -1, true);
});
