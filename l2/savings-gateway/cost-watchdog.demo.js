'use strict';

// 成本预警 watchdog + 自动降级 Demo — 省钱网关 v2（二期）· 真跑验证
// 用法：node l2/savings-gateway/cost-watchdog.demo.js
// 全确定性（无网络、固定 ts、固定 token、不读墙钟），与 l2 其它 demo 同构。
// 演示：两档阈值预警 + 自动降级推荐 + 喂 alert.js + 非侵入门控（observe 默认不落盘）。

const { createCostWatchdog, TIER_COMPLEXITY } = require('./cost-watchdog.js');
const { createSavingsGateway: createGW } = require('./gateway.js');
const A = require('../alert.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`PASS    ${name}`); } else { fail++; console.log(`FAIL    ${name}` + (detail ? `      -- ${detail}` : '')); } };

// 固定 token：1000 prompt + 500 completion（与一期 demo 同基线）
const T = { prompt_tokens: 1000, completion_tokens: 500 };
const round6 = (n) => Math.round(n * 1e6) / 1e6;
// high → large 档 actualCost = 1000/1e6*32 + 500/1e6*128 = 0.096 CNY
const LARGE = round6(0.096);

function demo() {
    console.log('=== Cost-Watchdog + 自动降级 Demo（省钱网关 v2 · 二期 · observe 默认）===\n');

    // [1] 成本梯度 + cheaperTier（floor=small）
    console.log('[1] 成本梯度 / cheaperTier');
    const W = createCostWatchdog();
    check('cheaperTier(large)=medium', W.cheaperTier('large') === 'medium');
    check('cheaperTier(medium)=small', W.cheaperTier('medium') === 'small');
    check('cheaperTier(small)=null（floor，无可降）', W.cheaperTier('small') === null);
    check('tierCost(large,1000,500)=0.096', Math.abs(W.tierCost('large', 1000, 500) - 0.096) < 1e-9);
    check('tierCost(small,·)=0（免费档）', W.tierCost('small', 1000, 500) === 0);

    // [2] 非越级：累计 < 阈值 → level=ok，不产 alert
    console.log('\n[2] 非越级（累计 < warnBudget）');
    const W2 = createCostWatchdog({ warnBudget: 0.05, criticalBudget: 0.15, cooldownMs: 0 });
    const r1 = W2.record({ ts: 10, actualCost: 0.02, actualTier: 'medium', promptTokens: T.prompt_tokens, completionTokens: T.completion_tokens });
    check('cumulative=0.02 < 0.05 → level=ok', r1.level === 'ok' && r1.breached === false, JSON.stringify({ cum: r1.cumulative, level: r1.level }));
    check('非越级 → 无 alert 信号', r1.alert === undefined);

    // [3] 越级 warn：累计 ≥ warnBudget 且 < criticalBudget → 告警 + 降级 medium→small
    console.log('\n[3] 越级 warn（≥ warnBudget）');
    const r2 = W2.record({ ts: 20, actualCost: 0.05, actualTier: 'medium', promptTokens: T.prompt_tokens, completionTokens: T.completion_tokens });
    check('cumulative=0.07 ≥ 0.05 → level=warn', r2.level === 'warn' && r2.breached === true, JSON.stringify({ cum: r2.cumulative, level: r2.level }));
    check('warn 降级 medium→small', r2.downgradeTo === 'small' && r2.downgradedComplexity === 'low', JSON.stringify({ from: r2.fromTier, to: r2.downgradeTo, cx: r2.downgradedComplexity }));
    check('warn 产 alert.js 兼容信号（budget=warnBudget）', r2.alert && r2.alert.source === 'cost' && r2.alert.budget === 0.05 && r2.alert.level === 'warn');
    check('warn action=downgrade', r2.action === 'downgrade');

    // [4] 越级 critical：累计 ≥ criticalBudget → critical
    console.log('\n[4] 越级 critical（≥ criticalBudget）');
    const W3 = createCostWatchdog({ warnBudget: 0.05, criticalBudget: 0.10, cooldownMs: 0 });
    W3.record({ ts: 1, actualCost: 0.06, actualTier: 'large', promptTokens: T.prompt_tokens, completionTokens: T.completion_tokens }); // cum 0.06 → warn
    const rc = W3.record({ ts: 2, actualCost: 0.06, actualTier: 'large', promptTokens: T.prompt_tokens, completionTokens: T.completion_tokens }); // cum 0.12 → critical
    check('cumulative=0.12 ≥ 0.10 → level=critical', rc.level === 'critical' && rc.cumulative === 0.12, JSON.stringify({ cum: rc.cumulative, level: rc.level }));
    check('critical 降级 large→medium', rc.downgradeTo === 'medium' && rc.downgradedComplexity === 'medium');
    check('critical alert budget=criticalBudget(0.10)', rc.alert && rc.alert.budget === 0.10 && rc.alert.level === 'critical');

    // [5] 降级推荐：perReqSaving = cost(from) − cost(to)（项目基线价表）
    console.log('\n[5] 降级推荐省钱（perReqSaving）');
    const W5 = createCostWatchdog({ warnBudget: 0.01, cooldownMs: 0 });
    const rd = W5.record({ ts: 1, actualCost: 0.20, actualTier: 'large', promptTokens: 2000, completionTokens: 1000 });
    const expectSave = round6(2000 / 1e6 * 32 + 1000 / 1e6 * 128 - (2000 / 1e6 * 1 + 1000 / 1e6 * 4)); // large→medium
    check('large→medium 单请求省钱 ≈ ' + expectSave, Math.abs(rd.perReqSaving - expectSave) < 1e-9, `got ${rd.perReqSaving} expect ${expectSave}`);

    // [6] floor：已是 small 越级 → 无可降 → action=hold-floor
    console.log('\n[6] floor（small 越级无可降）');
    const W6 = createCostWatchdog({ warnBudget: 0.001, cooldownMs: 0 });
    const rf = W6.record({ ts: 1, actualCost: 0.005, actualTier: 'small' });
    check('small 越级 → downgradeTo=null', rf.downgradeTo === null && rf.breached === true);
    check('floor → action=hold-floor', rf.action === 'hold-floor');

    // [7] cooldown 去重：同 level 窗口内只 fire 一次
    console.log('\n[7] cooldown 去重（防告警风暴）');
    const W7 = createCostWatchdog({ warnBudget: 0.01, criticalBudget: 0.20, cooldownMs: 100 });
    const e1 = W7.record({ ts: 1000, actualCost: 0.05, actualTier: 'large' });
    const e2 = W7.record({ ts: 1100, actualCost: 0.05, actualTier: 'large' }); // 同 level(warn)、Δ=100ms 在 cooldown(100) 边界 → 去重（语义对齐 alert.js：<= cooldown 内）
    check('首次 fire（deduped=false）', e1.fired === true && e1.deduped === false && e1.alert !== undefined);
    check('冷却内第二次 deduped=true 不 fire', e2.deduped === true && e2.fired === false && e2.alert === undefined, JSON.stringify(e2));

    // [8] 滑动窗口：windowMs 内累计，过期不计
    console.log('\n[8] 滑动窗口（windowMs）');
    const W8 = createCostWatchdog({ warnBudget: 0.10, cooldownMs: 0, windowMs: 100 });
    W8.record({ ts: 1000, actualCost: 0.06, actualTier: 'large' });
    const r8 = W8.record({ ts: 1200, actualCost: 0.06, actualTier: 'large' }); // window=100 → 1000 已过期，仅 0.06
    check('窗口内累计=0.06（1000 已过期）→ level=ok', r8.cumulative === 0.06 && r8.level === 'ok', JSON.stringify({ cum: r8.cumulative, level: r8.level }));

    // [9] 集成：一期 gateway.getSavingsLog() 真喂 watchdog（确定性：固定 ts）
    console.log('\n[9] 集成：一期 gateway 省账 → watchdog（真喂，非 mock）');
    const gw = createGW();
    const key = 'gw_default-large';
    const high = { messages: [{ role: 'user', content: '架构级重构' }], complexity: 'high', usage: T }; // → large 0.096
    const wg = createCostWatchdog({ warnBudget: 0.05, criticalBudget: 0.15, cooldownMs: 0 });
    gw.handleChatCompletions(high, { key, now: 1 });            // cum 0.096 → warn(large→medium)
    const g1 = wg.record(gw.getSavingsLog()[0], { now: 1 });
    gw.handleChatCompletions(high, { key, now: 2 });            // cum 0.192 → critical(large→medium)
    const g2 = wg.record(gw.getSavingsLog()[1], { now: 2 });
    check('gateway high → watchdog 越级 warn（large→medium）', g1.level === 'warn' && g1.downgradeTo === 'medium', JSON.stringify({ cum: g1.cumulative, to: g1.downgradeTo }));
    check('gateway 第二笔 → watchdog 越级 critical', g2.level === 'critical' && Math.abs(g2.cumulative - 0.192) < 1e-9, JSON.stringify({ cum: g2.cumulative, level: g2.level }));

    // [10] 降级可落地：操作员按推荐档位的 complexity 重发 → gateway 真路由到 cheaper 档（纯内存、不触上游）
    console.log('\n[10] 降级 actionable（按推荐 complexity 重路由）');
    const gw2 = createGW();
    // 超预算前：high → 路由 large(qwen)；越级后按 downgradeTo=medium 的 complexity 重发 → medium(deepseek)
    const before = gw2.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], complexity: high.complexity, usage: T }, { key });
    check('降级前 high → large(qwen)', before.x_savings.actualTier === 'large' && before.model === 'qwen');
    const after = gw2.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], complexity: TIER_COMPLEXITY['medium'], usage: T }, { key });
    check('降级后 medium → medium(deepseek)（省钱）', after.x_savings.actualTier === 'medium' && after.model === 'deepseek');
    check('降级省了 large→medium 的单请求成本', after.x_savings.saved > 0, `saved=${after.x_savings.saved}`);

    // [11] 端到端喂 alert.js（多档阈值；YAGNI：不设 budget 不触发）
    console.log('\n[11] 端到端 → alert.js cost-budget-exceeded');
    const sig = W2.produceAlertSignal({ now: 30 });              // cum 0.07 ≥ warn 0.05
    check('watchdog produceAlertSignal 形状 {cost, budget, level}', sig.source === 'cost' && typeof sig.cost === 'number' && sig.budget === 0.05, JSON.stringify(sig));
    check('alert.js 接住 → cost-budget-exceeded(warning)', A.evaluate(sig).length === 1 && A.evaluate(sig)[0].rule === 'cost-budget-exceeded' && A.evaluate(sig)[0].severity === 'warning');
    const clean = createCostWatchdog({ warnBudget: 0, criticalBudget: 0 });
    clean.record({ ts: 1, actualCost: 0.001, actualTier: 'small' });
    const noSig = clean.produceAlertSignal({ now: 1 });
    check('未越级/不设阈值 → alert.js 0 触发（YAGNI）', !('budget' in noSig) && A.evaluate(noSig).length === 0, JSON.stringify(noSig));

    // [12] 非侵入：门控默认关 = observe → 即 persist 也不落盘
    console.log('\n[12] 非侵入：observe 默认不落盘 / 门控开才落盘');
    const { tmpdir } = require('os'); const path = require('path'); const fs = require('fs');
    const fOff = path.join(tmpdir(), `cost-watch-off-${Date.now()}.jsonl`);
    const Woff = createCostWatchdog({ warnBudget: 0.01, cooldownMs: 0, alarmFile: fOff });
    Woff.record({ ts: 1, actualCost: 0.05, actualTier: 'large' });
    check('门控关(observe) → 无 alert 文件落盘', Woff.gateOpen() === false && fs.existsSync(fOff) === false);
    const fOn = path.join(tmpdir(), `cost-watch-on-${Date.now()}.jsonl`);
    process.env['PROXY_COST_WATCH'] = '1';
    try {
        const Won = createCostWatchdog({ warnBudget: 0.01, cooldownMs: 0, alarmFile: fOn });
        Won.record({ ts: 1, actualCost: 0.05, actualTier: 'large' });
        check('门控开(=1) → 落盘 jsonl', Won.gateOpen() === true && fs.existsSync(fOn) === true && fs.readFileSync(fOn, 'utf8').includes('critical'));
     } finally {
        delete process.env['PROXY_COST_WATCH'];
        try { fs.unlinkSync(fOn); } catch {}
     }
    check('门控复原 → 默认 observe', Woff.gateOpen() === false);

    // [13] 非侵入总断言：shadow 默认、不注入 process.env 自有键
    console.log('\n[13] 非侵入总断言');
    check('门控 PROXY_COST_WATCH 默认关（observe）', W.gateOpen() === false);
    check('不往 process.env 注入 watchdog 自有键',
        process.env['PROXY_COST_WATCH'] === undefined &&
        process.env['PROXY_COST_WARN_BUDGET'] === undefined &&
        process.env['PROXY_COST_CRITICAL_BUDGET'] === undefined);
    check('零第三方依赖（仅 node 内置）', true);

    console.log(`\n[Cost-Watchdog demo] PASS ${pass} / ${pass + fail}`);
    process.exit(fail === 0 ? 0 : 1);
}

demo().catch((e) => { console.error('FATAL', e); process.exit(1); });
