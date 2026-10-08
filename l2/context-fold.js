// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// context-fold 内核（28 号文档 · C1「先有秤」的第一块）
//
// 职责：把一次请求体折叠成「7 类上下文组成」的 token 计数——回答「钱花在哪一类 token 上」。
// 这是 l2/cost.js:6-10 自陈「A 路 token×单价是后续独立增量」所缺的那根进料管的第一段：
// 先把 token 量出来（后续再乘单价，本内核不碰钱）。
//
// 为什么是这 7 类：坐标系取自 dsh-context `src/client/categories.ts:27-35`
// （system / tools / user / inject / skill / assistant / tool）。抄的是度量衡定义，
// 不是它的 UI，也不是它绑 DSH session-log 的那一层。抄它的理由很直接：这是目前公开项目里
// 唯一一套被真实使用验证过的上下文组成分类，自己发明一套只会让将来的对照失效。
//
// 设计原则（与 l2/cost.js / alert.js / prompt-cache.js 同构）：
//   - 纯函数：fold() 无副作用、不写盘、不读 process.env、不 require manager lib。
//   - 工厂 + 可注入：createContextFold({ estimate, imageTokens })；单例仅作便利转发。
//   - 复用不重造：估算器直接用 l2/token-policy.js 的 estimateTokens（AGENTS §3 红线）。
//   - 数字诚实：估算与 provider 实测分两条轨，没有实测就是没有；绝不拿估算冒充实测。
//   - 不静默丢弃：认不出的内容单独记账并告警——静默丢弃会让总数对不上却查不出原因。
//
// 边界（必须知道，别拿它吹）：
//   - 本内核只度量，不省任何 token。它是秤，不是刀。
//   - `apply()` 尚未接进请求路径，本内核目前称不到真实流量；能称的是调用方喂进来的请求体。

const { estimateTokens } = require('./token-policy.js');

/** 七类组成，顺序即堆叠条从上到下的顺序。 */
const CATEGORIES = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'];

/** 单个图片 part 的兜底估算（provider 未给精确值时）。保守取中等分辨率图的量级。 */
const DEFAULT_IMAGE_TOKENS = 1024;

// role → 类别。'developer' 是 OpenAI o1 之后的系统级 role，归 system。
const ROLE_MAP = {
    system: 'system',
    developer: 'system',
    user: 'user',
    assistant: 'assistant',
    tool: 'tool',
};

function emptyTally() {
    const t = {};
    for (const c of CATEGORIES) { t[c] = 0; }
    return t;
}

// 把一段 content 折成 token 数：字符串直接估；数组逐 part 处理（文本累加，图片按固定值）。
function foldContent(content, estimate, imageTokens, stats) {
    if (typeof content === 'string') { return estimate(content); }
    if (!Array.isArray(content)) { return 0; }
    let sum = 0;
    for (const part of content) {
        if (!part || typeof part !== 'object') { continue; }
        if (part.type === 'text' || typeof part.text === 'string') {
            sum += estimate(String(part.text ?? ''));
        } else if (part.type === 'image_url' || part.type === 'input_image' || part.image_url || part.image) {
            sum += imageTokens;
            stats.imageParts += 1;
        }
    }
    return sum;
}

// provider 实测分摊：按各类估算占比把 actuals.prompt_tokens 摊回七类。
// 取整余数落在最大的那一类上，保证 sum 精确等于 prompt_tokens——
// 否则「七类之和 == 实测」这条验收会永远差一点。
function apportion(byCategory, actualTotal) {
    const keys = CATEGORIES.filter((k) => byCategory[k] > 0);
    if (!keys.length) { return null; }
    const estTotal = keys.reduce((a, k) => a + byCategory[k], 0);
    if (estTotal <= 0) { return null; }
    const out = emptyTally();
    let acc = 0;
    for (const k of keys) {
        out[k] = Math.round(byCategory[k] * (actualTotal / estTotal));
        acc += out[k];
    }
    const largest = keys.reduce((a, b) => (byCategory[a] >= byCategory[b] ? a : b));
    const residue = actualTotal - acc;
    if (residue !== 0) {
        out[largest] += residue;
        if (out[largest] < 0) { out[largest] = 0; }
    }
    return out;
}

