#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * cost-per-success.js — 按「每成功任务成本」复算一份评测记录，并对两组差异做显著性判定。
 *
 * 为什么单独一个文件：
 *   内核只有 per-request 的 token 账本（cost-ledger.jsonl），答不了「跑完一件事花多少钱」。
 *   协议见 docs/EVAL-成本验收协议-2026-10-18.md。本脚本不联网、不调模型，只做离线复算，
 *   所以任何一次评测的结论都能被别人拿同一份 JSONL 复现。
 *
 * 为什么主指标不是「省了百分之几」：
 *   省钱比例的分母可以随便挑（通常挑最贵那一档），而「每成功任务成本 = 总花费 ÷ 完整通过数」
 *   的分母是硬约束 —— 干不完的活不计入成功数，钱却照样花出去了，赖不掉。
 *
 * 为什么内置 Fisher 精确检验：
 *   n=24 时 20/24 vs 17/24 差 3 次，p≈0.49，是噪声。不报 p 值的对照表，
 *   等于把噪声写成结论（这是 2026-10-18 那篇厂商实测稿的原病）。
 *
 * 用法：
 *   node scripts/cost-per-success.js <runs.jsonl> [--baseline=<group>]
 *   node scripts/cost-per-success.js --selftest
 *
 * 记录格式（一行一次运行，UTF-8 JSONL）：
 *   {"task_id":"t01","group":"multi-proxy","passed":true,"duration_s":139.7,
 *    "cost_cny":0.0372,"judge_cost_cny":0.001,"steps":3}
 *   必填：task_id group passed duration_s cost_cny
 *   选填：judge_cost_cny（判定层自身花费，缺省 0）steps
 */

'use strict';

const fs = require('fs');

// ---------- 统计内核（纯函数） ----------

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/**
 * 2x2 表的 Fisher 精确检验（双侧）。
 * @param {number} a 组1通过数
 * @param {number} n1 组1总数
 * @param {number} b 组2通过数
 * @param {number} n2 组2总数
 * @returns {number} p 值
 */
function fisherTwoSided(a, n1, b, n2) {
  const total = n1 + n2;
  const k = a + b;
  const logDenom = logChoose(total, k);
  const prob = (x) => Math.exp(logChoose(n1, x) + logChoose(n2, k - x) - logDenom);
  const p0 = prob(a);
  const lo = Math.max(0, k - n2);
  const hi = Math.min(n1, k);
  let sum = 0;
  for (let x = lo; x <= hi; x += 1) {
    const p = prob(x);
    if (p <= p0 * (1 + 1e-9)) sum += p;
  }
  return Math.min(1, sum);
}

// ---------- 聚合 ----------

// 计费口径标签：cost_cny 是 0 有两种完全不同的意思——「免费」和「不知道」。
// 分不清这两个，就会有人拿 0 当分母算出「省了 100%」。这里把口径显式化。
const BASIS_LABEL = {
  'unbillable:subscription': '订阅制·不可折金额',
  'zero:local': '本地·0 元',
  'unknown-model': '价表缺此模型',
  unavailable: '网关未回传',
};

function isBillable(basis) {
  return typeof basis === 'string' && basis.startsWith('pricing-table@');
}

function basisLabel(list) {
  return list.map((b) => (isBillable(b) ? `价表@${b.split('@')[1]}` : (BASIS_LABEL[b] || b))).join('/');
}

