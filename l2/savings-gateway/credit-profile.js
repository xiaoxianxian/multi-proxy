// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source).
//
// credit-profile — 免费/便宜额度信号的纯函数层（阶段一：观测/记账）
//
// 为什么独立成模块、不塞进 gateway.js：
//   · gateway.js 是已验证的 L2 核心，本会话无法运行单测（Bash 通道故障），
//     任何运行时改动都不可验证 → 风险不可接受。
//   · 本模块零依赖、纯函数、自带 node 自测段（node credit-profile.js 即可验证），
//     与 gateway.js 完全解耦：gateway 只需在 pushSavings 时调 resolveCreditProfile 取一个
//     creditZero 标记写进账本，其余一行不动。
//
// 数据来源：workbuddy-shim 从 WB 上游拿到的真实 signal：
//   · usage.credit（如 "x0.00" = 免费；"x0.50" = 半价档）
//   · model catalog 的 badges: ["限时免费","夜间折扣"]
// 这些经 providers.json 的 provider 条目以 { adapterId: { credit, badges } } 注入，
// 本模块只负责解析与比较，绝不猜测。

'use strict';

// 把 WB 的 credit 字符串（"x0.00" / "x0.50" / 纯数字 "0"）解析成 number。
// 解析不出返回 null（不猜、不填 0 冒充免费，C0-3 纪律）。
function parseCredit(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // 形如 "x0.00" 或 "x0.50"：取 x 后的数字
  const m = s.match(/^x?\s*([0-9]*\.?[0-9]+)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

// credit 是否为「实测免费」（严格 0，不含近似）。
function isCreditZero(raw) {
  const n = parseCredit(raw);
  return n !== null && n === 0;
}

// 从注入的 creditProfiles 里取某个 adapter 的 credit 信号。
// creditProfiles: { [adapterId]: { credit?: string|number, badges?: string[] } }
// 返回 { credit: number|null, isZero: boolean, badges: string[], source: 'profile'|'unknown' }
function resolveCreditProfile(creditProfiles, adapterId) {
  const p = creditProfiles && typeof creditProfiles === 'object' ? creditProfiles[adapterId] : null;
  if (!p) return { credit: null, isZero: false, badges: [], source: 'unknown' };
  const credit = parseCredit(p.credit);
  const badges = Array.isArray(p.badges) ? p.badges.map(String) : [];
  return {
    credit,
    isZero: credit !== null && credit === 0,
    badges,
    source: 'profile',
  };
}

// 给候选 adapter 列表按「免费优先」排序，返回新数组（不原地改）。
// 排序键：isCreditZero 降序（免费在前）→ credit 升序（便宜在前）→ 原顺序。
// candidates: [{ adapterId, ... }]
function rankByCredit(candidates, creditProfiles) {
  if (!Array.isArray(candidates)) return [];
  const score = (c) => {
    const cp = resolveCreditProfile(creditProfiles, c.adapterId);
    if (cp.isZero) return [0, 0];          // 免费：最前
    if (cp.credit != null) return [1, cp.credit]; // 有的按价格升序
    return [2, Infinity];                  // 未知信用：最后
  };
  return candidates
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => (a.s[0] - b.s[0]) || (a.s[1] - b.s[1]) || (a.i - b.i))
    .map((x) => x.c);
}

module.exports = {
  parseCredit,
  isCreditZero,
  resolveCreditProfile,
  rankByCredit,
};

// ── 零依赖自测（node credit-profile.js 即可跑，无需 test runner）──
if (require.main === module) {
  const assert = require('assert');
  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
  };

  t('parseCredit: "x0.00" → 0', () => assert.strictEqual(parseCredit('x0.00'), 0));
  t('parseCredit: "x0.50" → 0.5', () => assert.strictEqual(parseCredit('x0.50'), 0.5));
  t('parseCredit: 裸数字 "0" → 0', () => assert.strictEqual(parseCredit('0'), 0));
  t('parseCredit: 负数/异常 → null', () => {
    assert.strictEqual(parseCredit('x'), null);
    assert.strictEqual(parseCredit(''), null);
    assert.strictEqual(parseCredit(null), null);
    assert.strictEqual(parseCredit('abc0.5'), null);
  });
  t('isCreditZero: x0.00 真免费', () => assert.strictEqual(isCreditZero('x0.00'), true));
  t('isCreditZero: x0.50 不是免费', () => assert.strictEqual(isCreditZero('x0.50'), false));

  const profiles = {
    wb: { credit: 'x0.00', badges: ['限时免费'] },
    deepseek: { credit: 'x1.00' },
    qwen: {}, // 无信号
  };
  t('resolveCreditProfile: wb 免费+徽章', () => {
    const r = resolveCreditProfile(profiles, 'wb');
    assert.strictEqual(r.isZero, true);
    assert.deepStrictEqual(r.badges, ['限时免费']);
    assert.strictEqual(r.source, 'profile');
  });
  t('resolveCreditProfile: 未知 adapter → unknown', () => {
    const r = resolveCreditProfile(profiles, 'agnes');
    assert.strictEqual(r.source, 'unknown');
    assert.strictEqual(r.isZero, false);
  });

  const cands = [
    { adapterId: 'qwen' },
    { adapterId: 'deepseek' },
    { adapterId: 'wb' },
  ];
  t('rankByCredit: 免费 wb 排最前', () => {
    const ranked = rankByCredit(cands, profiles);
    assert.strictEqual(ranked[0].adapterId, 'wb');
    assert.strictEqual(ranked[1].adapterId, 'deepseek');
    assert.strictEqual(ranked[2].adapterId, 'qwen');
  });
  t('rankByCredit: 空/非数组安全', () => {
    assert.deepStrictEqual(rankByCredit(null, profiles), []);
    assert.deepStrictEqual(rankByCredit([], profiles), []);
  });

  console.log(`\n[credit-profile.test] pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
