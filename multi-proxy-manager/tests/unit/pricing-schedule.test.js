'use strict';
// P3（2026-10-12）保护网：分时定价的**窗口边界**与 **fail-safe 方向**。
//
// 规格抄 LiteLLM `model_info.off_peak_pricing`。钉死这几条，因为每一条都是
// 「自己拍脑袋必踩」的反直觉点：
//   ① hours 恒 UTC，weekdayTimezone **只**决定 weekday 归属（不换算小时）
//   ② 半开区间 [start, end)，允许跨零点
//   ③ 🔴 畸形窗口 / 畸形 weekday / 畸形时区 **永不匹配** ⇒ 按**标准价**收
//      （fail-safe 的方向是标准价，不是 0 —— 与本站「unknown 就标 unknown，绝不凑 0」
//       以及把 A/B 脚本的「0 元」改成 n/a 是同一条纪律）
//   ④ 逐项覆盖：off-peak 没配的项**沿用标准价**，不是置 0

const ps = require('../../lib/pricing-schedule');

describe('parseHhmm', () => {
  test('正常解析', () => {
    expect(ps.parseHhmm('10:00')).toBe(600);
    expect(ps.parseHhmm('00:00')).toBe(0);
    expect(ps.parseHhmm('9:30')).toBe(570);   // 允许个位小时
  });
  test('畸形 → null（不是抛，也不是猜）', () => {
    expect(ps.parseHhmm('24:00')).toBeNull();
    expect(ps.parseHhmm('10:60')).toBeNull();
    expect(ps.parseHhmm('10:5')).toBeNull();  // 分钟必须两位，否则 9:5 有歧义
    expect(ps.parseHhmm('abc')).toBeNull();
    expect(ps.parseHhmm(null)).toBeNull();
  });
});

describe('minutesInRange（半开区间 + 跨零点）', () => {
  const r = ps.parseWindowRange('10:00-11:00');
  test('start === end 表示全天（LiteLLM 用 "00:00-00:00" 表达）', () => {
    const all = ps.parseWindowRange('00:00-00:00');
    for (const m of [0, 300, 720, 1439]) expect(ps.minutesInRange(m, all)).toBe(true);
  });
  test('🔴 半开：起点含、终点不含', () => {
    expect(ps.minutesInRange(600, r)).toBe(true);    // 10:00 起点算
    expect(ps.minutesInRange(659, r)).toBe(true);
    expect(ps.minutesInRange(660, r)).toBe(false);   // 11:00 终点不算
  });
  test('跨零点：22:00-02:00（终点同样是**半开**，02:00 不含）', () => {
    const wrap = ps.parseWindowRange('22:00-02:00');
    expect(ps.minutesInRange(1320, wrap)).toBe(true);   // 22:00 起点含
    expect(ps.minutesInRange(1439, wrap)).toBe(true);   // 23:59
    expect(ps.minutesInRange(0, wrap)).toBe(true);      // 次日 00:00
    expect(ps.minutesInRange(119, wrap)).toBe(true);    // 次日 01:59
    expect(ps.minutesInRange(120, wrap)).toBe(false);   // 🔴 次日 02:00 = 终点，不含
    expect(ps.minutesInRange(300, wrap)).toBe(false);   // 05:00 不在
  });
});

describe('normalizeWeekday', () => {
  test('数字 1..7（ISO，Mon=1）', () => {
    expect(ps.normalizeWeekday(1)).toBe(1);
    expect(ps.normalizeWeekday(7)).toBe(7);
  });
  test('各种英文写法', () => {
    expect(ps.normalizeWeekday('mon')).toBe(1);
    expect(ps.normalizeWeekday('Mon')).toBe(1);
    expect(ps.normalizeWeekday('monday')).toBe(1);
    expect(ps.normalizeWeekday('sun')).toBe(7);
    expect(ps.normalizeWeekday('wed')).toBe(3);
  });
  test('🔴 畸形 → null ⇒ 窗口永不匹配', () => {
    expect(ps.normalizeWeekday(0)).toBeNull();
    expect(ps.normalizeWeekday(8)).toBeNull();
    expect(ps.normalizeWeekday('xxx')).toBeNull();
    expect(ps.normalizeWeekday(null)).toBeNull();
  });
});

