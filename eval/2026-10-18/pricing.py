#!/usr/bin/env python3
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
"""
pricing.py — 评测用的计费折算层（纯函数，不联网，自带自测）。

为什么需要这一层：
  跑完 48 次评测拿到的 usage 只有 token 数，而协议的主指标是「总花费 ÷ 通过数」。
  token 数和钱之间差一张价表。网关（cursor-proxy）侧其实早有这套东西
  （cursor-proxy/src/routing/actualCost.ts + monitoring/costTrack.ts，门控 PROXY_CURSOR_COST），
  但它只往 sidecar 写账、不回传给调用方，所以 runner 侧读不到金额，只能自己折。

  自己折就必须能回源：每个价都带 source 与 updatedAt，缺哪个都算不出来。

🔴 铁律：0 和「不知道」是两回事
  单价缺失时**绝不能记 0**。记 0 会让它进分母，「省了 100%」这种话就是这么来的。
  分四种 basis，缺价的一律标出来，不给金额结论：
    pricing-table@{updatedAt}  有官方单价，按它折（可回源）
    unbillable:subscription    订阅制/打包制，单价不可定义（钱照花，但摊不到每次调用）
    zero:local                 本地模型，真 0 元（但有硬件摊销，不可与云价直接比）
    unknown-model              价表里没有，不猜

用法：
  from pricing import cost_from_usage
  cost, basis = cost_from_usage("kimi-k2.6", 1200, 800)

自测：
  python3 pricing.py --selftest
"""

# 价表：CNY / 每百万 token。
# 来源：cursor-proxy/src/pricing/seed.ts 的 OFFICIAL_PRICING（2026-10-18 抄录）。
# 抄而不引是因为 runner 是 Python、网关是 TS，两套运行时；改价请先改 seed.ts 再同步这里，
# 并在 docs/EVAL-成本验收协议 的「价表同步」一节记一笔。
# 格式：model -> (input, output, cacheHit, source, updatedAt)
PRICING = {
    "deepseek-v4-pro": (0.5, 3, 0.02, "official-deepseek", "2025"),
    "deepseek-flash": (0.2, 1.6, 0.02, "official-deepseek", "2025"),
    "deepseek-v4-flash": (0.2, 1.6, 0.02, "official-deepseek", "2025"),
    "kimi-k2.6": (6.5, 27, 1.1, "official-kimi", "2026-09-23"),
    "kimi-k3": (20, 100, 2.0, "official-kimi", "2026-09-23"),
    "qwen3.8:27b-mlx": (0, 0, 0, "local-zero", "n/a"),
    "qwen3.8-q5:latest": (0, 0, 0, "local-zero", "n/a"),
}

# ⚠️ 订阅制/打包制：单价不可定义。
# 判据：seed.ts 里 agnes-3.0-flash 的 source 标的是 'official-agnes'，值却是 0/0/0。
# 这两个信号互相打架——标了官方来源说明有人填过，给零值说明填不出来。
# 商业聚合服务走订阅/额度包时，单次调用花多少钱这件事**在定义上就答不出**
# （跟 TierFlow 讨论里「订阅配额路由」是同一个坑：配额消耗 ≠ 金额消耗）。
# 我核过 apihub.agnes 的公开定价页，没核到按量单价，所以按 unbillable 处理，不当免费。
# 🔴 这里比「不填」更危险的是「填 0」：填了 0 就会有人拿它当分母，算出省了 100%。
UNBILLABLE = {
    "agnes-3.0-flash": "订阅/额度包制，未核到按量单价，不可折算金额",
    "agnes-2.0-flash": "订阅/额度包制，未核到按量单价，不可折算金额",
    "agnes-2.5-flash": "订阅/额度包制，未核到按量单价，不可折算金额",
}

LOCAL_SOURCES = {"local-zero"}


def cost_from_usage(model, in_tok, out_tok, cache_tok=0):
    """usage → (cost_cny, basis)。

    公式与 cursor-proxy/src/routing/actualCost.ts:16 一致（两边必须对齐，否则
    runner 折出来的账和网关 sidecar 的账会对不上，谁都证不了谁）：
        nonCached = in_tok - cache_tok
        cost = nonCached/1M × input + out_tok/1M × output + cache_tok/1M × cacheHit
    ⚠️ in_tok 通常**已经包含** cache 部分（各家 provider 的 usage 口径如此），
    所以必须先减再算，直接 in_tok × input 会把缓存那部分按原价重算一遍，虚高。

    cost 在 unbillable / unknown 时返回 0.0，但 basis 会标明——**看数必须连 basis 一起看**，
    只拿 cost 去算比例是错的。统计脚本对这个有硬校验（见 cost-per-success.js 的 basis 检查）。
    """
    if model in UNBILLABLE:
        return 0.0, "unbillable:subscription"
    if model in PRICING:
        p_in, p_out, p_cache, source, updated = PRICING[model]
        if source in LOCAL_SOURCES:
            return 0.0, "zero:local"
        non_cached = max(0, in_tok - cache_tok)
        cost = (non_cached / 1e6 * p_in) + (out_tok / 1e6 * p_out) + (cache_tok / 1e6 * p_cache)
        return round(cost, 6), f"pricing-table@{updated}"
    return 0.0, "unknown-model"


