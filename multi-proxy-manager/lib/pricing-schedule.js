// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 分时定价 · 纯函数层（lib/pricing-schedule.js）
//
// 规格来源：LiteLLM `model_info.off_peak_pricing`（2026-10-12 调研，其 Rust 侧
// litellm_rs/core/pricing/time_of_use.rs 有完整单测）。抄它而不是自造，是因为它把
// 几条**反直觉**的边界都定死了，自己拍脑袋必踩：
//
//   ① `hours_utc` **恒为 UTC**；`weekday_timezone` **只**决定 weekday 归属，不换算小时。
//      （直觉做法是把小时也按时区换算 —— 错。那样同一份配置在不同机器上线的行为会漂移，
//      而且夏令时切换当天会多算/少算一小时。）
//   ② 窗口是**半开区间** [start, end)，且允许跨零点（"10:00-01:00" 合法）。
//   ③ 🔴 **畸形窗口 / 畸形 weekday 永不匹配** ⇒ 打错字按**标准价**收，而不是在错误的
//      时间打出折扣。原文：
//        "Malformed windows and weekday values never match, so a typo in the
//         schedule bills at the standard rate rather than applying the discount
//         at the wrong time"
//      ⇒ **fail-safe 的方向是标准价，不是 0**。这与本站「来源是 unknown 就标 unknown，
//        绝不凑 0」是同一条纪律（也与我们 2026-10-12 把 A/B 脚本的「0 元」改成
//        n/a 是同一件事）。
//   ④ **逐项覆盖**（input / output / cacheHit）：未设的项 fallback 到标准价，不是
//      整个档位全有或全无。原文 "any of them left unset falls back to the standard rate"。
//   ⑤ 按 **completion time** 计价：跨窗口的整单按「响应完成那一刻」那一档算，语义
//      明确、不留「请求发起 vs 响应结束」的扯皮空间。
//
// 🔴 本模块只做**窗口判定 + 价格 overlay**：不读 env、不碰 state、不落账。
//    纯函数才能被单测钉死；取价的唯一出口仍然在 cost-track.js 的 resolvePricing。
//
// ── 与 LiteLLM 的两处刻意差异（都写在注释里，别当 bug 修）──
//   · 单位：LiteLLM 用 per-token（科学计数法 1.35e-7），本站 providers.json 沿用
//     **每百万 tokens**（pricing.input=2 意为 ¥2/M）。overlay 前后单位必须一致。
//   · 语义：本模块的 windows 定义的是 **off-peak（便宜档）窗口**，命中则用
//     offPeakPricing.pricing；未命中用标准价 pricing。所以 providers.json 里的
//     pricing 应当填 **peak/标准价**，别填闲时价再指望系统给你乘回去。

// weekday 归一到 ISO 1..7（Mon=1 … Sun=7）。
// 返回 null 表示畸形 —— 调用方拿到 null 必须让窗口**永不匹配**（fail-safe 标准价）。
const WEEKDAY_NAMES = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

function normalizeWeekday(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 7 ? v : null;
  if (typeof v === 'string') return WEEKDAY_NAMES[v.trim().toLowerCase()] || null;
  return null;
}

