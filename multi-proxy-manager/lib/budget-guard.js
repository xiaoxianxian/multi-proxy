// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== 本地预算闸门（multi-proxy-manager/lib/budget-guard.js，P7 第一层）====================
// 目的：把「这个月别烧超过 X 块」从**脑记**变成**机器判**。吃真实账本
// （cost-ledger.jsonl，P2/P3/P4 那条链路的产出），按周期判级，超了告警。
//
// 🔴 边界（与方案文档 §六-6 对齐，维护者 2026-10-12 拍板）：
//   本模块是**单租户本地**能力——判的是「我自己这台机器这个月花了多少」。
//   不碰多用户账号、不代持余额、不碰充值/开票（那些等公司 + 商业/法务 feasibility，
//   见方案文档 §六 风险红线）。所以这里只有「判级」，没有「扣款」。
//
// 依赖链（P7 排期的依据）：
//   P2 价表 → P3 分时价 → P4 来源标注 → **P7-1 本模块**（没有前三个，预算数就是流沙）
//                 ↘ P7-2 预检（proxy 热路径前置检查，需另拍 fail 策略）↘ P7-3 订阅建模（本地规划）
//
// 纪律（与 P2/P3/P4/P6 同源）：
//   · **没配预算 = 不拦**：budget.json 不存在 / hardCap=0 ⇒ enabled:false，零行为变更。
//   · **算不出的不凑**：账本里 cost 缺失的条目跳过累计，但单独计 unpricedCount——
//     「有 N 笔没价」要和「花了 0 元」区分开（P2「值是 0 ≠ 值不存在」的预算版）。
//   · **周期按本地时区**：用户心里「这个月」是他本地时间的月，不是 UTC 月。
//     配了 timezone（IANA）按它算，没配按本机系统时区——不偷偷按 UTC。
//   · **纯函数/IO 分离**：parse/evaluate/estimate 全纯函数；读账本由调用方
//     （cost-track.readLedgerEntries）负责，测试不碰磁盘。

const PERIODS = ['daily', 'monthly'];
const LEVELS = ['ok', 'warn', 'blocked'];

// 原始 JSON → {ok:true, config} | {ok:false, error}
// 缺省值全部偏向「不拦」：没设周期按月、没设上限 0（0 = 关）、没设告警线 80%。
function parseBudgetConfig(raw) {
  if (raw === null || raw === undefined) return { ok: true, config: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'budget 配置必须是对象' };
  }

  const period = raw.period === undefined ? 'monthly' : raw.period;
  if (!PERIODS.includes(period)) {
    return { ok: false, error: `period 必须是 ${PERIODS.join('/')} 之一，收到: ${JSON.stringify(raw.period)}` };
  }

  const hardCap = raw.hardCap === undefined ? 0 : Number(raw.hardCap);
  if (!Number.isFinite(hardCap) || hardCap < 0) {
    return { ok: false, error: `hardCap 必须是非负数字，收到: ${JSON.stringify(raw.hardCap)}` };
  }

  let warnRatio = raw.warnRatio === undefined ? 0.8 : Number(raw.warnRatio);
  if (!Number.isFinite(warnRatio) || warnRatio <= 0 || warnRatio > 1) {
    return { ok: false, error: `warnRatio 必须是 (0,1] 的数字，收到: ${JSON.stringify(raw.warnRatio)}` };
  }

  if (raw.timezone !== undefined && (typeof raw.timezone !== 'string' || !raw.timezone.trim())) {
    return { ok: false, error: 'timezone 必须是非空字符串（IANA，如 Asia/Shanghai）' };
  }

  const parseScopeCaps = (v, name) => {
    if (v === undefined) return { ok: true, value: {} };
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { ok: false, error: `${name} 必须是 { key: cap } 对象` };
    }
    const out = {};
    for (const [k, cap] of Object.entries(v)) {
      const n = Number(cap);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: `${name}.${k} 必须是非负数字，收到: ${JSON.stringify(cap)}` };
      }
      out[k] = n;
    }
    return { ok: true, value: out };
  };

  const pm = parseScopeCaps(raw.perModel, 'perModel');
  if (!pm.ok) return pm;
  const pa = parseScopeCaps(raw.perAgent, 'perAgent');
  if (!pa.ok) return pa;

  return {
    ok: true,
    config: {
      period,
      hardCap,
      warnRatio,
      timezone: raw.timezone ? raw.timezone.trim() : null,
      perModel: pm.value,
      perAgent: pa.value,
    },
  };
}

