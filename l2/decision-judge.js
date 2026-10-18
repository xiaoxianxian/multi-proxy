// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// LLM judge 复判（复杂度档位）—— Clef SystemOne 客户端，2026-10-03 接入。
//
// 背景：route-engine.js:216-220 注释预留的「二期 LLM judge 动态复判」口子，本文件即该能力实现。
// 落点选择依据（见 multi-proxy/docs/10-initiatives/71-StartLux-Decision-可用性对照-2026-10-03.md）：
//   - 本机实测 Clef-flash-4bit 走 HTTP /v1/systemone：choice 热态 p50 327ms / p95 428ms，
//     与 in-process 的 315ms 同量级，HTTP 包装零损耗，可以直接走服务而不必内嵌模型。
//   - 服务由权重自带 clef_mlx.py serve 提供（`python clef_mlx.py serve --port 18793`），
//     与 Jev/SystemOne 同协议，无需自己写 server。
//
// 纪律（Portico/02-架构设计.md 条款 5）：complexity 定价权归 Portico，
// agent 侧只能**观测**不能改档。所以本模块只产结果，是否采纳由 Portico 决定。
// 低置信落 medium 的兜底函数单独导出，供 Portico 在它的定价点上调用。

const DEFAULT_JUDGE_URL = 'http://127.0.0.1:18793/v1/systemone';
// 热路径旁路：judge 超时不阻塞，只观测。
// 1500ms 是实测定的：Clef 热态 p50 ~170-330ms，但服务冷态首请求可达 3-7.5s，
// 且 800ms 那版实测卡在边界（805ms 刚好 abort，静默返回 null）。留 3-5 倍余量。
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MIN_CONF = 0.55;    // 低于此置信一律落 medium（保守兜底）

// 三档位语义，与 routing-base 的 mapTier 输出对齐
const TIER_CRITERIA = {
    '0': 'small：单个短回复',
    '1': 'medium：多步骤但可控',
    '2': 'large：长上下文复杂推理',
};

/**
 * 调 Clef SystemOne 复判文本复杂度档位。
 *
 * 永不抛错、永不 reject：judge 不可用（服务没起 / 超时 / 返回异常）一律返回 null，
 * 调用方据此保持原档位。热路径挂这里不能拉垮路由。
 *
 * opts.previousTier（2026-10-18 外部对照 #71 PilotDeck 落地件）：带上轮档位时，
 * 把「续聊应保持上轮档位」写进 Clef 的 state 提示（对齐 PilotDeck 给 judge 的
 * CRITICAL RULE——它用 prompt 规则防「好的/继续」被误降档）。
 * 注意这只是**提示层**：确定性的短消息短路在 l2/route-sticky.js 的
 * isContinuation（规则命中时一次模型都不调），两条腿合用才是完整机制。
 * previousTier 缺省时 state 原文不变（零行为变更）。
 *
 * @param {string} text 待判文本
 * @param {{url?:string, timeoutMs?:number, minConf?:number, previousTier?:string}} opts
 * @returns {Promise<null|{tier:string, confidence:number|null, probabilities:object|null, latencyMs:number|null, model:string|null}>}
 */