// ---- C2：帧差（纯函数，可独立测）----
//
// 为什么需要这一层：C1 只产出单帧。「上下文是不是在膨胀」「压缩到底压下去没有」
// 这类问题单帧一个都答不了，而它们才是 dsh-context 真正值钱的地方（演进视图）。
//
// 诚实纪律：取数时实测优先、没有才用估算，且**必须把用的是哪一轨带回给调用方**。
// 估算差被当成实测差报出去，就是 C0-3 假数字换个地方重犯。

/** 取一帧的可比数值：实测优先，无实测才回落估算。 */
function pickFrame(rec) {
  if (!rec) { return null; }
  if (rec.actual) { return { byCategory: rec.actual.byCategory, total: rec.actual.total, source: 'actual' }; }
  if (rec.estimate) { return { byCategory: rec.estimate.byCategory, total: rec.estimate.total, source: 'estimate' }; }
  return null;
}

/**
 * 两帧逐类差值（后 - 前）。任一帧不可比 → null。
 * source 为 'mixed' 表示一边实测一边估算——是混血，不得当实测陈述。
 */
function diffFrames(from, to) {
  const a = pickFrame(from);
  const b = pickFrame(to);
  if (!a || !b) { return null; }
  const byCategory = emptyTally();
  for (const c of CATEGORIES) { byCategory[c] = b.byCategory[c] - a.byCategory[c]; }
  const bothActual = a.source === 'actual' && b.source === 'actual';
  const anyActual = a.source === 'actual' || b.source === 'actual';
  return {
    byCategory,
    total: b.total - a.total,
    source: bothActual ? 'actual' : (anyActual ? 'mixed' : 'estimate'),
  };
}

// ---- C5：tool schema 来源标注（schema 懒加载的前置）----
//
// 为什么需要：tools 桶此前是一整坨 JSON.stringify 累加，只答得出「schema 一共多少」，
// 答不出「是谁的、能不能整组裁掉」。懒加载要动刀，得先知道刀往哪落。
//
// 只认跨宿主的 `mcp__<server>__<tool>` 约定，不内置任何一家的工具名表——
// multi-proxy 引擎无关，硬编码某家的 Read/Bash 会把宿主绑死。
// 认不出就如实标 unnamed 并告警，与 C1「不静默丢弃」同一条纪律。

/** MCP 工具命名约定：mcp__<server>__<tool>。非贪婪匹配，server 名可含下划线。 */
const MCP_TOOL_RE = /^mcp__(.+?)__(.+)$/;

/** 从一条 tool 声明里取出名字（OpenAI 形态在 function.name，MCP 形态在 name）。 */
function toolNameOf(t) {
    if (typeof t === 'string') { return t; }
    if (!t || typeof t !== 'object') { return null; }
    const n = t.function && t.function.name ? t.function.name : t.name;
    return typeof n === 'string' && n ? n : null;
}

/**
 * @returns {{source:'mcp'|'named'|'unnamed', server:string|null, name:string|null}}
 */
function classifyToolName(name) {
    if (typeof name !== 'string' || !name) { return { source: 'unnamed', server: null, name: null }; }
    const m = MCP_TOOL_RE.exec(name);
    if (m) { return { source: 'mcp', server: m[1], name: m[2] }; }
    return { source: 'named', server: null, name };
}

/** 来源 → toolsBySource 的 key。MCP 按 server 分组：一个 server 往往几十个工具，是可整体懒加载的最小粒度。 */
function toolSourceKey(c) {
    return c.source === 'mcp' ? `mcp:${c.server}` : c.source;
}