// "10:00" → 600（当日已过分钟数）。畸形 → null。
// 允许个位小时（"9:30"），但分钟必须两位（防止 "9:5" 被读成 9:05 还是 9:50 的歧义）。
function parseHhmm(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// "10:00-01:00" → { start: 600, end: 60 }（end < start 即跨零点）。畸形 → null。
function parseWindowRange(r) {
  if (typeof r !== 'string') return null;
  const i = r.indexOf('-');
  if (i <= 0 || i === r.length - 1) return null;
  const start = parseHhmm(r.slice(0, i));
  const end = parseHhmm(r.slice(i + 1));
  if (start == null || end == null) return null;
  return { start, end };
}

// 半开区间 [start, end)。
//   start === end  → 全天（LiteLLM 用 "00:00-00:00" 表达「整天」，这是它的写法）
//   start < end    → 同一天内
//   start > end    → 跨零点
function minutesInRange(m, r) {
  if (r.start === r.end) return true;
  if (r.start < r.end) return m >= r.start && m < r.end;
  return m >= r.start || m < r.end;
}

// tsMs 在 UTC 下已过分钟数（0..1439）
function utcMinutes(tsMs) {
  const d = new Date(tsMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 某时刻在**指定 IANA 时区**下是星期几（ISO 1..7）。
//   · tz 缺失/空 → 按 **UTC** 判（hours 本来就恒 UTC，不配时区时让两套基准统一，
//     比「猜一个本地时区」更不容易出错）。
//   · tz **写了但不合法**（Intl 抛 RangeError）→ 返回 null ⇒ 窗口永不匹配 ⇒ 标准价。
//     🔴 这是 fail-safe 的关键一环：时区写错不该让折扣在错误的时间生效。
function weekdayInTz(tsMs, tz) {
  if (typeof tz !== 'string' || !tz.trim()) {
    const d = new Date(tsMs);
    return d.getUTCDay() === 0 ? 7 : d.getUTCDay();   // JS getUTCDay: 0=Sun → 归一成 7
  }
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
      .format(new Date(tsMs));
    return WEEKDAY_NAMES[s.slice(0, 3).toLowerCase()] || null;
  } catch {
    return null;
  }
}

// 单个窗口是否命中。任何畸形一律 false（永不匹配）。
function windowMatches(win, tsMs, weekdayNow) {
  if (!win || typeof win !== 'object') return false;

  // weekdays：可选。写了就限定星期；不写表示「不限星期」。
  if (win.weekdays != null) {
    if (!Array.isArray(win.weekdays)) return false;
    const norm = win.weekdays.map(normalizeWeekday);
    if (norm.some((x) => x == null)) return false;   // 有一个畸形 ⇒ 整窗永不匹配
    if (weekdayNow == null) return false;
    if (!norm.includes(weekdayNow)) return false;
  }

  // hoursUtc：不写（但有 weekdays）⇒ 该星期**整天**都算，这是「周末全天」的简写。
  if (win.hoursUtc == null) return true;

  const list = Array.isArray(win.hoursUtc) ? win.hoursUtc : [win.hoursUtc];
  if (list.length === 0) return false;
  const parsed = list.map(parseWindowRange);
  if (parsed.some((x) => x == null)) return false;   // 畸形 ⇒ 永不匹配
  const m = utcMinutes(tsMs);
  return parsed.some((r) => minutesInRange(m, r));
}

// 命中第几个窗口（首个命中优先）；没命中 → -1。
// -1 并不意味着配置有问题 —— 正常情况（peak 时段）就是 -1。
function matchWindowIndex(schedule, tsMs) {
  if (!schedule || typeof schedule !== 'object') return -1;
  const wins = schedule.windows;
  if (!Array.isArray(wins) || wins.length === 0) return -1;
  const weekdayNow = weekdayInTz(tsMs, schedule.weekdayTimezone);
  for (let i = 0; i < wins.length; i += 1) {
    if (windowMatches(wins[i], tsMs, weekdayNow)) return i;
  }
  return -1;
}

// 价格 overlay：标准价 base + off-peak 档 ⇒ 最终价。
// 返回 { input, output, cacheHit, windowIndex, window, offPeak, priceSource? }
//   window = 'w0'/'w1'…（命中第几个 off-peak 窗口）| 'standard'（未命中 = 标准价）
// 🔴 逐项覆盖：offPeakPricing.pricing 里没写的项**沿用标准价**，不是置 0。
//    （把「闲时没配 output 价」当成「闲时 output 免费」，是最容易出的一类静默错账。）
function applyOffPeak(base, schedule, tsMs) {
  const b = base || {};
  const idx = matchWindowIndex(schedule, tsMs);
  if (idx < 0) {
    return {
      input: Number(b.input) || 0,
      output: Number(b.output) || 0,
      cacheHit: b.cacheHit != null ? Number(b.cacheHit) || 0 : undefined,
      windowIndex: -1,
      window: 'standard',
      offPeak: false,
    };
  }
  const op = (schedule && schedule.pricing) || {};
  return {
    input: op.input != null ? Number(op.input) || 0 : Number(b.input) || 0,
    output: op.output != null ? Number(op.output) || 0 : Number(b.output) || 0,
    cacheHit: op.cacheHit != null
      ? Number(op.cacheHit) || 0
      : (b.cacheHit != null ? Number(b.cacheHit) || 0 : undefined),
    windowIndex: idx,
    window: 'w' + idx,
    offPeak: true,
    priceSource: schedule.priceSource || undefined,
  };
}

// 静态体检：把**会静默退化成标准价**的配置问题报出来。
// 与运行期 fail-safe 是两件事：运行期永不因畸形打折（安全），但畸形必须**看得见**
// ——「宁可留个明处的缺口，也不把话塞死」（本站既有纪律）。
// 返回字符串数组；空数组 = 没发现问题。
function validateSchedule(schedule) {
  const out = [];
  if (!schedule || typeof schedule !== 'object') return out;

  if (schedule.weekdayTimezone != null) {
    const tz = schedule.weekdayTimezone;
    if (typeof tz !== 'string' || !tz.trim()) {
      out.push('weekdayTimezone 是空字符串：按 UTC 判（建议直接删掉该字段，语义更清楚）');
    } else if (weekdayInTz(Date.now(), tz) == null) {
      out.push(`weekdayTimezone "${tz}" 不是合法 IANA 时区 ⇒ 所有带 weekdays 的窗口永不命中 ⇒ 恒收标准价`);
    }
  }

  const wins = schedule.windows;
  if (!Array.isArray(wins)) {
    out.push('windows 不是数组 ⇒ 分时定价整体不生效（恒收标准价）');
    return out;
  }
  if (wins.length === 0) {
    out.push('windows 是空数组 ⇒ 分时定价整体不生效（恒收标准价）');
    return out;
  }

  wins.forEach((win, i) => {
    if (!win || typeof win !== 'object') {
      out.push(`windows[${i}] 不是对象 ⇒ 该窗口永不命中`);
      return;
    }
    if (win.weekdays != null) {
      if (!Array.isArray(win.weekdays)) {
        out.push(`windows[${i}].weekdays 不是数组 ⇒ 该窗口永不命中`);
      } else {
        win.weekdays.forEach((w, j) => {
          if (normalizeWeekday(w) == null) {
            out.push(`windows[${i}].weekdays[${j}] = ${JSON.stringify(w)} 不是合法星期（1-7 或 mon..sun）⇒ 该窗口永不命中`);
          }
        });
      }
    }
    if (win.hoursUtc != null) {
      const list = Array.isArray(win.hoursUtc) ? win.hoursUtc : [win.hoursUtc];
      list.forEach((r, j) => {
        if (parseWindowRange(r) == null) {
          out.push(`windows[${i}].hoursUtc[${j}] = ${JSON.stringify(r)} 不是合法 "HH:MM-HH:MM" ⇒ 该窗口永不命中`);
        }
      });
    }
    if (win.weekdays == null && win.hoursUtc == null) {
      out.push(`windows[${i}] 既无 weekdays 也无 hoursUtc ⇒ 恒命中 ⇒ 标准价永不生效（等于白配）`);
    }
  });

  const op = schedule.pricing;
  if (!op || typeof op !== 'object') {
    out.push('offPeakPricing.pricing 缺失 ⇒ 命中窗口也只按标准价收（等于没配）');
  } else if (op.input == null && op.output == null && op.cacheHit == null) {
    out.push('offPeakPricing.pricing 三项全空 ⇒ 命中窗口也只按标准价收（等于没配）');
  }
  return out;
}

module.exports = {
  normalizeWeekday,
  parseHhmm,
  parseWindowRange,
  minutesInRange,
  utcMinutes,
  weekdayInTz,
  windowMatches,
  matchWindowIndex,
  applyOffPeak,
  validateSchedule,
};
