// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== 模型目录导入 · 纯函数层（lib/model-catalog.js）====================
// P5 后半：把外部模型元数据（basellm/llm-metadata）导入本站价表。
//
// 🔴🔴 本模块的唯一 hard part 是**语义反转**，先读这段再动代码：
//
//   llm-metadata（上游）语义：base cost = **off-peak（闲时）价**；
//     schedule.windows 里放的是 **peak（高峰）溢价**，fallback:"off_peak" 明写
//     「窗口外按闲时收」。样例（deepseek-flash，CNY 档）：
//       base {input:1, output:4, cache_read:0.02}
//       windows[{name:"peak", weekdays:[1-5], hours:["01:00-04:00","06:00-10:00"],
//                input:2, output:8, cache_read:0.04}]
//
//   本站 pricing.json 语义（与 LiteLLM off_peak_pricing 对齐，见 pricing-schedule.js
//   头部「两处刻意差异」）：pricing = **标准/peak 价**；
//     offPeakPricing.windows 定义的是 **off-peak（便宜档）窗口**，命中才打折。
//
//   ⇒ 导入 = 求补集 + 交换 base/window：
//       我方 pricing            = 它的 peak 窗口价（它没有 schedule 时才是它的 base）
//       我方 offPeakPricing.pricing = 它的 base（闲时）价
//       我方 offPeakPricing.windows = 它 peak 窗口在「全周」上的**补集**
//
// ⚠️ 别把这层反转「简化」掉：若把它的 base 当我方标准价直接落，高峰流量会全按闲时价
//    计费 —— 一类静默错账，且数字看起来完全合理（因为闲时价本身就是官方价）。
//
// 其它纪律（与 P2/P3/P4 同源）：
//   · **add-only**：existingIds 里已有的 id 一律跳过，用户手填表永远赢。
//   · **绝不造 0**：没有 cost 的模型整条跳过（落 unknown），不拿 0 充数。
//   · **来源可回源**：每条导入都带 retrievedAt + sourceUrl + 币种 + 反转说明。
//   · **fail-safe 偏向「不导入 schedule」**：fallback 不是 off_peak、时区不是 UTC、
//     多个窗口价格不一致、窗口畸形 —— 任何一种都只落 base 价并把原因写进 priceSource，
//     绝不猜一个窗口出来。

const { parseWindowRange, normalizeWeekday } = require('./pricing-schedule');

const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]; // ISO: Mon=1 … Sun=7
const MINUTES_PER_DAY = 1440;

// 数值清洗：undefined/null/非数字 → null（调用方据此判「没价」）；0 是合法值。
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "01:00" → 60。畸形 → null。复用 pricing-schedule 的解析（同一套半开区间语义，
// 不另造一套，避免两处实现漂移）。
function parseHour(h) {
  if (typeof h !== 'string') return null;
  const i = h.indexOf('-');
  if (i <= 0 || i === h.length - 1) return null;
  const s = parseWindowRange(h);
  return s; // {start,end}；start===end 表示全天（LiteLLM 写法）
}