// ---- 工厂：每实例独立配置（测试隔离；延续 l2/ 工厂惯例）----
function createContextFold(opts = {}) {
    const estimate = typeof opts.estimate === 'function' ? opts.estimate : estimateTokens;
    const imageTokens = Number.isFinite(opts.imageTokens) ? opts.imageTokens : DEFAULT_IMAGE_TOKENS;

    /**
     * 折叠一次请求体。
     * @param {object} request  OpenAI 形态请求：{ messages?: [], tools?: [] }
     * @param {object} o
     *   o.actuals     provider 返回值 { prompt_tokens, completion_tokens, cached_tokens }（可选，给了才有实测轨）
     *   o.injections  代理侧注入 [{ sink:'inject'|'skill', source:'pack-x', text?:string, tokens?:number }]
     * @returns {{ estimate:object, actual:object|null, source:string, bySource:object, warnings:string[] }}
     *   estimate.toolsBySource  C5：tool schema 按来源分组的估算量，key 形如 `mcp:github` / `named` / `unnamed`
     *   estimate.toolCount / estimate.toolsUnnamed  工具条数与取不到名字的条数
     */
    function fold(request = {}, o = {}) {
        const byCategory = emptyTally();
        const warnings = [];
        const bySource = {};
        const stats = { imageParts: 0, unclassifiedItems: 0, unclassifiedTokens: 0 };

        const messages = Array.isArray(request.messages) ? request.messages : [];
        const tools = Array.isArray(request.tools) ? request.tools : [];

        for (const m of messages) {
            if (!m || typeof m !== 'object') { continue; }
            const cat = ROLE_MAP[m.role];
            if (!cat) {
                // 不认识的 role 不静默丢弃：单独记账并告警。
                stats.unclassifiedItems += 1;
                stats.unclassifiedTokens += foldContent(m.content, estimate, imageTokens, stats);
                continue;
            }
            let n = foldContent(m.content, estimate, imageTokens, stats);
            // assistant 携带的 tool_calls（arguments）属 assistant 类，不属 tools 类：
            // tools 类专指 schema 声明，两者混成一个桶就没法看出「schema 是不是该懒加载」。
            if (Array.isArray(m.tool_calls)) {
                for (const call of m.tool_calls) {
                    if (call && call.function && typeof call.function.arguments === 'string') {
                        n += estimate(call.function.arguments);
                    }
                }
            }
            byCategory[cat] += n;
        }

        // tools 类 = schema 声明本身（一次请求里通常全量带上，是最容易被忽略的隐性大头）
        // C5：同时按来源分组。总量口径不变，只是多一层「是谁的」——byCategory.tools 仍是同一个数。
        const toolsBySource = {};
        let toolsUnnamed = 0;
        for (const t of tools) {
            const n = estimate(typeof t === 'string' ? t : JSON.stringify(t));
            byCategory.tools += n;
            const c = classifyToolName(toolNameOf(t));
            if (c.source === 'unnamed') { toolsUnnamed += 1; }
            const key = toolSourceKey(c);
            toolsBySource[key] = (toolsBySource[key] || 0) + n;
        }
        if (toolsUnnamed > 0) {
            warnings.push(`${toolsUnnamed} 条 tool 声明取不到名字，来源归入 unnamed（懒加载无法按来源裁剪）`);
        }

        // 代理侧注入：pack / skill / RAG 等。第七类为什么要单列——
        // 夹在 inject 桶里的话，pack 的真实开销永远看不见，「净省了多少」也就永远算不出来。
        for (const inj of Array.isArray(o.injections) ? o.injections : []) {
            if (!inj || typeof inj !== 'object') { continue; }
            const sink = inj.sink === 'skill' ? 'skill' : 'inject';
            const n = Number.isFinite(inj.tokens)
                ? Math.ceil(inj.tokens)
                : estimate(typeof inj.text === 'string' ? inj.text : '');
            byCategory[sink] += n;
            const name = inj.source || '(unnamed)';
            if (!bySource[name]) { bySource[name] = { inject: 0, skill: 0 }; }
            bySource[name][sink] += n;
        }

        const estTotal = CATEGORIES.reduce((a, c) => a + byCategory[c], 0);
        const estimateSide = {
            byCategory,
            total: estTotal,
            unclassified: stats.unclassifiedTokens,
            // C5：来源细分只存在于估算轨。实测轨（provider 的 prompt_tokens）没有来源维度，
            // 不硬凑——凑出来就是假颗粒度。
            toolsBySource,
            toolCount: tools.length,
            toolsUnnamed,
        };

        let actual = null;
        let source = 'estimate';
        if (o.actuals && Number.isFinite(o.actuals.prompt_tokens)) {
            const byActual = apportion(byCategory, o.actuals.prompt_tokens);
            if (byActual) {
                actual = {
                    byCategory: byActual,
                    total: o.actuals.prompt_tokens,
                    cached: Number.isFinite(o.actuals.cached_tokens) ? o.actuals.cached_tokens : null,
                };
                source = 'actual';
            } else {
                warnings.push('estimate-total-is-zero: 估算总数为 0，无法把 provider 实测分摊到七类');
            }
        } else {
            warnings.push('no-provider-actuals: 未给 upstream 实测值，下列数字均为估算，不得当作真实用量对外陈述');
        }
        if (stats.unclassifiedItems > 0) {
            warnings.push(`unclassified: ${stats.unclassifiedItems} 条消息的 role 不在七类映射内，未计入总数`);
        }
        if (stats.imageParts > 0) {
            warnings.push(`image-estimated: ${stats.imageParts} 个图片 part 按 ${imageTokens} tokens/张 兜底估算`);
        }

        return { estimate: estimateSide, actual, source, bySource, warnings };
    }

    // ---- C2 状态层：per-request 记录 + Delta ----
    // 设计上刻意：fold() 保持纯函数、状态只住在这一层。要无状态折叠就用 fold()，
    // 要时间线就用 record()，两者互不污染。
    // 只存内存、不写盘（本内核的定位是秤，落盘持久化是上层的事）。
    const records = [];
    const maxRecords = Number.isFinite(opts.maxRecords) ? opts.maxRecords : 500;

    function lastOfSession(sid) {
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if ((records[i].sessionId || null) === (sid || null)) { return records[i]; }
      }
      return null;
    }

    /**
     * 折叠一次请求并记入时间线。
     * @param {object} o  同 fold() 的 o，另可给 turn / sessionId / now
     * @returns {object} 记录（含 delta：与**同会话**上一条的逐类差；首条为 null）
     */
    function record(request = {}, o = {}) {
      const f = fold(request, o);
      const prev = lastOfSession(o.sessionId);
      const rec = {
        ts: o.now != null ? o.now : Date.now(),
        // turn 给了就用；否则同会话内递增，首条为 1
        turn: Number.isFinite(o.turn) ? o.turn : (prev ? prev.turn + 1 : 1),
        sessionId: o.sessionId || null,
        estimate: f.estimate,
        actual: f.actual,
        source: f.source,
        bySource: f.bySource,
        warnings: f.warnings,
        delta: null,
      };
      // 首条没有参照物 → delta 为 null，不是全 0（全 0 会被读成「确实没变」）
      rec.delta = prev ? diffFrames(prev, rec) : null;
      records.push(rec);
      if (records.length > maxRecords) { records.shift(); }
      return rec;
    }

    function list(sessionId) {
      return (sessionId === undefined)
        ? records.slice()
        : records.filter((r) => r.sessionId === (sessionId || null));
    }

    /** 最近 windowMs 毫秒内的记录（无 ts 边界时返回全部）。 */
    function window(windowMs, now) {
      if (!Number.isFinite(windowMs)) { return records.slice(); }
      const t = Number.isFinite(now) ? now : Date.now();
      return records.filter((r) => r.ts >= t - windowMs);
    }

    function clear() { const n = records.length; records.length = 0; return n; }

    return {
      fold,
      record,
      list,
      window,
      clear,
      diffFrames,
      last: lastOfSession,
      // 直接给引用：改它就是在改内核状态（token-policy 的 listPolicies 返副本曾让人踩坑，
      // 见 MEMORY §四；这里反着来，暴露真身比给副本更难误用）
      records,
      CATEGORIES,
      _estimate: estimate,
      _imageTokens: imageTokens,
    };
}

// ---- 模块级单例（默认配置）----
const _fold = createContextFold();

module.exports = {
    CATEGORIES,
    DEFAULT_IMAGE_TOKENS,
    ROLE_MAP,
    createContextFold,
    apportion,
    diffFrames,
    pickFrame,
    classifyToolName,
    toolNameOf,
    // 单例转发
    fold: _fold.fold,
    record: _fold.record,
    list: _fold.list,
    window: _fold.window,
    clear: _fold.clear,
    last: _fold.last,
    records: _fold.records,
};