def is_billable(basis):
    """这行记录能不能用来算钱。只有拿到官方单价的才算数。"""
    return basis.startswith("pricing-table@")


def describe(basis):
    return {
        "unbillable:subscription": "订阅/额度包制，单价不可定义",
        "zero:local": "本地模型，0 元（含硬件摊销不可比）",
        "unknown-model": "价表里没有这个模型，未折算",
    }.get(basis, f"按官方单价折算（{basis}）")


def _selftest():
    checks = []

    def eq(label, got, want):
        ok = got == want
        checks.append(ok)
        print(f"  {'✅' if ok else '❌'} {label}: {got}" + ("" if ok else f" ≠ {want}"))

    print("pricing 自测：")
    # 手算：1200 input × 6.5/1M + 800 output × 27/1M = 0.0078 + 0.0216 = 0.0294
    c, b = cost_from_usage("kimi-k2.6", 1200, 800)
    eq("kimi 1200/800 成本", c, 0.0294)
    eq("kimi basis", b, "pricing-table@2026-09-23")

    # deepseek: 1200 × 0.5/1M + 800 × 3/1M = 0.0006 + 0.0024 = 0.003
    c, b = cost_from_usage("deepseek-v4-pro", 1200, 800)
    eq("deepseek 1200/800 成本", c, 0.003)

    # 订阅制：给 0 但标 unbillable，绝不能当成免费
    c, b = cost_from_usage("agnes-3.0-flash", 100000, 50000)
    eq("agnes 成本（不可折）", c, 0.0)
    eq("agnes basis", b, "unbillable:subscription")
    eq("agnes 不算可计费", is_billable(b), False)

    # 未知模型：不猜
    c, b = cost_from_usage("gpt-9-turbo", 1000, 1000)
    eq("未知模型 basis", b, "unknown-model")
    eq("未知模型不算可计费", is_billable(b), False)

    # 本地模型
    c, b = cost_from_usage("qwen3.8:27b-mlx", 10000, 5000)
    eq("本地 basis", b, "zero:local")
    eq("本地成本", c, 0.0)
    eq("本地不算可计费", is_billable(b), False)

    # 缓存口径：in_tok 含 cache，必须先减再算。
    # 1000 input 全命中 → (1000-1000)×6.5 + 0 + 1000×1.1/1M = 0.0011（按缓存价，不是原价 0.0065）
    c, _ = cost_from_usage("kimi-k2.6", 1000, 0, 1000)
    eq("kimi 全缓存 1000 token（按缓存价）", c, 0.0011)

    # 半缓存：1000 input 里 400 命中 → (1000-400)×6.5/1M + 1000×27/1M + 400×1.1/1M
    #        = 0.0039 + 0.027 + 0.00044 = 0.03134
    c, _ = cost_from_usage("kimi-k2.6", 1000, 1000, 400)
    eq("kimi 400/1000 缓存混合", c, 0.03134)

    # 防御：cache 比 input 还大（provider 口径打架时不许出负数）
    c, _ = cost_from_usage("kimi-k2.6", 100, 0, 500)
    eq("cache > input 不出负数", c, 0.00055)

    # 零 token 不炸
    c, b = cost_from_usage("kimi-k2.6", 0, 0)
    eq("零 token 成本", c, 0.0)

    bad = checks.count(False)
    if bad:
        print(f"\n❌ {bad}/{len(checks)} 项未过")
        return 1
    print(f"\n✅ {len(checks)} 项全过")
    return 0


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print("用法：python3 pricing.py --selftest")
    print("\n价表覆盖：")
    for m, (i, o, c, s, u) in PRICING.items():
        print(f"  {m:22s} in={i:<5} out={o:<5} cache={c:<5} {s} @{u}")
    print("\n不可折算（订阅/额度包）：")
    for m, why in UNBILLABLE.items():
        print(f"  {m:22s} {why}")
