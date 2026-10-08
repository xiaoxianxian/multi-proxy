// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 省钱网关 Demo — 演示 difficulty 路由 + 模拟 delta 省钱账 + 喂 alert.js cost 信号
// 用法：node l2/savings-gateway/savings-gateway.demo.js
// 全确定性（无网络、固定 usage、不读墙钟），与 l2 其它 demo 同构。

const { createSavingsGateway, DEFAULT_PRICING, PLANNED_TIER, gateOpen, DUMMY_KEY_PREFIX, RECOMMENDED_CIRCUIT_CONFIG } = require('./gateway.js');
const { CircuitBreaker } = require('../circuit-breaker.js');
const A = require('../alert.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function demo() {
    console.log('=== Savings Gateway Demo（task1 一期 · shadow 模拟）===\n');

    // [1] 实例 + 三档 seed（agnes=small / deepseek=medium / qwen=large）
    const gw = createSavingsGateway();
    console.log('[1] 鉴权 + 难度路由（决策③⑤）');
    check('默认 dummy key 前缀 gw_', Object.keys(gw.getDummyKeys())[0].startsWith(DUMMY_KEY_PREFIX));
    let threw = null;
    try { gw.resolveKey('sk-xxx'); } catch (e) { threw = e; }
    check('非 dummy key → 401 invalid_api_key', threw && threw.httpStatus === 401 && /invalid_api_key/.test(threw.message));
    threw = null;
    try { gw.resolveKey(`${DUMMY_KEY_PREFIX}nope`); } catch (e) { threw = e; }
    check('未签发 key → 401 unknown_api_key', threw && threw.httpStatus === 401 && /unknown_api_key/.test(threw.message));

    const key = `${DUMMY_KEY_PREFIX}default-large`;
    const usage = { prompt_tokens: 1000, completion_tokens: 500 };
    const low = gw.handleChatCompletions({ messages: [{ role: 'user', content: '写个hello' }], complexity: 'low', usage }, { key });
    const med = gw.handleChatCompletions({ messages: [{ role: 'user', content: '帮我写一首诗' }], complexity: 'medium', usage }, { key });
    const high = gw.handleChatCompletions({ messages: [{ role: 'user', content: '架构级重构' }], complexity: 'high', usage }, { key });
    check('low → small(agnes)', low.x_savings.actualTier === 'small' && low.model === 'agnes', JSON.stringify(low.x_savings));
    check('medium → medium(deepseek)', med.x_savings.actualTier === 'medium' && med.model === 'deepseek');
    check('high → large(qwen)', high.x_savings.actualTier === 'large' && high.model === 'qwen');

    // [2] 模拟 delta（决策④）：planned=large 基线 32/128 CNY per 1M
    console.log('\n[2] 模拟 delta 记账（若照 large 打 vs 实际档位）');
    const pIn = DEFAULT_PRICING.large.input, pOut = DEFAULT_PRICING.large.output;
    const planned = 1000 / 1e6 * pIn + 500 / 1e6 * pOut; // 0.096
    check('planned(large)=0.096', Math.abs(planned - 0.096) < 1e-9, String(planned));
    check('low: actualCost=0, saved=0.096', low.x_savings.actualCost === 0 && Math.abs(low.x_savings.saved - 0.096) < 1e-9, JSON.stringify(low.x_savings));
    const medActual = 1000 / 1e6 * 1 + 500 / 1e6 * 4; // 0.003
    check('medium: actualCost=0.003, saved≈0.093', Math.abs(med.x_savings.actualCost - 0.003) < 1e-9 && Math.abs(med.x_savings.saved - (0.096 - 0.003)) < 1e-9, JSON.stringify(med.x_savings));
    check('high: actual=planned, saved=0', high.x_savings.saved === 0 && high.x_savings.actualCost === 0.096, JSON.stringify(high.x_savings));

    // [3] 无 usage → 启发式估算（诚实标 estimated=true）
    console.log('\n[3] token 估算（无真实 usage 时）');
    const est = gw.handleChatCompletions({ messages: [{ role: 'user', content: '你好世界' }] }, { key });
    check('estimated 标记', est.x_savings.estimated === true && est.usage.prompt_tokens >= 1);
    const noEst = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }, { key });
    check('有 usage 时 estimated=false', noEst.x_savings.estimated === false && noEst.usage.prompt_tokens === 7);

    // [4] 省钱报告（一期账目 API；排行榜留二期）
    console.log('\n[4] 省钱报告');
    const rep = gw.savingsReport();
    check('requestCount=5', rep.requestCount === 5, String(rep.requestCount));
    // 5 笔：low(small)/medium(medium)/high(large)/est 无 usage 默认 medium/noEst 默认 medium
    // totalSaved ≈ low 0.096 + medium 组(0.093+0.000062+0.000589) + high 0 ≈ 0.1897
    check('totalSaved≈0.1897（low 0.096 + medium 组 + high 0）', Math.abs(rep.totalSaved - 0.1897) < 1e-3, JSON.stringify(rep));
    check('perTier 分档计数 small=1/medium=3/large=1', rep.perTier.small.requestCount === 1 && rep.perTier.medium.requestCount === 3 && rep.perTier.large.requestCount === 1, JSON.stringify(rep.perTier));
    check('全 shadow 账（一期模拟，非真花钱）', rep.shadow === true);

    // [5] 喂 alert.js cost 信号（决策④ 接 alert.js）
    console.log('\n[5] 端到端：cost 信号 → alert.js cost-budget-exceeded');
    const sig = gw.produceCostSignal({ budget: 0.000001 });
    check('信号形状 { source:cost, providerId, cost, budget }', sig.source === 'cost' && sig.providerId === 'savings-gateway' && typeof sig.cost === 'number' && sig.budget === 0.000001);
    const fired = A.evaluate(sig);
    check('超预算 → 触发 cost-budget-exceeded(warning)', fired.length === 1 && fired[0].rule === 'cost-budget-exceeded' && fired[0].severity === 'warning');
    const within = gw.produceCostSignal({ budget: 9999 });
    check('预算内 → 不触发', A.evaluate(within).length === 0);
    const noBudget = gw.produceCostSignal();
    check('不设预算 → 信号不带 budget（不告警，YAGNI）', noBudget.budget === undefined && A.evaluate(noBudget).length === 0);

    // [7] P1-b（cc-switch 借鉴 2026-10-08）：per-provider 熔断查询接线（gateway ↔ circuit-breaker.allowRequest）
    console.log('\n[7] P1-b per-provider 熔断观测（gateway 接 circuit-breaker.allowRequest）');
    // 非侵入：默认不注入 breaker → circuitOpen 值为 undefined（breaker 未被询，零行为变更）
    const rNoneGw = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage }, { key });
    check('默认（无 breaker）→ circuitOpen=undefined（breaker 未被询，非侵入）', rNoneGw.x_savings.circuitOpen === undefined);
    // 注入 breaker 且未断（CLOSED）→ circuitOpen=false
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 1000 });
    const gw2 = createSavingsGateway({ circuitBreaker: breaker });
    const rClosedGw = gw2.handleChatCompletions({ messages: [{ role: 'user', content: '写个hello' }], complexity: 'low', usage }, { key });
    const closedAdapter = rClosedGw.model;   // low→small(agnes)
    check('注入 breaker 且未断 → circuitOpen=false', rClosedGw.x_savings.circuitOpen === false);
    // 按 actualAdapter(per-provider 维度)记录失败到 OPEN，下一笔同 provider → circuitOpen=true
    for (let i = 0; i < 2; i++) breaker.recordFailure(closedAdapter);
    const rOpenGw = gw2.handleChatCompletions({ messages: [{ role: 'user', content: '写个hello' }], complexity: 'low', usage }, { key });
    check('同 provider 熔断 OPEN 后 → circuitOpen=true（per-provider 维度）', rOpenGw.x_savings.circuitOpen === true);
    // 另一 provider（未断）→ still false，证明是 per-provider 而非全局串了
    const r2 = gw2.handleChatCompletions({ messages: [{ role: 'user', content: '架构级重构' }], complexity: 'high', usage }, { key });
    check('另一 provider 未断 → circuitOpen=false（per-provider 隔离）', r2.x_savings.circuitOpen === false && r2.model !== closedAdapter);
    // 观测位可被 getSavingsLog 读回
    const log = gw2.getSavingsLog();
    check('circuitOpen 进省账日志（观测位可追溯）', log.some((e) => e.circuitOpen === true));

    // [8] P1-b 增强（2026-10-08）：'recommended' 哨兵 → 自动注入推荐 breaker（含 halfOpenMaxCalls/successThreshold）
    console.log('\n[8] P1-b 增强：recommended 哨兵自动注入推荐 breaker');
    const gwRec = createSavingsGateway({ circuitBreaker: 'recommended' });
    const rRec = gwRec.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], complexity: 'low', usage }, { key });
    check('recommended 哨兵 → 注入 breaker（非 null）且默认未断 circuitOpen=false', rRec.x_savings.circuitOpen === false);
    check('recommended 哨兵 ≠ null（排除未注入导致 undefined）', rRec.x_savings.circuitOpen !== undefined);
    check('导出 RECOMMENDED_CIRCUIT_CONFIG：halfOpenMaxCalls=3', RECOMMENDED_CIRCUIT_CONFIG.halfOpenMaxCalls === 3);
    check('导出 RECOMMENDED_CIRCUIT_CONFIG：successThreshold=2', RECOMMENDED_CIRCUIT_CONFIG.successThreshold === 2);
    check('导出 RECOMMENDED_CIRCUIT_CONFIG：errorRate 滑窗 0.6/10/4', RECOMMENDED_CIRCUIT_CONFIG.errorRateThreshold === 0.6 && RECOMMENDED_CIRCUIT_CONFIG.slidingWindowSize === 10 && RECOMMENDED_CIRCUIT_CONFIG.minRequests === 4);

    // [9] 二期缝（2026-10-08）：熔断动作 failover / block / observe
    console.log('\n[9] 二期缝：熔断动作 failover / block / observe');
    // 简单 breaker：failureThreshold:1 → 一次 recordFailure 即 OPEN（确定性演示）
    const cbAct = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 60000 });
    cbAct.recordFailure('deepseek'); // 把 medium 档默认路由目标 deepseek 打 OPEN
    check('pre: deepseek 熔断 OPEN', cbAct.allowRequest('deepseek') === false);
    const keyB = `${DUMMY_KEY_PREFIX}default-large`;

    // observe（默认）：chosen=deepseek(OPEN) → 只记账，不改动路由
    const gwObs = createSavingsGateway({ circuitBreaker: cbAct, circuitMode: 'observe' });
    const rObs = gwObs.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'medium', usage }, { key: keyB });
    check('observe: circuitOpen=true（主路由 OPEN 仍记）', rObs.x_savings.circuitOpen === true);
    check('observe: 路由不改（仍走 OPEN 的 deepseek）', rObs.model === 'deepseek');
    check('observe: failover=false', rObs.x_savings.failover === false);

    // block：chosen=deepseek(OPEN) → 抛 503
    const gwBlock = createSavingsGateway({ circuitBreaker: cbAct, circuitMode: 'block' });
    let blockedStatus = null;
    try {
        gwBlock.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'medium', usage }, { key: keyB });
    } catch (e) { blockedStatus = e.httpStatus; }
    check('block: 抛 503 circuit_breaker_open', blockedStatus === 503);

    // failover：chosen=deepseek(OPEN) → 改路由到健康候选（agnes/qwen）
    const gwFo = createSavingsGateway({ circuitBreaker: cbAct, circuitMode: 'failover' });
    const rFo = gwFo.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'medium', usage }, { key: keyB });
    check('failover: circuitOpen 仍记 true（主路由 OPEN）', rFo.x_savings.circuitOpen === true);
    check('failover: failover=true', rFo.x_savings.failover === true);
    check('failover: 离开 deepseek 切到健康候选 agnes(small)', rFo.model === 'agnes' && rFo.x_savings.actualTier === 'small');
    check('failover: 落到的候选健康（allowRequest=true）', cbAct.allowRequest(rFo.model) === true);

    // failover 无健康候选 → 退化为 block 503（把其余候选也打 OPEN）
    cbAct.recordFailure('agnes');
    cbAct.recordFailure('qwen');
    check('pre: agnes/qwen 也 OPEN', cbAct.allowRequest('agnes') === false && cbAct.allowRequest('qwen') === false);
    let foStatus = null;
    try {
        gwFo.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'medium', usage }, { key: keyB });
    } catch (e) { foStatus = e.httpStatus; }
    check('failover 无健康候选 → 退化 503', foStatus === 503);

    // 默认关（不注入 breaker）：circuitOpen 恒 undefined，零行为变更
    const gwNo = createSavingsGateway();
    const rNo = gwNo.handleChatCompletions({ messages: [{ role: 'user', content: 'hi' }], complexity: 'medium', usage }, { key: keyB });
    check('默认关：circuitOpen=undefined', rNo.x_savings.circuitOpen === undefined);
    check('默认关：路由不受影响（deepseek）', rNo.model === 'deepseek');
    // [6] 非侵入（门控默认关 / shadow 默认开 / 不碰 env）
    console.log('\n[6] 非侵入断言');
    check('shadow 默认开', gw.isShadow() === true);
    check('gate 默认关（observe 语义由 server 层 403 体现，内核账目照常进内存）', gateOpen() === false);
    const leaked = Object.keys(process.env).filter((k) => k.startsWith('SAVE_GATEWAY') || k.startsWith('PROXY_SAVINGS') && false);
    check('不往 process.env 注入网关自有键', process.env.SAVE_GATEWAY_PORT === undefined && process.env.SAVE_GATEWAY_BIND_HOST === undefined && process.env.SAVE_GATEWAY === undefined);
    gw.setShadowMode(false);
    const off = gw.handleChatCompletions({ messages: [{ role: 'user', content: 'x' }], usage }, { key });
    check('shadow off + 无 executor = 仍不触真实上游（二期缝）', off.x_savings.shadow === false && off.choices[0].message.role === 'assistant');

    console.log(`\n[Savings-Gateway demo] PASS ${pass} / ${pass + fail}`);
    process.exit(fail === 0 ? 0 : 1);
}

demo().catch((e) => { console.error('FATAL', e); process.exit(1); });
