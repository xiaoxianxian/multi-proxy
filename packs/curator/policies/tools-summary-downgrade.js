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
// 🔴 schema 的真实构成决定了动哪里（/tmp 扫参，语料 logs/bridge-corpus-2026-10-02.jsonl）：
//   真表 13 项、3,689 tok = description 1,184（32%）/ parameters 1,905（52%）/ 外壳 605（16%）。
//   ↓ 说明「压 description 」这一档天花板只有 ~32%，真正的油在 parameters 里
//     （每个参数字段自带一句 description，那才是 52% 的大头）。
//   所以两档的取值范围是：light ≈ −25~30%，aggressive ≈ −45~53%，与 58 号扫参数字对得上。
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
  // off | light | aggressive
  mode: 'off',
  lightMaxChars: 110,     // light 档 description 保留长度上限（英文一句 ≈ 60–90 字符够用）
  aggressiveMaxChars: 55, // aggressive 档
  minDescChars: 24,       // 短于这个就原样留着：砍不动，砍了反而丢信息
};

// 🔴 剥 parameters 字段说明这件事**只归 aggressive**，light 一律不动参数说明。
//    真链路上实测踩过（59 号）：开着 aggressive 跑真实 codex 任务，模型给 exec_command
//    传了 justification 参数、被 codex 客户端拒（`justification` 需要显式 sandbox_permissions）——
//    它就写在 justification 自己的 description 里，说明被删了模型当然不知道。
//    light 只压工具级 description，模型仍看得到每个参数各自要求什么，风险面小得多。
const STRIP_PARAM_DESC = { light: false, aggressive: true };

if (process.env.CURATOR_SUMMARY_MODE) DEFAULTS.mode = String(process.env.CURATOR_SUMMARY_MODE).trim();
if (process.env.CURATOR_SUMMARY_LIGHT_CHARS) DEFAULTS.lightMaxChars = Number(process.env.CURATOR_SUMMARY_LIGHT_CHARS);
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

/** 这条参数说明属于「删了会出事」的那一类吗 */
function isProtectedDesc(text) {
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
        if (typeof p.description === 'string' && p.description && !isProtectedDesc(p.description)) {
          delete p.description; touched = true;
        }
        if (p.items && typeof p.items === 'object' && typeof p.items.description === 'string'
          && p.items.description && !isProtectedDesc(p.items.description)) {
          delete p.items.description; touched = true;
        }
      }
    }
  }
  return touched;
}

function downgradeTool(t, maxChars, stripParams) {
  const out = clone(t);
  if (!out || typeof out !== 'object') return { tool: t, touched: false };
  let touched = false;
  if (typeof out.description === 'string' && out.description) {
    const t2 = trimDescription(out.description, maxChars);
    if (t2 !== out.description) { out.description = t2; touched = true; }
  }
  // 🔴 parameters 只在它是 plain object 时才动 —— 有 $ref/oneOf 这类组合子的 schema 结构复杂，
  //    「删字段说明」的遍历假设会失效，宁可跳过这一条也不瞎改（改坏了是 400，不是省点钱）。
  if (stripParams && out.parameters && typeof out.parameters === 'object'
    && !out.parameters.$ref && !out.parameters.oneOf && !out.parameters.anyOf
    && !out.parameters.allOf && !out.parameters.$schema) {
    if (stripParamDescriptions(out.parameters)) touched = true;
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
  // 🔴 off 与「拼错的 mode」都必须走 null。写成白名单判断（只放行 light/aggressive）
  //    而不是「非三者之一就返回」：前者让拼错的字符串落进下面的压缩分支，
  //    请求体被悄悄改了还以为是显式开的，出事时查谁都不知道改过。
  if (cfg.mode !== 'light' && cfg.mode !== 'aggressive') return null;
  const tools = Array.isArray(ctx && ctx.tools) ? ctx.tools : [];
  if (!tools.length) return null;

  const aggressive = cfg.mode === 'aggressive';
  const maxChars = aggressive ? cfg.aggressiveMaxChars : cfg.lightMaxChars;
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