// 把 llm-metadata 的 peak 窗口集合求「全周补集」，转换成本站 off-peak windows 形状。
//
// 输入：llm-metadata schedule.windows —— [{ weekdays?: number[], hours?: string[] }]
//   语义：weekdays 缺失 = 全周；hours 缺失 = 这些星期全天 peak。
// 输出：本站 windows —— [{ hoursUtc: string[], weekdays: number[] }]
//   · 全周 off-peak 的写法用 "00:00-00:00"（LiteLLM 全天约定，本站同款）。
//   · 某星期**完全没有** off-peak 时间（全天 peak）⇒ 不出现在输出里。
//   · 输出为空数组 = 全周全 peak ⇒ 调用方应放弃 schedule（没便宜档可打）。
//
// 返回 null = 输入畸形（weekday/hours 解析失败）⇒ 调用方放弃 schedule 导入。
function complementPeakWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return null;

  // 1) 每个星期一张 1440 分钟的 peak 布尔表
  const peak = {};
  for (const d of ALL_WEEKDAYS) peak[d] = new Array(MINUTES_PER_DAY).fill(false);

  for (const win of windows) {
    if (!win || typeof win !== 'object') return null;

    // weekdays：缺失 = 全周；写了就逐个归一（有一个畸形 ⇒ 整体放弃）
    let days;
    if (win.weekdays == null) {
      days = ALL_WEEKDAYS;
    } else {
      if (!Array.isArray(win.weekdays)) return null;
      days = win.weekdays.map(normalizeWeekday);
      if (days.some((d) => d == null)) return null;
    }

    // hours：缺失 = 这些星期全天 peak；写了逐个解析
    let ranges;
    if (win.hours == null) {
      ranges = [{ start: 0, end: 0 }]; // start===end = 全天
    } else {
      const list = Array.isArray(win.hours) ? win.hours : [win.hours];
      ranges = list.map(parseHour);
      if (ranges.some((r) => r == null)) return null;
    }

    for (const d of days) {
      for (const r of ranges) {
        if (r.start === r.end) {
          peak[d].fill(true); // 全天
        } else if (r.start < r.end) {
          for (let m = r.start; m < r.end; m += 1) peak[d][m] = true;
        } else {
          // 跨零点：[start,24:00) ∪ [00:00,end)
          for (let m = r.start; m < MINUTES_PER_DAY; m += 1) peak[d][m] = true;
          for (let m = 0; m < r.end; m += 1) peak[d][m] = true;
        }
      }
    }
  }

  // 2) 每天取补集，连续段合成 "HH:MM-HH:MM"
  const perDay = {};
  for (const d of ALL_WEEKDAYS) {
    const segs = [];
    let runStart = -1;
    for (let m = 0; m <= MINUTES_PER_DAY; m += 1) {
      const isOff = m < MINUTES_PER_DAY && !peak[d][m];
      if (isOff && runStart === -1) runStart = m;
      if (!isOff && runStart !== -1) {
        segs.push(fmtRange(runStart, m));
        runStart = -1;
      }
    }
    if (segs.length > 0) perDay[d] = segs;
  }

  // 3) 按「补集形状」分组星期（同形状合成一个 window，与本站现表的手写分组同构）。
  //    输出按组内最小星期排序 —— 纯为确定性（同输入永远同输出，便于 diff 与快照测试）。
  const groups = new Map();
  for (const d of ALL_WEEKDAYS) {
    const segs = perDay[d];
    if (!segs) continue; // 全天 peak，没有 off-peak 时间
    const key = segs.join(',');
    if (!groups.has(key)) groups.set(key, { hoursUtc: segs, weekdays: [] });
    groups.get(key).weekdays.push(d);
  }
  return [...groups.values()].sort((a, b) => a.weekdays[0] - b.weekdays[0]);
}

function fmtRange(startMin, endMin) {
  if (startMin === 0 && endMin === MINUTES_PER_DAY) return '00:00-00:00'; // 全天约定
  // 🔴 末端在午夜必须写成 wrapping 形式 "HH:MM-00:00"（半开区间跨零点），
  // 不能写 "HH:MM-24:00" —— 本站 parseHhmm 规定小时 ≤23，"24:00" 是畸形 ⇒
  // 该窗口永不命中 ⇒ 高峰全价（静默错账）。这一条有单测钉着（round-trip 不变式）。
  if (endMin === MINUTES_PER_DAY) return `${fmtMin(startMin)}-00:00`;
  return `${fmtMin(startMin)}-${fmtMin(endMin)}`;
}

