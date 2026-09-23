/**
 * M6 方向四 · 双计费维度（老板 2026-09-22 拍板）单元测试
 *
 * 覆盖：
 *   A. API token 计费（现状 token 模式）—— estimateCost 公式向后兼容。
 *   B. coding plan 订阅计费        —— 门控 PROXY_BILLING_MODE=subscription 时月费均摊，
 *                                   边际成本≈月费/配额×本请求 tokens（接近 0）。
 *   C. 门控关（默认）行为不变      —— 即便声明 subscription，门控关时仍走 token 计价；
 *                                   kimi 因 token 单价贵排在 deepseek 之后（"kimi 不是永不被选中"）。
 *   D. 安全兜底                    —— 订阅配额缺失 / 非正 / 无月费时退化 token 计价，不产假成本。
 *
 * 非侵入：门控默认关；本测试显式在 afterEach 复位 PROXY_BILLING_MODE，绝不影响其它套件。
 */
import {
   estimateCost,
   rankByCost,
   isSubscriptionBillingEnabled,
   type Pricing,
} from '../../src/routing/ruleEvaluator.js';
import {
  RouteEngine,
  DEFAULT_ROUTE_CONFIG,
} from '../../src/routing/routeEngine.js';

// 每个用例后复位门控，避免串行污染（jest 默认每套件独立模块，但显式复位更稳）。
function setGate(mode: string | undefined): void {
  if (mode === undefined) delete process.env.PROXY_BILLING_MODE;
  else process.env.PROXY_BILLING_MODE = mode;
}
afterEach(() => setGate(undefined));

// ---------- A. token 模式（现状，向后兼容）----------
describe('双计费 · A token 模式（现状公式，向后兼容）', () => {
  it('estimateCost 基本公式（无缓存 / 无维度声明）', () => {
    setGate(undefined);
    // 1e6 × 0.8/1e6 + 1e6 × 2.7/1e6 = 3.5
    expect(estimateCost({ input: 0.8, output: 2.7 }, 1_000_000, 1_000_000)).toBeCloseTo(3.5, 6);
    expect(estimateCost(undefined, 10, 10)).toBe(Infinity);
  });

  it('带 cacheHit 走缓存红利公式（现状不变）', () => {
    setGate(undefined);
    // inputCost=0.8; cacheInputCost=1.0*1e6*0.5/1e6=0.5; max(0.5, 0.4)+2.7 = 0.5+2.7=3.2
    expect(estimateCost({ input: 0.8, output: 2.7, cacheHit: 1.0 }, 1_000_000, 1_000_000))
      .toBeCloseTo(3.2, 6);
  });

  it('billingMode 缺省时默认 token 计价（即便门控开也不均摊）', () => {
    setGate('subscription');
    const p: Pricing = { input: 0.8, output: 2.7 };
    expect(estimateCost(p, 1_000_000, 1_000_000)).toBeCloseTo(3.5, 6);
  });
});