function aggregate(rows, unit = 'cost') {
  const byGroup = new Map();
  const amount = (r) => (unit === 'tokens' ? (r.in_tok || 0) + (r.out_tok || 0) : r.cost_cny);
  for (const r of rows) {
    if (!byGroup.has(r.group)) {
      byGroup.set(r.group, { group: r.group, runs: 0, passed: 0, duration: 0, cost: 0, judgeCost: 0, tasks: new Set(), bases: new Set() });
    }
    const g = byGroup.get(r.group);
    g.runs += 1;
    g.passed += r.passed ? 1 : 0;
    g.duration += r.duration_s;
    g.cost += amount(r);
    g.judgeCost += r.judge_cost_cny || 0;
    g.tasks.add(r.task_id);
    g.bases.add(r.cost_basis || 'unavailable');
  }

  return [...byGroup.values()].map((g) => {
    const bases = [...g.bases];
    return {
      group: g.group,
      runs: g.runs,
      passed: g.passed,
      tasks: g.tasks.size,
      passRate: g.runs ? g.passed / g.runs : null,
      meanLatencyS: g.runs ? g.duration / g.runs : null,
      totalCost: g.cost,
      // 分母守卫：一次都没成功时「每成功任务成本」不存在，不是 Infinity
      costPerSuccess: g.passed ? g.cost / g.passed : null,
      judgeCostRatio: g.cost ? g.judgeCost / g.cost : null,
      bases,
      // 全组每行都拿到官方单价，这组才配谈「钱」。掺一行不可折的，整组的金额结论作废。
      billable: bases.length > 0 && bases.every(isBillable),
    };
  });
}

// ---------- 读文件 ----------

function parseLine(line, idx) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (e) {
    throw new Error(`第 ${idx} 行不是合法 JSON：${e.message}`);
  }
  const need = ['task_id', 'group', 'passed', 'duration_s', 'cost_cny'];
  for (const key of need) {
    if (!(key in obj)) throw new Error(`第 ${idx} 行缺字段 ${key}`);
  }
  if (typeof obj.passed !== 'boolean') {
    // invalid=true 的行是账号/额度问题，passed 允许为 false 但会被过滤，不会进统计
    if (obj.invalid !== true) throw new Error(`第 ${idx} 行 passed 必须是布尔值`);
  }
  for (const key of ['duration_s', 'cost_cny']) {
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key])) {
      throw new Error(`第 ${idx} 行 ${key} 必须是有限数字`);
    }
  }
  if (obj.judge_cost_cny != null && typeof obj.judge_cost_cny !== 'number') {
    throw new Error(`第 ${idx} 行 judge_cost_cny 必须是数字`);
  }
  return obj;
}

function loadRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  const all = text.split('\n')
    .map((l, i) => ({ line: l.trim(), idx: i + 1 }))
    .filter((x) => x.line && !x.line.startsWith('#'))
    .map((x) => parseLine(x.line, x.idx));
  // 作废行（账号/额度导致的中断）不计入统计，但要把条数说出来，不许静默丢。
  const valid = all.filter((r) => r.invalid !== true);
  const voided = all.length - valid.length;
  if (voided) console.log(`⚠️ 跳过 ${voided} 条作废记录（invalid=true，账号或额度问题，非模型能力）\n`);
  return valid;
}

// ---------- 输出 ----------

