// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// curator · tools-lazyload：工具 schema 懒加载（第一个真实 handler，替代 passthrough 存根）
//
// 靶子来自实测（30 号基线）：codex 首轮 12 个工具的 schema = 4,871 tokens，
// 占每轮固定开销的 33%。这些 schema 每个 turn 原封不动重发一遍。
//
// 判据（保守、可证伪）：
//   1. schema 规模没过阈值（默认 > 4 个工具）就不动 —— 小 schema 省不出钱，只加风险。
//   2. 历史里一次工具调用都没有 → 全发。第一轮绝不能省：模型得先知道能力全集。
//   3. 只隐藏「从未被调用过」的工具；被调用过的必须留（历史的 tool_call_output 还在消息里，
//      模型认得这个 id，schema 里没有它会直接调不动）。
//   4. 隐藏比例上限（默认 70%）—— 激进裁剪会让模型在没证据的情况下失去能力视野。
//   5. ⭐ 裁剪位置由 pruneMode 决定，默认是 **auto**（按上游自测的 k 选）：
//      suffix（删尾部，T' 是 T 的前缀，断点后退量 = 隐藏量）
//        vs mid（跳着删，断点退到"第一个被删工具"处，后面保留的也要重算 → 后退 > 隐藏）。
//      净收益 = H·d − R·k·(1−d)，H=藏掉、R=断点后退、d=命中价折扣、k=上游对退回段是否按未命中价计。
//      suffix 下 R=H ⇒ 判据退化为 **k ≤ k\* = d/(1−d)**，与藏多少无关（见 55 号）。
//        实测 DeepSeek d=0.1 ⇒ k\*=0.111，而 k≈0 ⇒ mid 更赚（53 号实测 −12.0% vs suffix −4.7%）。
//      k 靠 tools/cache-k-estimator.js 从代理白拿的 usage 自测（换挡样本 Δmiss−Δmsg 比 Δregress），
//      落在 ~/.multi-proxy/cache-estimate.json 当配置源；没标定就当 k=0（按实测最赚的那档走）。
//      上游断点更严（Anthropic/OpenAI 官方网关）时 k 会上来，auto 自动切 suffix。
//
// 返回 netTokenDelta（负=净省）供 token-policy 记账；没上报的是 null 不是 0。
//
// ⚠️ 落地前置（已具备，别再当缺口查）：bridge 的 MERGE_FIELDS 含 tools，
//    mergeOutToRequest 会把它写回请求体（tools/token-policy-bridge.js:232），
//    所以 out.tools 不会被记 ignored。真正卡住裁剪的是调用证据取不到（见 activeToolNames 的注），
//    那一行在 responses 协议下认不到顶层 function_call，症状同样是「装了参数却一点不省」。

