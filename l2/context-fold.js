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
        for (const t of tools) {
            byCategory.tools += estimate(typeof t === 'string' ? t : JSON.stringify(t));
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
        const estimateSide = { byCategory, total: estTotal, unclassified: stats.unclassifiedTokens };

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

    return { fold, CATEGORIES, _estimate: estimate, _imageTokens: imageTokens };
}

// ---- 模块级单例（默认配置）----
const _fold = createContextFold();

module.exports = {
    CATEGORIES,
    DEFAULT_IMAGE_TOKENS,
    ROLE_MAP,
    createContextFold,
    apportion,
    // 单例转发
    fold: _fold.fold,
};