function report(rows, baseline, unit = 'cost') {
  const stats = aggregate(rows, unit);
  if (!stats.length) throw new Error('没有任何记录');
  const base = baseline || (stats.find((s) => s.group === 'baseline') || stats[0]).group;
  const baseStat = stats.find((s) => s.group === base);
  if (!baseStat) throw new Error(`找不到基准组 ${base}`);

  const pad = (v, n) => String(v).padStart(n);
  const money = (v) => (v == null ? '—' : v.toFixed(unit === 'tokens' ? 0 : 4));
  const unitLabel = unit === 'tokens' ? 'token' : '花费';

  const showMoney = (s) => unit === 'tokens' || s.billable;

  console.log(`基准组：${base}${unit === 'tokens' ? '（口径：token，网关未回传计费时用）' : ''}\n`);
  console.log(`组                运行  通过  完成率   平均等待s   总${unitLabel}    每成功任务${unitLabel}  计费口径`);
  for (const s of stats) {
    console.log(
      `${s.group.padEnd(16)} ${pad(s.runs, 4)} ${pad(s.passed, 5)} `
      + `${pad(s.passRate == null ? '—' : `${(s.passRate * 100).toFixed(1)}%`, 7)} `
      + `${pad(s.meanLatencyS == null ? '—' : s.meanLatencyS.toFixed(1), 11)} `
      + `${pad(showMoney(s) ? money(s.totalCost) : '—', 8)} `
      + `${pad(showMoney(s) ? money(s.costPerSuccess) : '—', 14)} ${basisLabel(s.bases)}`,
    );
  }

  // 钱账安全阀：只要有一组拿不到官方单价，全局就不给金额结论。
  // 理由：不可折的那组 cost 记的是 0，拿它进分母就是「省了 100%」。
  // 这不是保守，是把「不知道」和「免费」分开——后者会被当成结论传播。
  const notBillable = stats.filter((s) => !s.billable);
  if (unit === 'cost' && notBillable.length) {
    console.log(`\n⚠️ 金额结论不可用：以下组没拿到官方单价，金额列已置空（记 0 是「不知道」，不是「免费」）：`);
    for (const s of notBillable) {
      console.log(`   ${s.group.padEnd(16)} ${basisLabel(s.bases)}`);
    }
    console.log('   想比钱，先补价表（eval/2026-10-18/pricing.py 的 PRICING / UNBILLABLE）；');
    console.log('   想现在就比，用 --unit=tokens 看 token 账——它不等同钱，但至少分母是实的。');
  }

  console.log('\n与基准组的差异（Fisher 精确检验，双侧）：');
  for (const s of stats) {
    if (s.group === base) continue;
    const p = fisherTwoSided(s.passed, s.runs, baseStat.passed, baseStat.runs);
    const verdict = p < 0.05 ? '显著' : '不显著（当噪声处理）';
    const cp = s.costPerSuccess;
    const cpBase = baseStat.costPerSuccess;
    const comparable = showMoney(s) && showMoney(baseStat);
    const ratio = comparable && cp != null && cpBase ? `${((1 - cp / cpBase) * 100).toFixed(1)}%` : '不可比';
    console.log(`  ${s.group} vs ${base}: 完成率差 ${s.passed - baseStat.passed} 次，p=${p.toFixed(4)} → ${verdict}；每成功任务${unitLabel}差 ${ratio}`);
  }

  console.log('\n⚠️ 判读纪律：p≥0.05 时不得写「通过率更高/更低」，只能写「未见显著差异」。');
  return { stats, base };
}

// ---------- 自测 ----------

