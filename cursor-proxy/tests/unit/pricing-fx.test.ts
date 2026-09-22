/**
 * Q1 双计费 + 价表三层 + 汇率(CNY 比价)· P1 纯函数单元测试
 * (2026-09-22 架构稿 §3.1/§3.5/§4.2.2 + §7 P1 验收: tsc 0 错 + 新增 ~18 测试全绿 +
 *  门控关逐字节不变)
 *
 * 覆盖:
 *   F1. deepseek-v4-pro 官方价回源(1/4/0.02 → 0.5/3/0.02, §3.7 标「改!」)
 *   E.  isFxCurrencyEnabled 门控(默认关, 非侵袭)
 *   F.  resolveFxRate 汇率源优先级(env PROXY_FX_RATE > cache > cachedValue > 兜底1.0)、异常→fallback
 *   G.  resolveBillingCost 门控关逐字节 === estimateCost; 门控开 USD 折算 CNY
 *   H.  rankByCostCny 门控关逐字节 === rankByCost; 门控开按 CNY 重排(USD 折后显贵被降权)
 *   I.  resolvePricing 三层优先级(L1 用户覆盖 > L2 渠道 > L0 种子 > null)
 *   J.  resolveModelEnabled 逐模型门控(全员默认参与, P1 仅接口)
 *   K.  approxEqual 浮点工具
 *
 * 非侵入: 汇率门控默认关; 本测试 afterEach 复位 PROXY_FX_CURRENCY / PROXY_FX_RATE /
 *          PROXY_ROUTE_*_ENABLED, 绝不影响其它套件。
 */
import {
  estimateCost,
  rankByCost,
  isFxCurrencyEnabled,
  resolveFxRate,
  resolveBillingCost,
  rankByCostCny,
  resolvePricing,
  resolveModelEnabled,
  approxEqual,
  type Pricing,
} from '../../src/routing/ruleEvaluator.js';
import {
  DEFAULT_ROUTE_CONFIG,
} from '../../src/routing/routeEngine.js';

// 复位汇率门控 + 逐模型门控, 避免串行污染。
function resetFxEnv(): void {
  delete process.env.PROXY_FX_CURRENCY;
  delete process.env.PROXY_FX_RATE;
  delete process.env.PROXY_ROUTE_DEEPSEEK_ENABLED;
  delete process.env.PROXY_ROUTE_OPENROUTER_ENABLED;
}
// 开启汇率门控(PROXY_FX_CURRENCY=on)并显式设 env 汇率; fx 传 null 则不读 env → 走兜底/缓存。
function setFxOn(rate?: string): void {
  process.env.PROXY_FX_CURRENCY = 'on';
  if (rate === undefined) delete process.env.PROXY_FX_RATE;
  else process.env.PROXY_FX_RATE = rate;
}
afterEach(() => resetFxEnv());

// ---------- F1. deepseek 官方价回源(§3.7 标「改!」的真实偏差已修)----------
describe('Q1 · F1 deepseek-v4-pro 官方价回源(0.5/3/0.02)', () => {
  it('DEFAULT_ROUTE_CONFIG deepseek-v4-pro = 0.5/3/0.02(旧 1/4/0.02 偏高 ~2×, 已回源)', () => {
    const dsv = DEFAULT_ROUTE_CONFIG.pricing!['deepseek-v4-pro']!;
    expect(dsv.input).toBe(0.5);
    expect(dsv.output).toBe(3);
    expect(dsv.cacheHit).toBe(0.02);
  });

  it('deepseek 价带 currency=CNY + source 标注(§3.1 三层结构)', () => {
    const dsv = DEFAULT_ROUTE_CONFIG.pricing!['deepseek-v4-pro']!;
    expect(dsv.currency).toBe('CNY');
    expect(typeof dsv.source).toBe('string');
    expect(dsv.source!.length).toBeGreaterThan(0);
  });

  it('kimi-k2.6 仍最贵(6.5/27) > deepseek(0.5/3), 路由相对序不变(§F1: 路由选择不变)', () => {
    const kim = DEFAULT_ROUTE_CONFIG.pricing!['kimi-k2.6']!;
    const dsv = DEFAULT_ROUTE_CONFIG.pricing!['deepseek-v4-pro']!;
    expect(estimateCost(kim, 512, 154)).toBeGreaterThan(estimateCost(dsv, 512, 154));
    expect(estimateCost(kim, 1_000_000, 1_000_000)).toBeGreaterThan(estimateCost(dsv, 1_000_000, 1_000_000));
  });
});