const DEFAULTS = {
  minTools: 4,        // 少于等于这个数量就不折腾
  maxHideRatio: 0.85, // 最多藏的比例（实测 0.7 会把几乎所有真实场景卡退化，见 benchmark 记录）
  // coreTools：必留白名单，默认空数组 = 完全按「只藏没用过的」走。
  //   为什么需要它：真实 coding 会话里十几把工具通常只调用过 1–2 把，按 maxHide=0.85
  //   会藏到只剩 1–2 把 —— 而模型下一轮想调的那把**恰好就是被藏的那几把**时，
  //   它不是「省了点 token」，是**这把工具直接调不动**（能力视野塌掉）。
  //   白名单把高频入口钉在保留集里，藏比例照旧不动，换的是可控的最小能力损失。
  //   ⚠️ 它**不参与** no-usage-evidence 判据：首轮（还没跑过工具）必须全发，
  //      否则就在冷启动那一步把能力削掉了，宁可少省一轮。
  //
  // 🔴 默认值是**按真实工具表实测定的**，不是拍的（59 号 / /tmp/p2-real-sweep.js）：
  //   真表来自 logs/bridge-corpus-2026-10-02.jsonl 的首轮请求体 = codex 0.159.3 发的 13 项，
  //   整表 3,689 tok（description 1,184 / parameters 1,905 / 外壳 605）。
  //   空白名单时 mid 下 7 种常态形态有 2 种被 would-over-hide 拦死
  //   （「只跑过命令」「只编辑文件」：13−1=12 > maxHide=floor(13×0.85)=11）；
  //   填这三件后 mid 下 7/7 全裁，kept 3–4、saved 2,447–2,709。
  //   maxHide 是 11，填 3 把留了 1 把余量 —— 只填 2 把（12−2=10）也会贴着边界过，
  //   工具表数一变就会被另一个维度的数卡回来，所以按 3 走。
  //   三件套 = 命令执行 / 文件编辑 / 资源读取，是 coding agent 的能力下限：
  //   藏掉其它 10 项（含 tool_search、web_search 这类上游根本不认的空壳）后，
  //   模型仍能完成绝大多数任务；真被藏的那几把调不到，是可接受的最小损失。
  coreTools: ['exec_command', 'apply_patch', 'read_mcp_resource'],
  // suffix（默认）= 只删尾部未使用的，T' 是 T 的前缀，断点后退量 = 隐藏量 → 任何 k 都不亏。
  // mid           = 删掉所有未使用的（跳着删），断点退到第一个被删工具处，后退量 > 隐藏量。
  //   在"退回段按满价计费"的上游（k=1）上 mid 是亏的；但在 k≈0 的上游上 mid 实测多赚 7 个点
  //   （DeepSeek V4.1-Flash 实测：mid −12.0% 元/轮 vs suffix −4.7%，见 53/54 号）。
  //   'auto' = 按自测的 k 选；显式写 suffix/mid 则强制（扫参/兜底用）。
  pruneMode: 'auto',
  cacheDiscount: 0.1, // 命中价 / 未命中价，DeepSeek 官方 news0802（0.1 元/M vs 1 元/M）
};
const KE = require('../../../tools/cache-k-estimator.js');
// k 的取值来源优先级：显式 env > cache-estimate.json（自测落盘）> 未标定(0)。
// ⚠️ 不能走 io.budget：token-policy.apply 自造 budget 会盖掉外部传进来的字段，
//    挂在 ctx/budget 上的 k 一律取不到（54 号踩过同一类坑）。
function resolvePruneMode(cfg) {
  if (cfg.pruneMode !== 'auto') return { mode: cfg.pruneMode, k: null, kStar: KE.kStar(cfg.cacheDiscount) };
  const raw = process.env.CURATOR_UPSTREAM_K;
  const k = Number(raw) || (KE.read() && Number(KE.read().k)) || 0;
  return { mode: KE.suggestMode(k, cfg.cacheDiscount), k, kStar: KE.kStar(cfg.cacheDiscount) };
}
// 运行时可覆盖（与 token-policy 其它模块一致的 env 风格），便于 A/B 扫参
const ENV_OVERRIDE = {};
if (process.env.CURATOR_MIN_TOOLS) ENV_OVERRIDE.minTools = Number(process.env.CURATOR_MIN_TOOLS);
if (process.env.CURATOR_MAX_HIDE_RATIO) ENV_OVERRIDE.maxHideRatio = Number(process.env.CURATOR_MAX_HIDE_RATIO);
if (process.env.CURATOR_PRUNE_MODE) ENV_OVERRIDE.pruneMode = String(process.env.CURATOR_PRUNE_MODE);
if (process.env.CURATOR_CORE_TOOLS) {
  ENV_OVERRIDE.coreTools = String(process.env.CURATOR_CORE_TOOLS).split(',').map((s) => s.trim()).filter(Boolean);
}

// 调用族 type。除了 function_call，codex 还把「改文件」这类内置操作发成
// **custom_tool_call**（本机 59 个 rollout 实测：apply_patch 15 次全是 custom_tool_call，
// exec_command 1758 次是 function_call）。旧版认名单里漏了 custom_tool_call ⇒
// 某场景只改过文件（没跑过命令）时 usedNames 恒空 → 整条 policy 走 no-usage-evidence
// 静默不裁，日志上跟「压根没算」长得一模一样。
const CALL_TYPES = new Set(['function_call', 'tool_call', 'mcp_tool_call', 'custom_tool_call']);

