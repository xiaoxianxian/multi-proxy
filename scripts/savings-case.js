#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * savings-case.js — 对外「省钱测算」可截图 demo（对外叙事 / 销售物料用）。
 *
 * 为什么单独一个文件：
 *   docs/04-business/enterprise-value-prop.md 里的每个数字都必须能追溯到一条真跑的命令
 *   （AGENTS.md §4「性能/数字必须真跑」）。本脚本直接 require 内核的 DEFAULT_PRICING，
 *   不复制价表，价表改了本脚本的数跟着变，不会出现「文档写一套、内核是另一套」。
 *
 * 为什么不放 l2/savings-gateway/*.demo.js：
 *   run-demos.js 对未登记 tag 的 demo 会 fail-closed 告警并进全量回归，
 *   交付窗口内不往 demo 矩阵里加东西。本脚本是叙事工具，不是质量门禁。
 *
 * 跑：  node scripts/savings-case.js
 * 改：  node scripts/savings-case.js --in 8000 --out 2000 --people 50 --tasks 20 --days 22
 *
 * ⚠️ 输出的是「定价表模拟值」，不是真实账单。对外引用必须带这句标注。
 */

const { DEFAULT_PRICING } = require('../l2/savings-gateway/gateway.js');

// ---- 参数（可命令行覆盖）----
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const TOK_IN = arg('in', 8000);      // 单任务 prompt token（编码场景量级）
const TOK_OUT = arg('out', 2000);    // 单任务 completion token
const PEOPLE = arg('people', 50);    // 团队人数
const TASKS = arg('tasks', 20);      // 人·天任务数
const DAYS = arg('days', 22);        // 月工作日
// 难度分布：底座按难度路由后的实际落档比例（设计稿 §3 混合路由假设）
const MIX = { small: 0.6, medium: 0.3, large: 0.1 };

// ---- 计算 ----
const cost = (tier) =>
    (TOK_IN / 1e6) * DEFAULT_PRICING[tier].input + (TOK_OUT / 1e6) * DEFAULT_PRICING[tier].output;
const r = (n) => Math.round(n * 1e6) / 1e6;

const perTier = Object.fromEntries(Object.keys(DEFAULT_PRICING).map((t) => [t, cost(t)]));
const mixed = Object.entries(MIX).reduce((sum, [tier, ratio]) => sum + perTier[tier] * ratio, 0);
const baseline = perTier.large;
const savedPct = ((baseline - mixed) / baseline) * 100;

const monthlyTasks = PEOPLE * TASKS * DAYS;
const monthBig = baseline * monthlyTasks;
const monthMixed = mixed * monthlyTasks;

// ---- 输出（可截图）----
const line = (a, b, c) => `| ${a} | ${b} | ${c} |`;
console.log('=== Multi-Proxy 省钱测算（定价表模拟，非真实账单）===\n');
console.log(`价表来源：l2/savings-gateway/gateway.js :: DEFAULT_PRICING（每百万 token CNY）`);
console.log(`  small=${DEFAULT_PRICING.small.input}/${DEFAULT_PRICING.small.output}  ` +
    `medium=${DEFAULT_PRICING.medium.input}/${DEFAULT_PRICING.medium.output}  ` +
    `large=${DEFAULT_PRICING.large.input}/${DEFAULT_PRICING.large.output}`);
console.log(`单任务 token：in=${TOK_IN} out=${TOK_OUT}\n`);

console.log('单任务成本：');
console.log('| 路由档位 | 单任务成本(CNY) | 说明 |');
console.log('|---|---|---|');
console.log(line('全走大模型 large', r(baseline), '基线（不用底座）'));
console.log(line('medium（deepseek 档）', r(perTier.medium), '中等难度'));
console.log(line('small（本地/免费档）', r(perTier.small), '低难度，本地模型零边际成本'));
console.log(line(
    `混合路由 ${MIX.small * 100}/${MIX.medium * 100}/${MIX.large * 100}`,
    r(mixed),
    `**省 ${savedPct.toFixed(1)}%**`,
));
console.log('');

console.log(`团队级（${PEOPLE} 人 × ${TASKS} 任务/天 × ${DAYS} 工作日 = ${monthlyTasks} 任务/月）：`);
console.log('| 方案 | 单任务 | 月成本(CNY) |');
console.log('|---|---|---|');
console.log(line('全走大模型', r(baseline), r(monthBig)));
console.log(line('走底座混合路由', r(mixed), r(monthMixed)));
console.log(line('**月省**', '—', `**${r(monthBig - monthMixed)}（年 ≈ ${r((monthBig - monthMixed) * 12)}）**`));
console.log('');
console.log('⚠️ 定价表模拟值，非真实账单。large 档为云端大模型量级估算（可经 PROXY_PRICING_LARGE 覆盖）。');
console.log('   真实流量下数字会变。对外演示用这些数时必须标注「基于内置定价表模拟」。');