describe('weekdayInTz —— 🔴 hours 恒 UTC，时区只决定 weekday 归属', () => {
  // 2026-10-12 是周一；2026-10-11 是周日
  test('UTC 周一 02:30 → 北京时间周一 10:30 ⇒ ISO 1', () => {
    expect(ps.weekdayInTz(Date.parse('2026-10-12T02:30:00Z'), 'Asia/Shanghai')).toBe(1);
  });
  test('🔴 反直觉锚点：UTC 仍是周日，但北京时间已是周一 ⇒ 时区只翻转 weekday', () => {
    const ts = Date.parse('2026-10-11T20:00:00Z');   // UTC 周日；北京 10-12 04:00 周一
    expect(new Date(ts).getUTCDay()).toBe(0);        // UTC 侧确实是周日
    expect(ps.weekdayInTz(ts, 'Asia/Shanghai')).toBe(1);
    expect(ps.weekdayInTz(ts, 'UTC')).toBe(7);       // 同一时刻，按 UTC 判就是周日=7
  });
  test('不配时区 → 按 UTC 判（两套基准统一，避免混用）', () => {
    expect(ps.weekdayInTz(Date.parse('2026-10-12T02:30:00Z'), '')).toBe(1);
    expect(ps.weekdayInTz(Date.parse('2026-10-11T20:00:00Z'), null)).toBe(7);
  });
  test('🔴 时区写了但不合法 → null ⇒ 带 weekdays 的窗口永不命中 ⇒ 标准价', () => {
    expect(ps.weekdayInTz(Date.now(), 'Not/AZone')).toBeNull();
  });
});

describe('windowMatches 畸形一律 false（fail-safe）', () => {
  const noonMonday = Date.parse('2026-10-12T12:00:00Z');
  test('hours 写错字 → 永不匹配，而不是抛或乱匹配', () => {
    expect(ps.windowMatches({ hoursUtc: '25:00-26:00' }, noonMonday, 1)).toBe(false);
    expect(ps.windowMatches({ hoursUtc: '10:00' }, noonMonday, 1)).toBe(false);  // 缺 -
  });
  test('weekdays 里有畸形项 → 整窗永不匹配', () => {
    expect(ps.windowMatches({ hoursUtc: '00:00-00:00', weekdays: [1, 9] }, noonMonday, 1)).toBe(false);
  });
  test('weekdays 不是数组 → 永不匹配', () => {
    expect(ps.windowMatches({ hoursUtc: '00:00-00:00', weekdays: 'mon' }, noonMonday, 1)).toBe(false);
  });
  test('weekdayNow 为 null（时区非法）时，带 weekdays 的窗口永不匹配', () => {
    expect(ps.windowMatches({ hoursUtc: '00:00-00:00', weekdays: [1, 2, 3, 4, 5] }, noonMonday, null)).toBe(false);
  });
  test('只写 weekdays 不写 hours ⇒ 该星期整天', () => {
    expect(ps.windowMatches({ weekdays: [6, 7] }, noonMonday, 6)).toBe(true);
    expect(ps.windowMatches({ weekdays: [6, 7] }, noonMonday, 1)).toBe(false);
  });
});

describe('matchWindowIndex', () => {
  // DeepSeek 口径（LiteLLM docs）：peak＝01:00-04:00 与 06:00-10:00 UTC 周一至周五
  // ⇒ off-peak 窗口 = peak 的补集
  const sched = {
    weekdayTimezone: 'Asia/Shanghai',
    windows: [
      { hoursUtc: ['00:00-01:00', '04:00-06:00', '10:00-00:00'], weekdays: [1, 2, 3, 4, 5] },
      { hoursUtc: '00:00-00:00', weekdays: [6, 7] },
    ],
  };
  test('周一 02:30Z（peak 段 01:00-04:00 内）→ 不命中', () => {
    expect(ps.matchWindowIndex(sched, Date.parse('2026-10-12T02:30:00Z'))).toBe(-1);
  });
  test('周一 07:00Z（peak 段 06:00-10:00 内）→ 不命中', () => {
    expect(ps.matchWindowIndex(sched, Date.parse('2026-10-12T07:00:00Z'))).toBe(-1);
  });
  test('周一 05:00Z（peak 补集 04:00-06:00）→ 命中 w0', () => {
    expect(ps.matchWindowIndex(sched, Date.parse('2026-10-12T05:00:00Z'))).toBe(0);
  });
  test('周六任意时刻 → 命中 w1（周末全天）', () => {
    expect(ps.matchWindowIndex(sched, Date.parse('2026-10-17T02:30:00Z'))).toBe(1);
  });
  test('没配 windows → -1（不是错，就是恒收标准价）', () => {
    expect(ps.matchWindowIndex({}, Date.now())).toBe(-1);
    expect(ps.matchWindowIndex(null, Date.now())).toBe(-1);
  });
});