// ---------- E. 汇率门控(默认关, 非侵袭)----------
describe('Q1 · E isFxCurrencyEnabled 门控(默认关)', () => {
  it('未设 / 空 / 非真值 → 关(默认)', () => {
    resetFxEnv();
    expect(isFxCurrencyEnabled()).toBe(false);
    for (const v of ['', 'token', 'no', 'false', '0']) {
      process.env.PROXY_FX_CURRENCY = v;
      expect(isFxCurrencyEnabled()).toBe(false);
    }
  });

  it('true / 1 / enable / on / 大小写空格不敏感 → 开', () => {
    for (const v of ['true', 'True', '  TRUE ', '1', 'enable', 'on', 'ON']) {
      process.env.PROXY_FX_CURRENCY = v;
      expect(isFxCurrencyEnabled()).toBe(true);
    }
  });
});

// ---------- F. resolveFxRate 汇率源优先级 ----------
describe('Q1 · F resolveFxRate(优先级 env > cache > cachedValue > 兜底1.0)', () => {
  it('env(PROXY_FX_RATE)优先于缓存与 cachedValue', () => {
    resetFxEnv();
    const r = resolveFxRate({ cacheFx: 6.5, cachedValue: 7.2, fallbackRate: 7.2, envRate: '7.0' });
    expect(r.rate).toBeCloseTo(7.0, 12);
    expect(r.source).toBe('env');
  });

  it('env 缺失(显式 0 不算)→ 用缓存(pricing-cache.json.fx)', () => {
    resetFxEnv();
    const r = resolveFxRate({ cacheFx: 6.5, cachedValue: 7.2 });
    expect(r.rate).toBeCloseTo(6.5, 12);
    expect(r.source).toBe('cache');
  });

  it('env + cache 都缺 → 用缓存最近值(定稿 D2: 7.2 仅留作 cachedValue)', () => {
    resetFxEnv();
    const r = resolveFxRate({ cachedValue: 7.2 });
    expect(r.rate).toBeCloseTo(7.2, 12);
    expect(r.source).toBe('cached-value');
  });

  it('全缺 → 兜底 1.0 + source=fallback(不混算, USD 模型显贵被降权)', () => {
    resetFxEnv();
    const r = resolveFxRate();
    expect(r.rate).toBe(1.0);
    expect(r.source).toBe('fallback');
  });

  it('异常汇率(≤0 / 非数)→ 跳到下一级 → 兜底', () => {
    resetFxEnv();
    expect(resolveFxRate({ cacheFx: 0, fallbackRate: 7.2 }).source).toBe('fallback'); // 0 不算, 无 cachedValue → 兜底
    expect(resolveFxRate({ fallbackRate: 7.2 }).source).toBe('fallback');
    expect(resolveFxRate({ envRate: 'abc', fallbackRate: 7.2 }).rate).toBeCloseTo(7.2, 12);
    expect(resolveFxRate({ envRate: 0 }).rate).toBe(1.0);
   });

  it('自定义 fallbackRate 生效(架构 §3.5 老板定默认兜底值)', () => {
    resetFxEnv();
    const r = resolveFxRate({ fallbackRate: 7.2 });
    expect(r.rate).toBeCloseTo(7.2, 12);
    expect(r.source).toBe('fallback');
  });
});

