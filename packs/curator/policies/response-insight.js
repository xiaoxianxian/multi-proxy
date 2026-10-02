'use strict';
// Curator pack handler · response-insight（onResponse）
//
// 这个 handler **不改上游响应的一个字节**，只做一件事：给「改写到底省没省」补一条对拍线。
//
// 为什么必须在响应侧看：请求侧所有 policy 自报的 netTokenDelta 都是**估算**（ledger 的
// measureText 走 folds 估算器，跟上游真实 tokenizer 有偏差）。全部加起来得到一个「省了多少」，
// 但没人知道这个数跟真实账单差多远。onResponse 是代理层唯一能**白拿上游真实 usage** 的位置
// （流式末 chunk、非流式 usage 字段），用它跟自报数对拍，才是「代理原生可观测」这句话的落点。
//
// ⚠️ 口径纠正（2026-10-02 晚，A/B 双发实测推翻过一条自己的结论）：
//   早期注释写「est≈12860 vs actual 11610 ≈ 高估 10%」——那个对比把 **responses 协议的
//   body.usage**（上游回给我们、属于**改写后**的请求）跟 **estTotal**（改写**前**基线）相减，
//   口径本身就是错的，得出来的「估算高估」是假象。
//   真·A/B 双发（logs/bridge-ab-2026-10-02.json：同一 payload 直连一次 + 过桥一次，8 次真请求）得到：
//     · 估算器对「改写前整包」很准：加权 bias +5.6%（v1 +6.8% / v3 −2.8%）
//     · 虚的是 **policy 自报 netTokenDelta**：高估真实净省 13~21%（小包更差，v2 达 120%）
//   ⇒ 所以 realSaving 用 est 当「改写前真实」的代理是**可接受的近似**（差 ~5%），
//     overclaimTokens 才是真正该盯的虚报源。别再把 estAfter 的低估算到估算器头上。
// onResponse 是代理层唯一能**白拿上游真实 usage** 的位置（流式末 chunk、非流式 usage 字段），
// 用它跟自报数对拍，才是「代理原生可观测」这句话的落点。
//
// 🔴 流式安全：本 handler 绝不看 output_text / content 去改写内容。SSE 是 pipe 出去的，
//    任何「攒完再发」的改写都会把首字节延迟拉到整段生成时间（codex 会当成卡死）。
//    所以它只解析 usage 与长度统计，字节层面一律透传。
//
// 边界：桥把响应体塞进 ctx.response（对象或字符串）。流式走的是 SSE 累积文本，
// 这里只抽末 chunk 的 usage 字段，抽不到就返回 null —— 宁可没数，不许拿 0 当「上游说 0」。

const hook = 'onResponse';
const name = 'response-insight';

// 默认关 = passthrough（非侵入铁律④）。开了只加日志字段，不改字节。
const params = {
  // 实际 usage 与请求侧估算的偏差超过这个比例，就在 reason 里标出来（默认 5%）
  discrepancyTolerance: 0.05,
  // 最多保留几个样本进 rec（防止一条巨响应用把日志撑爆）
  maxCharsInspect: 200000,
};

