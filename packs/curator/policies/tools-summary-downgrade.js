'use strict';
// curator · tools-summary-downgrade：工具**摘要降级**（58 号方案 P3）
//
// 与 tools-lazyload 的区别，就一句话：
//   lazyload = 删工具（能力视野塌，但省得多）
//   downgrade = 不删工具，只压 description / 参数字段说明（能力视野在，但省得少）
//
// 为什么值得单独做一个：58 号离线扫参 5 档 × 6 形态给出过推荐度排序，
// P3 排第一（★★★★★），理由不是它省得多，是它三个性质同时成立：
//   1. **工具数不变** —— 模型下一轮想调哪把都能调，不存在「调不动」这个失败模式；
//   2. **静态不漂** —— 同一份 tools 每轮压出一模一样的请求体，
//      而 lazyload 的保留集随 used 每轮漂（3→4→5），等于每轮换一次形状、缓存断点每轮断一次；
//   3. 改动落在**请求体的尾部**（tools 在 messages 之后），
//      实测（57/58 号）尾部改动对命中率几乎零影响（suffix 裁剪只掉 0.5pp）。
//
// 补一层学理口径（2026-10-04，别把三档理解成「省钱三档」）：
//   Lieder & Griffiths (2020, BBS 43:e1) 把「好推理」定义为有限资源下的最优使用，
//   Griffiths 一路（Griffiths/Zhu/Grant/McCoy 2024, Current Directions in Psychological Science）
//   进一步给了个可量化的形状：允许同时考虑多少假设，学会每一种就要多少证据，
//   可能性越开放，经验越廉价。
//   所以档位调的其实是「这一轮留多少候选假设」：
//     aggressive = 候选集收窄到少数几条可用线索，每条证据必须足够硬才能把某个假设垫起来；
//     light      = 候选集开着，那就得靠更长上下文把每条证据垫实，缓存也更难命中。
//   省钱是这套设计的副产品，不是它的定义；价格一波动，副产品会掉，档位结构本身不掉。
//
// 🔴 schema 的真实构成决定了动哪里（/tmp 扫参，语料 logs/bridge-corpus-2026-10-02.jsonl）：
//   真表 13 项、3,689 tok = description 1,184（32%）/ parameters 1,905（52%）/ 外壳 605（16%）。
//   ↓ 说明「压 description 」这一档天花板只有 ~32%，真正的油在 parameters 里
//     （每个参数字段自带一句 description，那才是 52% 的大头）。
//   所以三档的取值范围是：light ≈ −25~30%（只压 description）、
//   balanced ≈ −40~50%（不动 description、只剥非保护的参数说明）、
//   aggressive ≈ −45~53%（description 也压到 55 字符）。与 58 号扫参数字对得上。
//
// 三档（065 号补的 balanced 是影子候选，真链路首选）：
//   light     = 只压工具级 description，parameters 一个字符不动   —— 最保守，省得也最少
//   balanced  = 不动 description，只剥「非保护」的参数字段说明      —— 油本来就在 parameters（52%）
//   aggressive= balanced 之上再把 description 压到 55 字符          —— 省得最多，但踩过客户端拒调用的坑
// balanced 的定位 = 拿 aggressive 那档的省量、避开它「整句说明被删」的失败模式：
//   description 是给「要不要用这把工具」看的（工具级的），parameters 说明是给「参数怎么传」看的
//   （调用级的）。多数省量来自调用级那层，而调用级那层的保护名单更窄、一旦删错直接 400/被拒。
//
// ⚠️ 铁律（动了就报错，不是省一点钱的问题）：
//   - 不碰 name / type —— 工具身份与 wire 契约；
//   - 不碰 required、不碰 parameters 的键结构 —— 模型靠它构造合法调用；
//   - 不碰 format.definition —— apply_patch 是 { type:'custom', format:{syntax:'lark', definition} }，
//     那是语法契约不是文字描述，削掉一个字符上游就直接报错；
//   - 不碰 enum 的取值本身（只砍取值上的说明文字）；
//   - 宁可少压，也绝不为了数字把一句必需的话砍掉 —— 压到「模型不知道该传什么」就是亏本买卖。
//
// 默认 off（curator pack 的非侵入铁律：默认关，要开显式给 env）。