// ---------- G. resolveBillingCost ----------
describe('Q1 · G resolveBillingCost(门控关逐字节 === estimateCost)', () => {
  it('门控关 + CNY 币种: cny === estimateCost(逐字节不变)', () => {
    resetFxEnv();
    const p: Pricing = { input: 0.5, output: 3, cacheHit: 0.02, currency: 'CNY' };
    const d = resolveBillingCost(p, 100, 50);
    expect(d.cny).toBeCloseTo(estimateCost(p, 100, 50), 12);
    expect(d.fxRate).toBe(1);
    expect(d.currency).toBe('CNY');
  });

  it('门控关 + USD 币种: 不折算, cny === tokenCost(逐字节不变)', () => {
    resetFxEnv();
    const p: Pricing = { input: 2.5, output: 15, currency: 'USD' };
    const d = resolveBillingCost(p, 1_000_000, 1_000_000);
    expect(d.cny).toBeCloseTo(estimateCost(p, 1_000_000, 1_000_000), 12); // 17.5
    expect(d.fxRate).toBe(1);
    expect(d.tokenCost).toBeCloseTo(17.5, 12);
  });

  it('门控开 + USD 币种: cny = tokenCost × fx(PROXY_FX_RATE=7.0)', () => {
    setFxOn('7.0');
    const p: Pricing = { input: 2.5, output: 15, currency: 'USD' };
    const d = resolveBillingCost(p, 1_000_000, 1_000_000);
    expect(d.cny).toBeCloseTo(17.5 * 7.0, 12); // 122.5
    expect(d.fxRate).toBeCloseTo(7.0, 12);
    expect(d.fxSource).toBe('env');
    expect(d.currency).toBe('USD');
  });

  it('定价缺失 → cny = Infinity(视为最贵, 同 estimateCost(undefined), 绝不编造)', () => {
    resetFxEnv();
    const d = resolveBillingCost(undefined, 10, 10);
    expect(d.cny).toBe(Infinity);
    expect(d.tokenCost).toBe(Infinity);
  });

  it('门控开 + 汇率异常(无 env/cache/cached)→ fx=1 + source=fallback(USD 模型显贵)', () => {
    setFxOn(undefined); // 门控开但不设 PROXY_FX_RATE → 走兜底 1.0
    const p: Pricing = { input: 2.5, output: 15, currency: 'USD' };
    const d = resolveBillingCost(p, 1_000_000, 1_000_000);
    expect(d.fxSource).toBe('fallback');
    expect(d.fxRate).toBe(1.0);
    expect(d.cny).toBeCloseTo(17.5, 12);
  });

  it('userSet 透传(L1 用户标记, §3.2 漂移分水岭)', () => {
    resetFxEnv();
    const p: Pricing = { input: 1, output: 1, currency: 'CNY', _userSet: true };
    expect(resolveBillingCost(p, 10, 10).userSet).toBe(true);
    expect(resolveBillingCost({ input: 1, output: 1 }, 10, 10).userSet).toBe(false);
  });
});

// ---------- H. rankByCostCny ----------
describe('Q1 · H rankByCostCny(门控关逐字节 === rankByCost; 门控开按 CNY 重排)', () => {
  const cands: { id: string; pricing?: Pricing; health?: 'ok' | 'degraded' | 'down' }[] = [
     { id: 'deepseek-v4-pro', pricing: { input: 0.5, output: 3, cacheHit: 0.02, currency: 'CNY' } },
     { id: 'kimi-k2.6', pricing: { input: 6.5, output: 27, cacheHit: 1.3, currency: 'CNY' } },
  ];

  it('门控关: rankByCostCny 排序 ≡ rankByCost(逐字节不变)', () => {
    resetFxEnv();
    expect(rankByCostCny(cands, 512, 154)).toEqual(rankByCost(cands, 512, 154));
  });

  it('门控关: deepseek(0.5/3) < kimi(6.5/27), deepseek 先选', () => {
    resetFxEnv();
    const r = rankByCostCny(cands, 512, 154);
    expect(r[0].id).toBe('deepseek-v4-pro');
    expect(r[1].id).toBe('kimi-k2.6');
  });

  it('门控开 + PROXY_FX_RATE=7.0: gpt(USD 2.5/15 →122.5 CNY) 比 kimi(33.5 CNY) 贵 → kimi 先选', () => {
    setFxOn('7.0');
    const mixed = [
       { id: 'codex-gpt-5.4', pricing: { input: 2.5, output: 15, currency: 'USD' } },
       { id: 'kimi-k2.6', pricing: { input: 6.5, output: 27, currency: 'CNY' } },
    ];
    const r = rankByCostCny(mixed, 1_000_000, 1_000_000);
    expect(r[0].id).toBe('kimi-k2.6'); // 33.5 CNY < 122.5 CNY(USD 折贵被降权)
  });

  it('门控开但 fx 无源 → fx=1: gpt cny=17.5 < kimi 33.5 → gpt 先(演示 fx=fallback 副作用)', () => {
    setFxOn(undefined); // 门控开但不设汇率 → 兜底 1.0
    const mixed = [
       { id: 'codex-gpt-5.4', pricing: { input: 2.5, output: 15, currency: 'USD' } },
       { id: 'kimi-k2.6', pricing: { input: 6.5, output: 27, currency: 'CNY' } },
    ];
    const r = rankByCostCny(mixed, 1_000_000, 1_000_000);
    expect(r[0].id).toBe('codex-gpt-5.4'); // 这正是 D2 警示: 拉不到 fx=1 时 USD 排序乱, 须提示失真
  });
});