// 时间戳 → 周期键。monthly → 'YYYY-MM'；daily → 'YYYY-MM-DD'。
// timezone 缺省 = 本机系统时区（toLocaleDateString 的默认行为），不偷偷按 UTC。
function periodKey(ts, period = 'monthly', timezone = null) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const opts = timezone
    ? { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' };
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(d);
  const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
  const y = get('year'), m = get('month'), day = get('day');
  if (!y || !m) return null;
  return period === 'daily' ? `${y}-${m}-${day}` : `${y}-${m}`;
}

// 最坏情况成本估算（P7-2 预检的原料）：一次请求最多能烧多少钱。
// 口径＝max_tokens 全按输出价算（输入未知/已省；输出通常更贵，取贵的估才叫最坏情况）。
// pricing = { input, output }（每 token 价，与 resolvePricing 同口径）。缺 output 价 → null（不猜 0）。
function estimateWorstCaseCost(maxTokens, pricing) {
  const n = Number(maxTokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pOut = pricing && Number(pricing.output);
  if (!Number.isFinite(pOut) || pOut <= 0) return null;
  return n / 1e6 * pOut;
}

// 剩额够不够覆盖一笔估算。remaining 为 null（没配预算）= 永远够（没预算就不预拒）。
function canAfford(estimate, remaining) {
  if (estimate == null) return true;              // 估不出 → 不预拒（拦不住未知，别误伤）
  if (remaining == null) return true;             // 没设预算 → 不拦
  return estimate <= remaining;
}

/**
 * 账本条目 + 预算配置 → 判级结果。
 * entries: cost-track.readLedgerEntries() 的产出（[{ts, cost, model, agent, pricingSource, ...}]）
 * opts.now: 判定时刻（默认 Date.now()）——决定「当前周期」是哪个月。
 *
 * 返回：
 *   { enabled:false, reason }                      —— 没配预算（零行为变更）
 *   { enabled:true, period, level, spent, cap, remaining, ratio,
 *     perModel, perAgent, exceeded[], entryCount, unpricedCount }
 *     level: 'ok' | 'warn'（≥warnRatio）| 'blocked'（总上限或任一子项上限越过）
 *     exceeded: [{ scope:'total'|'model:x'|'agent:y', spent, cap }]（可能多条）
 */
function evaluateBudget(entries, config, opts = {}) {
  if (!config || !(config.hardCap > 0)) {
    return { enabled: false, reason: 'no-budget-config' };
  }
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const period = periodKey(now, config.period, config.timezone);
  if (!period) {
    return { enabled: false, reason: 'bad-now' };
  }

  let spent = 0;
  let unpricedCount = 0;
  let entryCount = 0;
  const perModel = {};
  const perAgent = {};

  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const key = periodKey(e.ts, config.period, config.timezone);
    if (key !== period) continue;                 // 只累计当前周期
    entryCount++;
    const cost = Number(e.cost);
    if (!Number.isFinite(cost)) { unpricedCount++; continue; }   // 缺 cost：不猜 0，单独计数
    if (e.pricingSource === 'unknown') unpricedCount++;          // 有 0 元账但来源是「没价」⇒ 同算未定价
    spent += cost;
    const model = e.model || '<unknown>';
    const agent = e.agent || e.proxy || '<unknown>';
    perModel[model] = (perModel[model] || 0) + cost;
    perAgent[agent] = (perAgent[agent] || 0) + cost;
  }

  const exceeded = [];
  if (spent >= config.hardCap) {
    exceeded.push({ scope: 'total', spent, cap: config.hardCap });
  }
  for (const [m, cap] of Object.entries(config.perModel)) {
    const s = perModel[m] || 0;
    if (cap > 0 && s >= cap) exceeded.push({ scope: `model:${m}`, spent: s, cap });
  }
  for (const [a, cap] of Object.entries(config.perAgent)) {
    const s = perAgent[a] || 0;
    if (cap > 0 && s >= cap) exceeded.push({ scope: `agent:${a}`, spent: s, cap });
  }

  let level = 'ok';
  if (exceeded.length > 0) level = 'blocked';
  else if (config.hardCap > 0 && spent / config.hardCap >= config.warnRatio) level = 'warn';

  return {
    enabled: true,
    period,
    level,
    spent,
    cap: config.hardCap,
    remaining: Math.max(0, config.hardCap - spent),
    ratio: config.hardCap > 0 ? spent / config.hardCap : null,
    warnRatio: config.warnRatio,
    perModel,
    perAgent,
    exceeded,
    entryCount,
    unpricedCount,
  };
}

module.exports = {
  PERIODS,
  LEVELS,
  parseBudgetConfig,
  periodKey,
  estimateWorstCaseCost,
  canAfford,
  evaluateBudget,
};