const DEFAULTS = {
  // off | light | balanced | aggressive
  mode: 'off',
  lightMaxChars: 110,      // light 档 description 保留长度上限（英文一句 ≈ 60–90 字符够用）
  balancedMaxChars: Infinity, // balanced 档**不压 description**（默认 Infinity）
  aggressiveMaxChars: 55,  // aggressive 档
  minDescChars: 24,         // 短于这个就原样留着：砍不动，砍了反而丢信息
};

// 🔴 剥 parameters 字段说明这件事**只归 balanced 以上**，light 一律不动参数说明。
//    真链路上实测踩过（59 号）：开着 aggressive 跑真实 codex 任务，模型给 exec_command
//    传了 justification 参数、被 codex 客户端拒（`justification` 需要显式 sandbox_permissions）——
//    它就写在 justification 自己的 description 里，说明被删了模型当然不知道。
//    light 只压工具级 description，模型仍看得到每个参数各自要求什么，风险面小得多。
//    balanced 也剥（这就是它的全部目的），但走 isProtectedDesc 名单 ——
//    真出事那句（requires explicit sandbox permissions）在任何档位都留着，见 PARAM_DESC_KEEP。
const STRIP_PARAM_DESC = { light: false, balanced: true, aggressive: true };

if (process.env.CURATOR_SUMMARY_MODE) DEFAULTS.mode = String(process.env.CURATOR_SUMMARY_MODE).trim();
if (process.env.CURATOR_SUMMARY_LIGHT_CHARS) DEFAULTS.lightMaxChars = Number(process.env.CURATOR_SUMMARY_LIGHT_CHARS);
if (process.env.CURATOR_SUMMARY_BALANCED_CHARS) DEFAULTS.balancedMaxChars = Number(process.env.CURATOR_SUMMARY_BALANCED_CHARS);
if (process.env.CURATOR_SUMMARY_AGGRESSIVE_CHARS) DEFAULTS.aggressiveMaxChars = Number(process.env.CURATOR_SUMMARY_AGGRESSIVE_CHARS);
// 兜底：手动强制两档都剥（扫参/A-B 用），默认空 = 按档位走
if (process.env.CURATOR_SUMMARY_STRIP_PARAM_DESC === '1') STRIP_PARAM_DESC.light = true;
if (process.env.CURATOR_SUMMARY_STRIP_PARAM_DESC === '0') STRIP_PARAM_DESC.aggressive = false;

// 与探针/token-policy 同口径：整个 tools 数组 stringify 后按 3 字符 ≈ 1 token 估算。
// 🔴 刻意只用整体口径（tools-lazyload.js 同一个理由）：逐工具求和会漏掉数组外壳与
//    type/strict 等外层字段，算出来的节省比真实少一大截，那是假数字。
function schemaTokens(tools) {
  let s = '';
  try { s = JSON.stringify(Array.isArray(tools) ? tools : []); } catch { return 0; }
  return Math.ceil(s.length / 3);
}

// 深拷贝一份再改：policy 绝不原地改调用方的 tools（同一个数组还要给后续 policy 用）。
const clone = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch { return null; } };

/**
 * 截到第一个「语义断点」，而不是硬切字符串。
 * 硬切会切出半句话，模型读到「Runs a command in a P」这种残缺描述反而更糟；
 * 先按 句 → 分句 的优先级找边界，找不到再硬切（此时宁可压短一点，也不留半截）。
 */
function trimDescription(text, maxChars) {
  if (typeof text !== 'string' || !text) return text;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars || t.length <= DEFAULTS.minDescChars) return t;
  const cut = t.slice(0, maxChars);
  // 逗号也算断点：真表上大量 description 是「功能一句话 + 若干使用提示」，
  // 只认句号会把「Runs a command in a PTY, returning output…」这种压成半截残句。
  const stops = ['. ', '.', '! ', '? ', '; ', ',', '\n'];
  let at = -1;
  for (const s of stops) {
    const i = cut.lastIndexOf(s);
    if (i > 0) at = Math.max(at, i + 1);
  }
  if (at >= DEFAULTS.minDescChars) return cut.slice(0, at).trim();
  return cut.replace(/[,;:\s]+$/, '').trim() + '…';
}