// ---------- I. resolvePricing 三层优先级 ----------
describe('Q1 · I resolvePricing(L1 用户覆盖 > L2 渠道 > L0 种子 > null)', () => {
  const l1 = { m1: { input: 9, output: 9, _userSet: true, currency: 'CNY' } } as Record<string, Pricing>;
  const l2 = [{ model: 'm1', channel: 'openrouter', input: 5, output: 5 } as any];
  const l0 = (m: string) => (m === 'm1' ? { input: 1, output: 1, currency: 'CNY' } as Pricing : undefined);

  it('L1 命中(用户覆盖, _userSet:true) 最高优先', () => {
    const p = resolvePricing('m1', l1, l2, l0);
    expect(p!.input).toBe(9);
    expect(p!._userSet).toBe(true);
  });

  it('L1 无 → L2 命中(渠道价)', () => {
    const p = resolvePricing('m1', undefined, l2, l0);
    expect(p!.input).toBe(5);
  });

  it('L2 命中需 channel 匹配(指定 official 不中 openrouter → 落 L0)', () => {
    expect(resolvePricing('m1', undefined, l2, l0, 'official')!.input).toBe(1); // L0
    expect(resolvePricing('m1', undefined, l2, l0, 'openrouter')!.input).toBe(5); // L2
  });

  it('三层都无 → null(绝不编造, 调用方按免费/最贵处理)', () => {
    expect(resolvePricing('nope', l1, l2, l0)).toBeNull();
  });

  it('L2 空数组 → 落 L0', () => {
    expect(resolvePricing('m1', undefined, [], l0)!.input).toBe(1);
  });
});

// ---------- J. resolveModelEnabled 逐模型门控 ----------
describe('Q1 · J resolveModelEnabled(P1 仅接口, 全员默认参与)', () => {
  it('未设 → 全部参与(true)', () => {
    resetFxEnv();
    expect(resolveModelEnabled('deepseek')).toBe(true);
    expect(resolveModelEnabled('openrouter')).toBe(true);
  });

  it('false / 0 / disable / off / disabled / 大小写 → 排除', () => {
    for (const v of ['false', '0', 'disable', 'off', 'disabled', 'FALSE']) {
      process.env.PROXY_ROUTE_DEEPSEEK_ENABLED = v;
      expect(resolveModelEnabled('deepseek')).toBe(false);
      delete process.env.PROXY_ROUTE_DEEPSEEK_ENABLED;
    }
  });

  it('true / 1 / enable / 大小写 → 参与', () => {
    for (const v of ['true', '1', 'enable', 'ENABLE']) {
      process.env.PROXY_ROUTE_DEEPSEEK_ENABLED = v;
      expect(resolveModelEnabled('deepseek')).toBe(true);
      delete process.env.PROXY_ROUTE_DEEPSEEK_ENABLED;
    }
  });

  it('provider 大小写不敏感(deepseek → PROXY_ROUTE_DEEPSEEK_ENABLED)', () => {
    process.env.PROXY_ROUTE_DEEPSEEK_ENABLED = 'false';
    expect(resolveModelEnabled('DeepSeek')).toBe(false);
    delete process.env.PROXY_ROUTE_DEEPSEEK_ENABLED;
  });
});

// ---------- K. approxEqual 浮点工具 ----------
describe('Q1 · K approxEqual', () => {
  it('相等 / 无限相等 / 不相等 / 容差内', () => {
    expect(approxEqual(3.5, 3.5)).toBe(true);
    expect(approxEqual(Infinity, Infinity)).toBe(true);
    expect(approxEqual(1, 2)).toBe(false);
    expect(approxEqual(1, 2, 1.5)).toBe(true);
    expect(approxEqual(1.0000001, 1, 1e-6)).toBe(true);
    expect(approxEqual(1.0001, 1, 1e-6)).toBe(false);
  });
});