describe('applyOffPeak —— 逐项覆盖，未设项沿用标准价', () => {
  const base = { input: 2, output: 8, cacheHit: 0.04 };
  const sched = {
    weekdayTimezone: 'Asia/Shanghai',
    windows: [{ hoursUtc: '00:00-00:00' }],   // 恒命中
    pricing: { input: 1, output: 4, cacheHit: 0.02 },
  };
  test('命中 → 用 off-peak 价，window=w0', () => {
    const r = ps.applyOffPeak(base, sched, Date.now());
    expect(r.offPeak).toBe(true);
    expect(r.window).toBe('w0');
    expect(r.input).toBe(1);
    expect(r.output).toBe(4);
  });
  test('🔴 off-peak 只配了 input ⇒ output/cacheHit **沿用标准价**，不是置 0', () => {
    const r = ps.applyOffPeak(base, { ...sched, pricing: { input: 1 } }, Date.now());
    expect(r.input).toBe(1);      // 覆盖了
    expect(r.output).toBe(8);     // 标准价，不是 0
    expect(r.cacheHit).toBe(0.04);
  });
  test('未命中 → 整份标准价，window=standard', () => {
    const r = ps.applyOffPeak(base, { ...sched, windows: [] }, Date.now());
    expect(r.offPeak).toBe(false);
    expect(r.window).toBe('standard');
    expect(r.input).toBe(2);
    expect(r.output).toBe(8);
  });
  test('🔴 off-peak 价全 0（真免费窗口，如「23:00-08:00 免费」这种）→ 确实取 0，不是 fallback', () => {
    const r = ps.applyOffPeak(base, { ...sched, pricing: { input: 0, output: 0 } }, Date.now());
    expect(r.input).toBe(0);
    expect(r.output).toBe(0);
    expect(r.offPeak).toBe(true);   // 与「没命中」分得开
  });
});

describe('validateSchedule —— 会静默退化成标准价的问题必须报出来', () => {
  test('健康配置 → 无问题', () => {
    expect(ps.validateSchedule({
      weekdayTimezone: 'Asia/Shanghai',
      windows: [{ hoursUtc: '00:00-00:00', weekdays: [6, 7] }],
      pricing: { input: 1 },
    })).toEqual([]);
  });
  test('🔴 时区非法 → 报出来（运行期只是静默恒收标准价）', () => {
    const out = ps.validateSchedule({
      weekdayTimezone: 'Not/AZone',
      windows: [{ hoursUtc: '00:00-00:00', weekdays: [6] }],
      pricing: { input: 1 },
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.join()).toMatch(/Not\/AZone/);
  });
  test('🔴 weekday 打错字 → 报出来', () => {
    const out = ps.validateSchedule({
      windows: [{ hoursUtc: '00:00-00:00', weekdays: ['mondya'] }],
      pricing: { input: 1 },
    });
    expect(out.join()).toMatch(/mondya/);
  });
  test('🔴 配了窗口但 pricing 为空 → 报出来（否则「配了却没生效」永远查不出）', () => {
    const out = ps.validateSchedule({ windows: [{ hoursUtc: '00:00-00:00' }] });
    expect(out.join()).toMatch(/等于没配/);
  });
  test('窗口既无 weekdays 也无 hoursUtc → 恒命中，标准价永不生效', () => {
    const out = ps.validateSchedule({ windows: [{}], pricing: { input: 1 } });
    expect(out.join()).toMatch(/恒命中/);
  });
});