function activeToolNames(messages) {
  const names = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const calls = m.tool_calls || (Array.isArray(m.content) ? [] : null);
    if (Array.isArray(calls)) {
      for (const c of calls) {
        // 🔴 工具名在两种协议里位置不一样，只认其中一个会整条判据失效：
        //   chat / completions: { id, type:'function', function:{ name } }  ← name 在 c.function.name
        //   responses 的 content[]: { type:'tool_call', name }             ← name 是顶层
        //   早期版本只取 c.name，于是 chat 协议下 activeToolNames 永远返回空集 →
        //   handler 每次都走 no-usage-evidence，裁剪静默全灭，日志上还看不出异常。
        const n = (c && c.name) || (c && c.function && c.function.name) || (c && c.function_call && c.function_call.name);
        if (n) names.add(n);
      }
    }
    // Responses API：工具调用写在 content[] 的 tool_call 段里
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c && c.type === 'tool_call' && c.name) names.add(c.name);
        if (c && c.type === 'function_call' && c.name) names.add(c.name);
        if (c && c.type === 'custom_tool_call' && c.name) names.add(c.name);
      }
    }
    // 🔴 responses 协议把工具调用放在 input[] 的**顶层**条目里
    //    （{ type:'function_call' | 'mcp_tool_call', name }），不带 content 数组 ——
    //    上面那两个分支都扫不到它，usedNames 恒空 → handler 每次 fallback('no-usage-evidence')
    //    → 重写模式在 codex 主链路上一次都不触发，而日志上「跑了但没省」和「压根没算过」
    //    长得一模一样（13 工具 + 一轮真实调用，实测 activeTools = []）。
    if (typeof m.name === 'string' && m.name) {
      if (CALL_TYPES.has(m.type)) names.add(m.name);
    }
  }
  return names;
}

// 与探针/token-policy 同口径：整个 tools 数组 stringify 后按 3 字符 ≈ 1 token 估算。
// 刻意只用整体口径（而非逐工具求和）——逐工具会漏掉数组外壳与 type/strict 等外层字段，
// 算出来的节省比真实少一大截，那是假数字。
function schemaTokens(tools) {
  let s = '';
  try { s = JSON.stringify(Array.isArray(tools) ? tools : []); } catch { return 0; }
  return Math.ceil(s.length / 3);
}

/**
 * @param {{tools?:Array, messages?:Array, agentType?:string}} ctx
 * @param {{budget?:object}} io
 */