// 🔴 参数说明里的「不能删」名单。
//    真链路事故（59 号）：aggressive 把 exec_command.justification 的说明整条删掉，
//    那句原文是 “requires explicit sandbox permissions” —— 它不是修辞，是**安全契约**：
//    删了模型不知道要显式授权，于是直接传了 justification，被 codex 客户端当场拒。
//    所以「剥参数说明」不能一刀切：带权限/格式/必填语义的说明，任何档位都得原样留着。
//    判据用关键词而不是整句比对：上游工具表是第三方写的，措辞不可能固定，
//    但「权限 / 格式 / 必须」这些语义词的出现概率极高。
const PARAM_DESC_KEEP = /permission|sandbox|justification|required|must not|cannot|only|format|syntax|grammar|absolute|relative|utf-?8|path to|specif/i;

// 🔴 参数**名**维度的名单（2026-10-02 真链路抓出来的破口，见下）。
//    59 号那次事故后来补了 PARAM_DESC_KEEP，但它是拿**描述文本**去测的 ——
//    真表上 justification 的说明原文是 “User-facing approval question for `require_escalated`; omit otherwise.”
//    一个关键词都不带，于是 balanced 档照样把它删了（偷听器实锤：12/12 个真上游包里
//    justification 只剩 {"type":"string"}）。文本措辞是第三方写的、不可控，
//    但**参数名**是工具表作者自己定的、跟语义强绑定 ⇒ 名字命中就必须留，不看措辞。
//    只收「授权/权限」这一类，别贪：贪多了 balanced 就省不动了。
const PARAM_NAME_KEEP = /justification|sandbox|permission|permission|approval|escalat/i;

/** 这条参数说明属于「删了会出事」的那一类吗（名字或文本任一命中即保护） */
function isProtectedDesc(name, text) {
  if (typeof name === 'string' && PARAM_NAME_KEEP.test(name)) return true;
  return typeof text === 'string' && PARAM_DESC_KEEP.test(text);
}

// 剥参数字段上的说明。🔴 只删 description，不删字段本身/type/required/enum 取值。
function stripParamDescriptions(params) {
  if (!params || typeof params !== 'object') return false;
  let touched = false;
  const props = params.properties;
  if (props && typeof props === 'object') {
    for (const k of Object.keys(props)) {
      const p = props[k];
      if (p && typeof p === 'object') {
        // 🔴 传参数名（k）：名字命中授权类白名单就整条留着，不看它措辞里带不带关键词
        if (typeof p.description === 'string' && p.description && !isProtectedDesc(k, p.description)) {
          delete p.description; touched = true;
        }
        if (p.items && typeof p.items === 'object' && typeof p.items.description === 'string'
          && p.items.description && !isProtectedDesc(k, p.items.description)) {
          delete p.items.description; touched = true;
        }
      }
    }
  }
  return touched;
}

// 🔴 两种工具形状（真踩到，见 A/B 探针）：
//   codex 扁平   = { type:'function', name, description, parameters, strict }   ← 真表就长这样
//   OpenAI 嵌套  = { type:'function', function:{ name, description, parameters } }
//   早期版本只认扁平的顶层字段 ⇒ 喂嵌套形状时 description/parameters 都是 undefined，
//   一个字都不改、handler 返回 null，**桥照样记账、看起来像「这轮没触发」**。
//   真链路上没炸是因为 codex 发扁平；一旦上游/客户端换成嵌套形状（或桥的 normalizeTools
//   把扁平转成嵌套后再跑 policy），这条就静默失效。所以这里两套形状都要认。
function targetOf(out) {
  return out && typeof out === 'object' && out.function && typeof out.function === 'object' ? out.function : out;
}

function downgradeTool(t, maxChars, stripParams) {
  const out = clone(t);
  if (!out || typeof out !== 'object') return { tool: t, touched: false };
  let touched = false;
  const f = targetOf(out);                       // 嵌套形状下的 description/parameters 住在这层
  const fDesc = typeof f.description === 'string' ? f.description : null;
  const topDesc = typeof out.description === 'string' ? out.description : null;
  const desc = fDesc !== null ? fDesc : topDesc;
  if (typeof desc === 'string' && desc) {
    const t2 = trimDescription(desc, maxChars);
    if (t2 !== desc) { f.description = t2; touched = true; }
  }
  // description 两头都不在（比如 web_search 这种连 name 都没有的裸条目）⇒ 不猜，**别创建字段**
  if (f !== out && fDesc === null && topDesc === null) { /* 无 description 可压，照原样返回 */ }

  const params = out.parameters || f.parameters;
  // 🔴 parameters 只在它是 plain object 时才动 —— 有 $ref/oneOf 这类组合子的 schema 结构复杂，
  //    「删字段说明」的遍历假设会失效，宁可跳过这一条也不瞎改（改坏了是 400，不是省点钱）。
  if (stripParams && params && typeof params === 'object'
    && !params.$ref && !params.oneOf && !params.anyOf
    && !params.allOf && !params.$schema) {
    if (stripParamDescriptions(params)) touched = true;
  }
  return { tool: out, touched };
}