function selftest() {
  const assert = require('assert');
  const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) < tol, `${a} !≈ ${b}`);

  // 2026-10-18 TierFlow 实测稿的三组对照，用来验证「3 次差距是噪声」
  near(fisherTwoSided(20, 24, 17, 24), 0.4936);
  near(fisherTwoSided(20, 24, 16, 24), 0.3177);
  near(fisherTwoSided(17, 24, 16, 24), 1.0);
  // 极端差异仍应显著
  assert.ok(fisherTwoSided(24, 24, 0, 24) < 0.001);
  // 对称性
  near(fisherTwoSided(20, 24, 17, 24), fisherTwoSided(17, 24, 20, 24));

  // 分母守卫：全失败时每成功任务成本为 null
  const allFail = aggregate([
    { group: 'a', task_id: 't1', passed: false, duration_s: 10, cost_cny: 1 },
    { group: 'a', task_id: 't2', passed: false, duration_s: 20, cost_cny: 1 },
  ]);
  assert.strictEqual(allFail[0].costPerSuccess, null);
  assert.strictEqual(allFail[0].meanLatencyS, 15); // 失败不进剔除

  // 每成功任务成本 = 总花费 / 通过数
  const mixed = aggregate([
    { group: 'b', task_id: 't1', passed: true, duration_s: 10, cost_cny: 0.5, judge_cost_cny: 0.1 },
    { group: 'b', task_id: 't2', passed: false, duration_s: 30, cost_cny: 1.5 },
  ]);
  assert.strictEqual(mixed[0].costPerSuccess, 2); // 2.0 / 1
  assert.strictEqual(Number(mixed[0].judgeCostRatio.toFixed(4)), Number((0.1 / 2.0).toFixed(4)));

  // 缺字段要报错，且报出行号
  assert.throws(() => parseLine('{"task_id":"t1","group":"a","passed":true}', 7), /第 7 行缺字段 duration_s/);

  // 作废行（invalid=true）允许 passed:false 走过校验，普通行不允许
  const voidRow = parseLine('{"task_id":"t1","group":"a","passed":false,"duration_s":0.4,"cost_cny":0,"invalid":true}', 1);
  assert.strictEqual(voidRow.invalid, true);
  assert.throws(() => parseLine('{"task_id":"t1","group":"a","passed":"no","duration_s":1,"cost_cny":0}', 2), /passed 必须是布尔值/);

  // 计费口径：cost=0 有两种意思，必须靠 basis 区分，否则「不知道」会被当「免费」进分母
  assert.ok(isBillable('pricing-table@2026-09-23'));
  assert.ok(!isBillable('unbillable:subscription'));
  assert.ok(!isBillable('zero:local'));
  assert.ok(!isBillable('unknown-model'));
  assert.ok(!isBillable(undefined)); // 老记录没这个字段 → 不可计费，不许蒙混过关

  // 全组每行都有官方单价 → 这组才配谈钱
  const billed = aggregate([
    { group: 'kimi', task_id: 't1', passed: true, duration_s: 10, cost_cny: 0.18, cost_basis: 'pricing-table@2026-09-23' },
    { group: 'kimi', task_id: 't2', passed: true, duration_s: 12, cost_cny: 0.20, cost_basis: 'pricing-table@2026-09-23' },
  ]);
  assert.strictEqual(billed[0].billable, true);

  // 掺一行不可折的，整组金额结论作废（宁可全废，也不让半真半假的数进报告）
  const halfBilled = aggregate([
    { group: 'mix', task_id: 't1', passed: true, duration_s: 10, cost_cny: 0.18, cost_basis: 'pricing-table@2026-09-23' },
    { group: 'mix', task_id: 't2', passed: true, duration_s: 12, cost_cny: 0.0, cost_basis: 'unbillable:subscription' },
  ]);
  assert.strictEqual(halfBilled[0].billable, false);

  // 订阅制组即使花费记 0，也必须被拦住
  const subs = aggregate([
    { group: 'agnes', task_id: 't1', passed: true, duration_s: 3, cost_cny: 0.0, cost_basis: 'unbillable:subscription' },
  ]);
  assert.strictEqual(subs[0].billable, false);
  assert.strictEqual(subs[0].totalCost, 0);
  assert.strictEqual(basisLabel(subs[0].bases), '订阅制·不可折金额');
  assert.strictEqual(basisLabel(billed[0].bases), '价表@2026-09-23');

  console.log('selftest: 21 项全过');
}

// ---------- 入口 ----------

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('用法：node scripts/cost-per-success.js <runs.jsonl> [--baseline=<group>] | --selftest');
    process.exit(1);
  }
  const baselineArg = args.find((a) => a.startsWith('--baseline='));
  const baseline = baselineArg ? baselineArg.split('=')[1] : null;
  const unitArg = args.find((a) => a.startsWith('--unit='));
  const unit = unitArg ? unitArg.split('=')[1] : 'cost';
  if (!['cost', 'tokens'].includes(unit)) {
    console.error('--unit 只支持 cost 或 tokens');
    process.exit(1);
  }
  return report(loadRows(file), baseline, unit);
}

if (require.main === module) main();

module.exports = { aggregate, fisherTwoSided, parseLine, loadRows, report };