// ---------- B. subscription 模式（月费均摊，门控开时接近 0）----------
describe('双计费 · B 订阅模式（门控开 → 月费均摊）', () => {
  it('isSubscriptionBillingEnabled 门控判定', () => {
    expect(isSubscriptionBillingEnabled()).toBe(false);
    setGate('subscription');
    expect(isSubscriptionBillingEnabled()).toBe(true);
    setGate('Subscription');
    expect(isSubscriptionBillingEnabled()).toBe(true);   // 大小写不敏感
    setGate('  subscription ');
    expect(isSubscriptionBillingEnabled()).toBe(true);    // 前后空格不敏感
    setGate('token');
    expect(isSubscriptionBillingEnabled()).toBe(false);
    setGate('');
    expect(isSubscriptionBillingEnabled()).toBe(false);
    setGate(undefined);
    expect(isSubscriptionBillingEnabled()).toBe(false);   // 未设 → 关
  });

  it('订阅均摊：边际成本 = 月费/配额 × 本请求 tokens（远小于同档 token 计价）', () => {
    setGate('subscription');
     // 月费 199，月配额 1e9 tokens；本请求 1e6+1e6=2e6 → 199*2e6/1e9 = 0.398 元。
    // "趋近 0" 是相对 token 单价而言：订阅均摊成本远小于同档按量计价。
    const sub: Pricing = {
      input: 6.5, output: 27, cacheHit: 1.3,
      billingMode: 'subscription', monthlyCny: 199, monthlyQuotaTokens: 1_000_000_000,
     };
    const cost = estimateCost(sub, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(199 * 2_000_000 / 1_000_000_000, 6); // 0.398
    // 配额越大越趋近 0：把配额放大到 1e12 → 199*2e6/1e12 ≈ 3.98e-4
    expect(estimateCost({ ...sub, monthlyQuotaTokens: 1_000_000_000_000 }, 1_000_000, 1_000_000))
       .toBeCloseTo(199 * 2_000_000 / 1_000_000_000_000, 6);
    // 远小于同档 token 计价（分开算生效：订阅维度不再按 ¥/M token 累加）
    const tokenCost = (() => { setGate(undefined); return estimateCost(sub, 1_000_000, 1_000_000); })();
    expect(cost).toBeLessThan(tokenCost);
   });

  it('门控关时即便声明 subscription 也按 token 计价（向后兼容，行为不变）', () => {
    setGate(undefined);
    const sub: Pricing = {
      input: 6.5, output: 27, cacheHit: 1.3,
      billingMode: 'subscription', monthlyCny: 199, monthlyQuotaTokens: 1_000_000_000,
    };
    // 与改造前 token 公式逐字节一致
    const expected =
      Math.max((1.3 * 1_000_000 * 0.5) / 1_000_000, (6.5 * 1_000_000 / 1_000_000) * 0.5)
      + (27 * 1_000_000) / 1_000_000;
    expect(estimateCost(sub, 1_000_000, 1_000_000)).toBeCloseTo(expected, 6);
  });
});

// ---------- C. 门控关 → 现有路由选择不变（kimi 因贵排在 deepseek 后）----------
describe('双计费 · C 非侵入（门控关 kimi 仍先于… 后于 deepseek，绝不改变现状）', () => {
  it('DEFAULT_ROUTE_CONFIG 的 kimi-k2.6 token 价高于 deepseek-v4-pro（cost-optimization 下 deepseek 先选）', () => {
    setGate(undefined);
    const kim = DEFAULT_ROUTE_CONFIG.pricing!['kimi-k2.6']!;
    const dsv = DEFAULT_ROUTE_CONFIG.pricing!['deepseek-v4-pro']!;
    const inTok = 512, outTok = 154; // 与引擎估算量级一致
    expect(estimateCost(kim, inTok, outTok)).toBeGreaterThan(estimateCost(dsv, inTok, outTok));
  });

  it('kimi 在 cost-optimization 候选集里永远排到 deepseek 之后（门控关）', () => {
    setGate(undefined);
    const cands = [
      { id: 'kimi-k2.6',  pricing: DEFAULT_ROUTE_CONFIG.pricing!['kimi-k2.6']!,  health: 'ok' as const },
      { id: 'deepseek-v4-pro', pricing: DEFAULT_ROUTE_CONFIG.pricing!['deepseek-v4-pro']!, health: 'ok' as const },
    ];
    const ranked = rankByCost(cands, 512, 154);
    expect(ranked[0].id).toBe('deepseek-v4-pro'); // deepseek 更便宜先选
    expect(ranked[1].id).toBe('kimi-k2.6');
    // kimi 不会被"永远选中"：它存在且被比价，只是因贵而排在 deepseek 之后。
    expect(ranked.some((r) => r.id === 'kimi-k2.6')).toBe(true);
  });

  it('门控开时 kimi 订阅均摊趋近 0 → cost-optimization 会转向 kimi（分开算生效）', () => {
    // 验证订阅维度"分开算"后行为确实改变：订阅价远低于 deepseek token 价。
    setGate('subscription');
    const subKimi: Pricing = {
      input: 6.5, output: 27, cacheHit: 1.3,
      billingMode: 'subscription', monthlyCny: 199, monthlyQuotaTokens: 1_000_000_000,
    };
    const cands = [
      { id: 'kimi-sub',    pricing: subKimi,                                  health: 'ok' as const },
      { id: 'deepseek-v4-pro', pricing: DEFAULT_ROUTE_CONFIG.pricing!['deepseek-v4-pro']!, health: 'ok' as const },
    ];
    const ranked = rankByCost(cands, 512, 154);
    expect(ranked[0].id).toBe('kimi-sub'); // 订阅均摊后 kimi 趋近 0，反成最便宜
    expect(ranked[0].cost).toBeLessThan(0.001);
  });
});

// ---------- D. 安全兜底 ----------
describe('双计费 · D 订阅维度安全兜底', () => {
  it('配额为 0 / 缺失 → 退化 token 计价（不产假成本 / 不 NaN）', () => {
    setGate('subscription');
    const noQuota: Pricing = { input: 6.5, output: 27, billingMode: 'subscription', monthlyCny: 199 };
    const zeroQuota: Pricing = { input: 6.5, output: 27, billingMode: 'subscription',
                                  monthlyCny: 199, monthlyQuotaTokens: 0 };
    const fallback = (p: Pricing) =>
      ((6.5 * 100) / 1_000_000) + (27 * 100) / 1_000_000;
    expect(estimateCost(noQuota, 100, 100)).toBeCloseTo(fallback(noQuota), 9);
    expect(estimateCost(zeroQuota, 100, 100)).toBeCloseTo(fallback(zeroQuota), 9);
  });

  it('月费缺失 → 退化 token 计价', () => {
    setGate('subscription');
    const noFee: Pricing = { input: 1, output: 4, billingMode: 'subscription', monthlyQuotaTokens: 1_000_000 };
    expect(estimateCost(noFee, 100, 100))
      .toBeCloseTo((1 * 100 + 4 * 100) / 1_000_000, 9);
  });

  it('RouteEngine cost-optimization 在门控开时对订阅候选仍按均摊价选最便宜', () => {
    setGate('subscription');
    const eng = new RouteEngine();
    const cfg = {
      id: 'sub-cfg',
      defaultModel: 'kimi',
      fallbackChain: ['deepseek-v4-pro', 'kimi-sub'],
      rules: [],
      maxRetries: 3,
      strategy: 'cost-optimization' as const,
      pricing: {
        'deepseek-v4-pro': { input: 1, output: 4, cacheHit: 0.02 },
        'kimi-sub': {
          input: 6.5, output: 27, cacheHit: 1.3,
          billingMode: 'subscription' as const, monthlyCny: 199, monthlyQuotaTokens: 1_000_000_000,
        },
      },
    };
    expect(eng.getNextRoute('general', 'm', cfg)).toBe('kimi-sub');
  });
});