function fmtMin(m) {
  const h = Math.floor(m / 60);
  const mi = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

// 单模型 cost → 本站价表条目形状。
// 返回 null = 没有可用价格（调用方整条跳过，绝不造 0）。
// 返回 { pricing, offPeakPricing?, note } —— note 非空表示有未决事项，调用方须写进 priceSource。
function convertLlmMetadataCost(cost, opts = {}) {
  if (!cost || typeof cost !== 'object') return null;
  const preferCurrency = opts.preferCurrency || 'CNY';

  // 币种选择：优先 CNY（本站现表即 CNY 口径：deepseek 2/8/0.04 = 它的 CNY peak）。
  // 没有 CNY 档 ⇒ 回落它的 base（USD）。
  let picked = cost;
  let currency = 'USD(base)';
  const co = cost.currency_options;
  if (co && typeof co === 'object' && co[preferCurrency] && typeof co[preferCurrency] === 'object') {
    picked = co[preferCurrency];
    currency = preferCurrency;
  }

  const base = {
    input: num(picked.input),
    output: num(picked.output),
    cacheHit: num(picked.cache_read),
  };
  // input/output 全没有 ⇒ 没价。（cache_read 单独存在不足以计费，同样算没价。）
  if (base.input == null && base.output == null) return null;

  const schedule = picked.schedule;
  if (!schedule || typeof schedule !== 'object' || !Array.isArray(schedule.windows) || schedule.windows.length === 0) {
    // 无 schedule：它的 base 就是唯一价（无 peak 概念），平铺落入。
    return { pricing: base, currency };
  }

  // ── 有 schedule：执行反转 ──
  if (schedule.fallback !== 'off_peak') {
    // 反转的正确性完全建立在「窗口外 = 闲时」上；fallback 不同 ⇒ 不猜。
    return { pricing: base, currency, note: `schedule.fallback="${schedule.fallback}" 不是 off_peak ⇒ 未反转，仅落它的 base（=闲时）价，高峰会低估` };
  }
  if (schedule.timezone && schedule.timezone !== 'UTC') {
    // 本站 hoursUtc 恒 UTC；它的 hours 挂在别的时区上，无法无损换算 ⇒ 不导 schedule。
    return { pricing: base, currency, note: `schedule.timezone="${schedule.timezone}" 非 UTC，hours 无法无损映射到 hoursUtc ⇒ 未反转，仅落 base（=闲时）价，高峰会低估` };
  }

  // peak 价 = 窗口价。多个窗口必须一致，否则不知道哪个是 peak。
  const seen = new Map();
  for (const w of schedule.windows) {
    if (!w || typeof w !== 'object') return { pricing: base, currency, note: 'schedule.windows 含非对象项 ⇒ 未反转，仅落 base（=闲时）价' };
    const key = JSON.stringify({ i: num(w.input), o: num(w.output), c: num(w.cache_read) });
    if (!seen.has(key)) seen.set(key, { input: num(w.input), output: num(w.output), cacheHit: num(w.cache_read) });
  }
  if (seen.size !== 1) {
    return { pricing: base, currency, note: `schedule.windows 价格不一致（${seen.size} 种）⇒ 未反转，仅落 base（=闲时）价，高峰会低估` };
  }
  const peak = [...seen.values()][0];
  // 窗口三项全空 = 没价可反转
  if (peak.input == null && peak.output == null) {
    return { pricing: base, currency, note: 'schedule.windows 无 input/output 价 ⇒ 未反转，仅落 base（=闲时）价' };
  }

  const offPeakWindows = complementPeakWindows(schedule.windows);
  if (offPeakWindows === null) {
    return { pricing: base, currency, note: 'schedule.windows 畸形（weekday/hours 解析失败）⇒ 未反转，仅落 base（=闲时）价' };
  }
  if (offPeakWindows.length === 0) {
    // 全周全是 peak ⇒ 没有便宜档，标准价即 peak 价，不需要 offPeakPricing。
    return { pricing: peak, currency, note: '全周均无 off-peak 时间 ⇒ 落 peak 价为标准价，未配 offPeakPricing' };
  }

  return {
    pricing: peak, // 我方标准价 = 它的 peak 价
    currency,
    offPeakPricing: {
      windows: offPeakWindows,
      pricing: base, // 我方闲时价 = 它的 base 价
    },
  };
}

// 整目录导入：llm-metadata dist/api/all.json → 本站价表条目数组。
//
// allJson 形状（2026-10-12 核对的真实 schema）：
//   { "<providerId>": { models: { "<modelId>": { id, cost: {...}, limit: {...}, ... } } } }
//
// 返回 { entries, skipped }：
//   entries —— 可直接并入 pricing.json 的条目（含 priceSource / retrievedAt）
//   skipped —— [{ id, reason }]，供 dry-run 展示「为什么没导」
function importLlmMetadataCatalog(allJson, opts = {}) {
  const existingIds = opts.existingIds instanceof Set ? opts.existingIds : new Set(opts.existingIds || []);
  const retrievedAt = opts.retrievedAt || new Date().toISOString().slice(0, 10);
  const sourceUrl = opts.sourceUrl || 'https://github.com/basellm/llm-metadata（dist/api/all.json）';
  const preferCurrency = opts.preferCurrency || 'CNY';

  const entries = [];
  const skipped = [];
  if (!allJson || typeof allJson !== 'object') {
    return { entries, skipped: [{ id: '*', reason: 'all.json 不是对象' }] };
  }

  // 本轮内也 add-only：llm-metadata 里同一模型 id 会挂在多个 provider 下
  //（实测 kimi-k2.6 同时出现在 moonshotai 与 moonshotai-cn，价格不同）。
  // 先到赢（Object.entries 顺序 = all.json 的 provider 顺序），后者记跳过理由 ——
  // 同 id 两条价会让 _registerModelPricing 的注册结果取决于遍历顺序，是隐性不确定源。
  const taken = new Set(existingIds);

  for (const [providerId, provider] of Object.entries(allJson)) {
    const models = provider && typeof provider === 'object' ? provider.models : null;
    if (!models || typeof models !== 'object') continue;

    for (const [modelKey, model] of Object.entries(models)) {
      const id = (model && model.id) || modelKey;
      if (taken.has(id)) {
        skipped.push({
          id,
          reason: existingIds.has(id)
            ? '用户价表已有同 id 条目（add-only，用户表优先）'
            : `本轮已从另一供应商导入同 id 模型（先到赢；llm-metadata 中 ${providerId} 与前列 provider 重名）`,
        });
        continue;
      }
      const conv = convertLlmMetadataCost(model && model.cost, { preferCurrency });
      if (!conv) {
        skipped.push({ id, reason: '无 cost 或 input/output 均缺失（不造 0，落 unknown）' });
        continue;
      }
      taken.add(id);

      const canonical = model && model.canonical_model_id ? `；canonical=${model.canonical_model_id}` : '';
      let priceSource = `llm-metadata@${retrievedAt}（${sourceUrl}）；币种=${conv.currency}${canonical}。`;
      if (conv.offPeakPricing) {
        priceSource += 'schedule 已反转：本站标准价=其 peak 窗口价，off-peak 窗口=其 peak 窗口的全周补集（半开区间，可跨零点）。';
      }
      if (conv.note) priceSource += `⚠️ ${conv.note}`;

      const entry = {
        id,
        pricing: conv.pricing,
        retrievedAt,
        priceSource,
      };
      if (conv.offPeakPricing) {
        entry.offPeakPricing = {
          windows: conv.offPeakPricing.windows,
          pricing: conv.offPeakPricing.pricing,
          priceSource: `窗口来自 llm-metadata@${retrievedAt} peak 窗口补集；判定逻辑同 LiteLLM off_peak_pricing 规格（hours 恒 UTC、不配 weekdayTimezone 即按 UTC 判工作日）。`,
        };
      }
      entries.push(entry);
    }
  }
  return { entries, skipped };
}

module.exports = {
  complementPeakWindows,
  convertLlmMetadataCost,
  importLlmMetadataCatalog,
  // 供测试/脚本复用
  _internals: { num, parseHour, fmtRange, fmtMin },
};