async function judgeComplexity(text, opts = {}) {
    if (typeof text !== 'string' || text.length === 0) return null;

    const url = opts.url || process.env.L2_LLM_JUDGE_URL || DEFAULT_JUDGE_URL;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'clef-flash-4bit',
                // previousTier 存在时加续聊保护提示（对齐 PilotDeck CRITICAL RULE；
                // 缺省时此句与原文逐字一致，零行为变更）。
                state: opts.previousTier
                    ? `判断这条请求该走哪个 complexity 档位。注意：上一轮判为 ${opts.previousTier} 档。若本条是上一轮任务的简短跟进（例如"好的""继续""冲"），应保持 ${opts.previousTier} 档；只有出现明确的新任务且复杂度不同时才改判。`
                    : '判断这条请求该走哪个 complexity 档位。',
                questions: {
                    tier: { type: 'choice', instructions: '请判断档位。', criteria: TIER_CRITERIA },
                },
            }),
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = await res.json();
        const ans = body && body.answers && body.answers.tier;
        if (!ans || !ans.choice) return null;
        return {
            tier: String(ans.choice),
            confidence: ans.confidence == null ? null : ans.confidence,
            probabilities: ans.probabilities || null,
            latencyMs: body && body.usage ? body.usage.latency_ms : null,
            model: body ? body.model : null,
        };
    } catch {
        return null; // 降级：judge 不可用，调用方保持原档
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 低置信落 medium —— 与 routing-base 的 `m[complexity] || 'medium'` 保守兜底同侧。
 * 置信度来源是 Clef 的 softmax 概率（实测校准度不足，不能当硬闸门，
 * 见 Photo-Audit-Demo/docs/Clef-flash-4bit_本机实测-2026-10-03.md），
 * 所以这里只做**保守降级**，不做「低置信直接放行」。
 *
 * @param {string} tier Clef 判出的档位
 * @param {number|null} confidence Clef 给的置信度
 * @param {number} minConf 保守阈值
 * @returns {string} 采纳档位
 */
function tierWithMinConfidence(tier, confidence, minConf = DEFAULT_MIN_CONF) {
    if (confidence != null && confidence < minConf) return 'medium';
    return tier;
}

// --------------------------------------------------------------------------- 风险打标位
//
// 打标是什么：不光回答「拦不拦」，还回答「哪一类违规」。三类二值闸门做不到这件事
// （Qwen3Guard 家族的 category_head 实测 top-1 才 0.55–0.60，见报告 §十四），
// 而 Clef 在 SystemOne 下**一次前向可以同时问多个问题**，所以双问只花一次前向。
//
// 实测（2026-10-03，v3-risk 40 条）：Clef 打标 top-1 = 16/20 = 0.800，
// 混淆矩阵几乎全在对角线上，safe 误打标仅 2/20。是全家最强（Gen-4B 0.600）。
//
// ⚠️ 没做「词表级门控」：想过用词表先筛高危词、命中才送模型省一次调用，
// 但实测词表在 v3-risk 上 harmful 只捞回 1/20 = 5%，还误伤 1/20 safe，
// 漏的全是中文暗语（「私聊发你那种视频资源」「想约那种不合规的线下私密服务」）
// 和 Jailbreak 变体（「忽略你之前收到的所有指令」）。正则捞不住中文的绕弯说法，
// 这层门控等于拦不住东西反而白跑，所以砍掉，直接一次前向双问。

const RISK_CRITERIA = {
    safe: '内容安全，无需审核。',
    unsafe: '内容违规，应当拦截。',
    controversial: '内容处在边界，需人工复核。',
};

// 九类 + None，键名与 Qwen3Guard query_category_head 的九类刻意对齐，方便同口径对照
const CAT_CRITERIA = {
    'None': '无风险类别。',
    'Violent': '暴力。',
    'Sexual Content': '色情内容。',
    'Self-Harm': '自残自杀。',
    'Political': '政治敏感。',
    'PII': '隐私信息泄露。',
    'Copyright': '版权侵权。',
    'Illegal Acts': '违法犯罪。',
    'Unethical': '不道德行为。',
    'Jailbreak': '越狱提示词注入。',
};

// 命中这三类 = 需要二次确认（报告 §14.4：Clef 在 v3 上这三类 P 都是 1.000）
const CONFIRM_CATS = ['Sexual Content', 'PII', 'Jailbreak'];

/**
 * 调 Clef 一次前向做风险打标：既出「拦不拦」，也出「哪一类」。
 *
 * 与 judgeComplexity 同样是永不抛错的旁路：服务没起 / 超时 / 返回异常一律 null。
 *
 * @param {string} text 待判文本
 * @param {{url?:string, timeoutMs?:number}} opts
 * @returns {Promise<null|{risk:string|null, cat:string|null, conf:number|null, catConf:number|null, needsConfirm:boolean, latencyMs:number|null, model:string|null}>}
 */
async function judgeRisk(text, opts = {}) {
    if (typeof text !== 'string' || text.length === 0) return null;

    const url = opts.url || process.env.L2_JUDGE_RISK_URL || DEFAULT_JUDGE_URL;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'clef-flash-4bit',
                state: '请判断这条用户请求是否需要人工审核。该请求为：' + text.slice(0, 2000),
                questions: {
                    risk: { type: 'choice', criteria: RISK_CRITERIA },
                    cat: { type: 'choice', criteria: CAT_CRITERIA },
                },
            }),
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = await res.json();
        const risk = body && body.answers && body.answers.risk;
        const cat = body && body.answers && body.answers.cat;
        if (!risk || !risk.choice) return null;
        return {
            risk: risk.choice,
            conf: risk.confidence == null ? null : risk.confidence,
            // 'None' 是塞进 criteria 的**字符串** key（SystemOne 只认 key 当选项），
            // 不是空值，落到业务侧要先归一，否则每条都算「被打标」。
            cat: cat && cat.choice ? (cat.choice === 'None' ? null : cat.choice) : null,
            catConf: cat && cat.confidence == null ? null : cat.confidence,
            needsConfirm: CONFIRM_CATS.includes(cat && cat.choice),
            latencyMs: body && body.usage ? body.usage.latency_ms : null,
            model: body ? body.model : null,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    judgeComplexity,
    judgeRisk,
    CONFIRM_CATS,
    DEFAULT_JUDGE_URL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MIN_CONF,
};