// 🔴 「改写前真实」的代理值标定系数。
//   estTotal 是改写**前**的估算，realSaving 需要「改写前真实」当分子——上游不给这个数，
//   只能拿 est 当代理，而实测它相对真实高估 +5.6%（4 组真包 A/B，logs/bridge-ab-2026-10-02.json）。
//   不标定的话 v1 那组会读成 real-saving-50.8%（真值 53.9%），一个静默的 ~5% 虚高。
//   ⚠️ 没样本时保持 1（不修）——宁可差 5%，也不许拿没验证过的系数去「修」。
//   参数只认自己的 env：`applyPack` 不转发 params（tools/token-policy-bridge.js:65）。
const BIAS_BEFORE = (() => {
  const v = Number(process.env.CURATOR_EST_BIAS_BEFORE ?? '');
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

function numOf(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从响应体里抽 usage。三种形状都认：
 *   chat/completions：usage.{prompt_tokens,completion_tokens,prompt_cache_hit_tokens,...}
 *   responses：usage.input_tokens/output_tokens + input_tokens_details.{cached_tokens, cache_write_tokens}
 *   SSE 末 chunk：data: {...} 里同样是上面那几套
 * @returns {{prompt:number|null, completion:number|null, hit:number|null, miss:number|null}}
 */
function usageOf(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { prompt: null, completion: null, hit: null, miss: null }; }
  }
  if (!obj || typeof obj !== 'object') return { prompt: null, completion: null, hit: null, miss: null };
  const u = obj.usage && typeof obj.usage === 'object' ? obj.usage : {};
  const det = u.input_tokens_details || {};
  return {
    prompt: numOf(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens),
    completion: numOf(u.completion_tokens != null ? u.completion_tokens : u.output_tokens),
    hit: numOf(u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : det.cached_tokens),
    miss: numOf(u.prompt_cache_miss_tokens != null ? u.prompt_cache_miss_tokens : null),
  };
}

function handler(ctx, io) {
  const resp = ctx && ctx.response;
  const est = numOf(ctx && ctx.estTotal);   // 改写**前**的估算基线（桥在 hook 链之前算的）
  const estAfter = numOf(ctx && ctx.estAfter); // 改写**后**的估算（桥：estTotal + Σ netTokenDelta）
  const claimed = numOf(ctx && ctx.estSaved);  // 各 policy 自报净省（正数=省）
  const kind = typeof resp === 'string' ? (resp.includes('data: ') ? 'sse' : 'json') : 'object';

  // 抽 usage：对象/JSON 字符串直接抽；SSE 累积文本走末几个 data: 块
  let u;
  if (kind === 'sse') {
    const blocks = String(resp).split('\n').filter((l) => l.startsWith('data: ')).slice(-4);
    u = { prompt: null, completion: null, hit: null, miss: null };
    for (const b of blocks) {
      const uu = usageOf(b.slice('data: '.length));
      if (uu.prompt != null) u.prompt = uu.prompt;
      if (uu.completion != null) u.completion = uu.completion;
      if (uu.hit != null) u.hit = uu.hit;
      if (uu.miss != null) u.miss = uu.miss;
    }
  } else {
    u = usageOf(resp);
  }

  const tol = Number.isFinite(Number(params.discrepancyTolerance)) ? Number(params.discrepancyTolerance) : 0.05;

  // 🔴 三条互不混淆的对拍线（写成一条会互相读反，见下方 note 的教训）：
  //   ① realSaving —— 「改写前后基线」vs「上游真实」= **这一轮到底省了多少**（最有价值的一条）
  //   ② estBiasAfter —— 「改写后估算」vs「上游真实」= **估算器准不准**（决定 est 能不能拿去规划）
  //   ③ overclaim —— 「policy 自报省了多少 token」vs「上游真实少收了多少 token」= **自报账准不准**
  //      （决定 estSaved 能不能拿去做规划）。
  //   ⚠️ 命名纪律：绝不再用 `est-off-high/low` 这种标签。它把「上游比基线少 52.5%」的净利润
  //     报成了「估算高估 52.5%」——同一个数读反，结论从「改写很值」变成「改写没意义」。
  //   三者任一算不出来就是 null，不许拿 0 或拿别的数凑。
  // ⚠️ 分母各归各：realSaving 以「改写前基线」为分母（省了几成，跟基线比才有意义），
  //    estBiasAfter 以「改写后估算」为分母（估算差了几成，跟它自己的基准比才有意义）。
  //    共用一个 pct(a,b) 会让 realSaving 的读数比真实比例虚高（(基线-真实)/真实）。
  // 🔴 ⚠️ overclaim 必须走 **token 数**对拍，绝不能把「自报的 token 数」跟「realSaving 的比例」
  //     相减——量纲都不一样。真实省了多少 token = 改写前基线 − 上游真实输入。
  const pct = (a, b) => (a != null && b != null && b !== 0 ? (a - b) / b : null);
  // 「改写前真实」的代理。没标定（=1）时就是 est 本身，行为与旧版完全一致。
  const proxyBefore = est != null && BIAS_BEFORE !== 1 ? est * BIAS_BEFORE : est;
  const realSaving = (proxyBefore != null && u.prompt != null && proxyBefore !== 0)
    ? (proxyBefore - u.prompt) / proxyBefore : null;
  const estBiasAfter = (estAfter != null && u.prompt != null) ? pct(u.prompt, estAfter) : null;
  const estAfterRealSaving = (proxyBefore != null && u.prompt != null) ? proxyBefore - u.prompt : null;
  const claimSavedTok = claimed != null ? -claimed : null; // netTokenDelta 负值=省，取正好读
  const overclaimTok = (claimSavedTok != null && estAfterRealSaving != null)
    ? claimSavedTok - estAfterRealSaving : null;
  const overclaimRatio = (overclaimTok != null && estAfterRealSaving != null && estAfterRealSaving !== 0)
    ? overclaimTok / estAfterRealSaving : null;

  const notes = [];
  if (u.prompt == null) {
    notes.push('usage-unavailable');
  } else {
    if (realSaving != null) notes.push(`real-saving-${(realSaving * 100).toFixed(1)}%`);
    if (estBiasAfter != null && Math.abs(estBiasAfter) > tol) {
      notes.push(`est-bias-${estBiasAfter > 0 ? 'under' : 'over'}-${Math.abs(estBiasAfter * 100).toFixed(1)}%`);
    }
    if (overclaimRatio != null && Math.abs(overclaimRatio) > tol) {
      notes.push(`claim-${overclaimRatio > 0 ? 'over' : 'under'}-${Math.abs(overclaimRatio * 100).toFixed(1)}%`);
    }
  }

  // 缓存命中率交叉核：这是 k 估计的另一半分母（代理层独占），agg 命中价折扣 d 可以顺便对一下
  let hitRatio = null;
  if (u.hit != null && u.miss != null && (u.hit + u.miss) > 0) hitRatio = u.hit / (u.hit + u.miss);

  return {
    // 不改字节：回的是纯记账字段，桥不会把它 merge 进请求体（MERGE_FIELDS 里没有它）
    note: notes.join('|'),
    actualPrompt: u.prompt,
    actualCompletion: u.completion,
    actualHit: u.hit,
    actualMiss: u.miss,
    estTotal: est,
    estTotalProxy: proxyBefore,   // 「改写前真实」的代理 = est × 标定系数（无标定=est）
    estBiasBeforeCalibration: BIAS_BEFORE,
    estAfter,
    estSaved: claimed,
    realSaving,
    estBiasAfter,
    realSavedTokens: estAfterRealSaving,
    claimSavedTokens: claimSavedTok,
    overclaimTokens: overclaimTok,
    overclaimRatio,
    hitRatio,
    reason: notes.length ? notes.join('|') : 'in-range',
  };
}

module.exports = { handler, params, hook, name, usageOf };