/**
 * @param {{tools?:Array, messages?:Array, agentType?:string}} ctx
 * @param {{budget?:object}} io
 * @returns {object|null} mode=off 时返回 null（不产出 tools 字段 ⇒ 桥不会把没动过的东西写回请求体）
 */
function handler(ctx, io) {
  const cfg = Object.assign({}, DEFAULTS, (io && io.budget) || {});
  // 🔴 off 与「拼错的 mode」都必须走 null。写成白名单判断（只放行 light/balanced/aggressive）
  //    而不是「非四者之一就返回」：前者让拼错的字符串落进下面的压缩分支，
  //    请求体被悄悄改了还以为是显式开的，出事时查谁都不知道改过。
  if (cfg.mode !== 'light' && cfg.mode !== 'balanced' && cfg.mode !== 'aggressive') return null;
  const tools = Array.isArray(ctx && ctx.tools) ? ctx.tools : [];
  if (!tools.length) return null;

  const aggressive = cfg.mode === 'aggressive';
  const maxChars = aggressive ? cfg.aggressiveMaxChars
    : cfg.mode === 'balanced' ? cfg.balancedMaxChars
      : cfg.lightMaxChars;
  // 🔴 档位开关（不是预算字段）：STRIP_PARAM_DESC 在**模块级**定义、不吃 cfg 合并，
  //    这里必须按 mode 回查，否则读 cfg.stripParamDesc 永远是 undefined（DEFAULTS 里已无此项）。
  //    当初写成 `Object.assign({}, DEFAULTS, {stripParamDesc})` 的旧版就是靠 DEFAULTS 带出来的，
  //    把开关挪到档位表之后这条线必须一起换，不然 aggressive 静默失去剥参数的能力。
  //    env 的强制覆盖也走同一张表（CURATOR_SUMMARY_STRIP_PARAM_DESC=1/0），保证「钉死开关」不掉档。
  const stripParams = STRIP_PARAM_DESC[cfg.mode] === true;
  const allTokens = schemaTokens(tools);

  const kept = [];
  let changedCount = 0;
  for (const t of tools) {
    const { tool, touched } = downgradeTool(t, maxChars, stripParams);
    if (touched) changedCount++;
    kept.push(tool);
  }
  if (!changedCount) return null;

  const keptTokens = schemaTokens(kept);
  const saved = allTokens - keptTokens;
  return {
    tools: kept,
    mode: cfg.mode,
    // stable=true：同一份输入永远压出同一份输出 —— lazyload 的 kept 每轮随 used 漂，
    // 这个不漂，是 P3 排第一的直接原因（缓存断点不会被自己每轮打断）。
    stable: true,
    total: tools.length,
    changed: changedCount,
    saved,
    totalSchemaTokens: allTokens,
    keptSchemaTokens: keptTokens,
    breakpointSchemaTokens: keptTokens,
    // 净收益 ≈ H×d − R×(1−d)×k；这里断点后退 R = 省掉的那一段（改动落在 tools 尾部，
    // 前后文整段仍在命中区），所以与 lazyload 的 suffix 档是同一种形状，判据可直接套用。
    netTokenDelta: -saved, // 负=净省
  };
}

/** 与 lazyload 互斥的依据，供 tools-lazyload 调用 */
function summaryModeActive() {
  return DEFAULTS.mode !== 'off';
}

module.exports = {
  name: 'tools-summary-downgrade',
  hook: 'onRequestAssemble',
  handler,
  schemaTokens,
  trimDescription,
  summaryModeActive,
  isProtectedDesc,
  PARAM_DESC_KEEP,
  DEFAULTS,
};