function handler(ctx, io) {
  const cfg = Object.assign({}, DEFAULTS, ENV_OVERRIDE, (io && io.budget) || {});
  const tools = Array.isArray(ctx && ctx.tools) ? ctx.tools : [];
  const total = tools.length;
  const used = activeToolNames(ctx && ctx.messages);

  // ⚠️ fallback 也必须报 breakpointSchemaTokens（= 全发时断点在 schema 末尾）。
  //    不报的话，「上轮全发 → 本轮裁剪」这个唯一的换挡样本拿不到 Δregress 的分母，
  //    k 会永远估不出来、配置源永远空着 —— 观测器等于没接（实测踩到，55 号记录）。
  const allTokens0 = schemaTokens(tools);
  const fallback = (reason, kept) => ({
    reason, total, kept: kept === undefined ? total : kept, saved: 0,
    breakpointSchemaTokens: allTokens0,
    activeTools: [], hiddenTools: [], keptNames: tools.map((t) => (t && t.function && t.function.name) || (t && t.name) || '?'),
    netTokenDelta: 0,
  });

  // 🔴 与 tools-summary-downgrade 互斥。两个 policy 都挂 onRequestAssemble、都产出 tools 字段，
  //    mergeOutToRequest 只能写一次 tools（后一个覆盖前一个），saved 记账也按最后一次算 ——
  //    同时开 = 省多少全看注册顺序，是个说不清的账。
  //    让 P3 优先：它不动工具数、每轮输出稳定，本来就是更保守的那一档（58 号推荐度 ★★★★★）。
  if (String(process.env.CURATOR_SUMMARY_MODE || 'off').trim() !== 'off') {
    return fallback('summary-mode-active');
  }

  if (!total) return fallback('no-tools');
  if (total <= cfg.minTools) return fallback('below-min-tools');

  const names = tools.map((t) => (t && t.function && t.function.name) || t && t.name || '?');
  const nameToTool = new Map();
  tools.forEach((t, i) => { nameToTool.set(String(names[i]).split('(')[0], t); });

  // 只有单个工具名空间（codex 的 function 包裹）时按 function.name 匹配
  const usedNames = new Set();
  for (const u of used) usedNames.add(String(u).split('(')[0]);

  if (!usedNames.size) return fallback('no-usage-evidence'); // 首轮 / 还没跑过工具

  // 保留集 = 用过的 ∪ core 白名单（core 只在有使用证据之后才生效，见上面注释）
  const coreNames = new Set((Array.isArray(cfg.coreTools) ? cfg.coreTools : [])
    .map((n) => String(n).split('(')[0]));
  const keepNames = new Set([...usedNames, ...coreNames]);

  const rm = resolvePruneMode(cfg);
  const effMode = rm.mode; // k ≥ k* ⇒ suffix（防后退），否则 mid（多赚）

  // 决定从第几个工具开始删（kept = tools.slice(0, dropFrom)）
  const maxHide = Math.max(0, Math.floor(total * cfg.maxHideRatio));
  let dropFrom = total;
  let keptTools;
  const drop = new Set();
  if (effMode === 'mid') {
    // 跳着删：删掉所有「未被调用过」的，被调用的一把不留。
    // ⚠️ T' 因此**不是** T 的前缀 —— 断点退到第一个被删工具处，它后面保留下来的工具
    //    也要重算，所以后退量 > 隐藏量。这就是 mid 在 k=1 上游上会亏的原因。
    for (let i = 0; i < total; i++) {
      if (!keepNames.has(String(names[i]).split('(')[0])) drop.add(i);
    }
    if (!drop.size) return fallback('nothing-to-hide');
    if (drop.size > maxHide) return fallback('would-over-hide', total);
    keptTools = tools.filter((t, i) => !drop.has(i));
    dropFrom = Math.min(...drop);
  } else {
    // suffix：从最后一个工具往前扫，连续「没被调用过」的一截才是可删的。
    // 一旦碰到被调用过的就停 —— 它前面若还有未使用的，也**不许删**，
    // 否则 T' 就不是 T 的前缀，缓存断点会退到更早的位置（白付学费）。
    let suffixCount = 0;
    while (suffixCount < total && !keepNames.has(String(names[total - 1 - suffixCount]).split('(')[0])) suffixCount++;
    if (!suffixCount) return fallback('tail-used-blocked'); // 尾部长用的工具 → 一都删不动，宁可不省
    dropFrom = total - Math.min(suffixCount, maxHide);
  }
  const hiddenCount = total - dropFrom;
  if (hiddenCount < 1) return fallback('nothing-to-hide');

  if (!keptTools) keptTools = tools.slice(0, dropFrom); // suffix 模式（前缀裁剪）
  // 被藏掉的下标：suffix 是尾部连续一段；mid 是 drop 集合（可能散在中间）
  for (let i = dropFrom; i < total; i++) drop.add(i);
  const hidden = names.filter((_, i) => drop.has(i));
  const keptNames = names.filter((_, i) => !drop.has(i));
  const allTokens = allTokens0;
  const keptTokens = schemaTokens(keptTools);

  return {
    tools: keptTools,
    keptNames,
    hiddenTools: hidden,
    total,
    kept: keptTools.length,
    saved: allTokens - keptTokens,
    totalSchemaTokens: allTokens,
    keptSchemaTokens: keptTokens,
    activeTools: Array.from(usedNames), // 只报真实使用证据，不含白名单（别的口径会污染 saved 记账）
    coreTools: Array.from(coreNames),
    reason: effMode === 'mid' ? 'lazy-loaded' : 'lazy-loaded(suffix-only)',
    // 断点落在 keptTokens 处：之后整段（被藏的 + 原本来就在的）都要重算。
    // 净收益 ≈ H×d − R×(1−d)×k（H=saved，R=后退段，suffix 下 R=H）。
    breakpointSchemaTokens: keptTokens,
    prune: effMode,
    k: rm.k,
    kStar: rm.kStar,
    netTokenDelta: -(allTokens - keptTokens), // 负=净省
  };
}

module.exports = { name: 'tools-lazyload', hook: 'onRequestAssemble', handler, schemaTokens, activeToolNames };
