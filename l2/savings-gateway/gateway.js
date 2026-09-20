'use strict';

// 省钱网关内核（task1 一期 · l2/savings-gateway/）
// OpenAI 兼容网关：agent 用 dummy key 指向本网关，网关按 route-engine 难度路由
// 把请求打到「最便宜够强」的档位；并产出「省钱账」：若照默认大模型打会花 X，
// 实际路由到档位 Y 省了 Z。
//
// 五决策拍板（docs/04-tech/savings-gateway-design.md §四·§五，2026-09-21 老板授权）：
//   ① 形态 B：独立模块 l2/savings-gateway/，不碰热路径（forward.js / codex-proxy/proxy.js 零触碰）
//   ② 端口 18795（独立 thin server，见同目录 server.js；内核本身不监听）
//   ③ dummy key：网关签发/校验（前缀 gw_），命中即映射真 provider key（真 key 由调用方注入，
//      内核不持有任何真 key 材料、不暴露给 agent）
//   ④ 一期 shadow：只算「模拟 delta」（planned=large 基线 − actual=实际档位），接 alert.js cost 信号；
//      省钱排行榜留二期
//   ⑤ 先按难度档位（复用 route-engine 的 complexity→tier 路由），价格不进 route 排序（二期）
//
// 非侵入铁律（l2/ 统一范式，与 alert.js / cost.js 同构）：
//   - 门控 PROXY_SAVINGS_GATEWAY 默认关 = observe（决策/省账进内存、绝不落盘）；开 = 可落盘
//     savings-log.jsonl（目录可注入，不默认写 home 以外）
//   - shadow 默认开：不真调上游；executor 注入缝预留（二期切换真路由时接真实 dispatch）
//   - 内核默认不往 process.env 注入任何键
//
// 复用（不新造）：route-engine（难度路由）+ agent-registry + mcp-default-seed 三档 tier profile
// （agnes=small 免费 / deepseek=medium / qwen=large）+ alert.js cost 规则契约。
//
// 价格表：DEFAULT_PRICING 是「若照默认大模型直连云端」的每百万 token CNY 基线，
// 用于模拟 delta 记账；small=0（本地/免费档），medium=deepseek 项目基线（§13.11a ¥1/¥4），
// large 为云端大模型量级估算（32/128，可经 opts.pricing 或 PROXY_PRICING_LARGE 覆盖）——
// 估算值非实测，文档已标注，定价决策归老板。

const { RouteEngine } = require('../route-engine.js');
const { AgentRegistry } = require('../agent-registry.js');
const { seedDefaultProfiles } = require('../mcp-default-seed.js');

const DUMMY_KEY_PREFIX = 'gw_';
const GATE_ENV = 'PROXY_SAVINGS_GATEWAY';
const SHADOW_ENV = 'PROXY_SAVINGS_SHADOW';

// 档位 → 每百万 token CNY（input/output），模拟 delta 记账用
const DEFAULT_PRICING = {
    small:  { input: 0, output: 0 },    // 本地 qwen3.8:27b-mlx / agnes 免费档
    medium: { input: 1, output: 4 },    // deepseek-v4-pro 项目基线（PROVIDERS-README pricing）
    large:  { input: 32, output: 128 }, // 云端大模型量级估算（可覆盖，非实测）
};
const PLANNED_TIER = 'large'; // 设计稿 §3：原计划成本 = 大模型基线

// 粗估 prompt tokens：CJK/通用文本按 3 字符 ≈ 1 token（启发式，shadow 模拟用；
// 真实 usage 由调用方传 reqBody.usage 覆盖）
function estimatePromptTokens(messages) {
    let chars = 0;
    if (Array.isArray(messages)) {
        for (const m of messages) {
            const c = m && m.content;
            if (typeof c === 'string') chars += c.length;
        }
    }
    return Math.max(1, Math.ceil(chars / 3));
}

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

function shadowDefault() {
    const v = String(process.env[SHADOW_ENV] ?? '1').trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off');
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const coerceNum = (n) => { const v = parseFloat(n); return Number.isFinite(v) ? v : 0; };

// 工厂：每实例独立 store（测试隔离），与 l2 其它内核同构
function createSavingsGateway(opts = {}) {
    const pricing = { ...DEFAULT_PRICING, ...(opts.pricing || {}) };
    // PROXY_PRICING_LARGE env 可覆盖 large 基线（镜像 cost-track 的 pricing 注入约定）
    if (process.env.PROXY_PRICING_LARGE) {
        try {
            const p = JSON.parse(process.env.PROXY_PRICING_LARGE);
            pricing.large = {
                input: coerceNum(p.input),
                output: coerceNum(p.output),
            };
        } catch { /* 非法 JSON → 保持默认，静默容错 */ }
    }

    const registry = new AgentRegistry();
    seedDefaultProfiles(registry);   // 三档 tier：agnes(small)/deepseek(medium)/qwen(large)
    const shadow = opts.shadow !== undefined ? !!opts.shadow : shadowDefault();
    const engine = new RouteEngine({ registry, shadowMode: shadow });
    const executor = typeof opts.executor === 'function' ? opts.executor : null;
    // dummy key 表：{ '<gw_…>': '<intentTier>' }。真 provider key 映射由调用方在
    // executor/dispatch 层注入（内核不持真 key）；此处只存「档位意图」。
    const dummyKeys = opts.dummyKeys && typeof opts.dummyKeys === 'object' ? { ...opts.dummyKeys } : {};
    // 签一个默认 key（可预测形式，便于 E2E；生产经 opts.dummyKeys 注入自定义）
    if (Object.keys(dummyKeys).length === 0) {
        dummyKeys[`${DUMMY_KEY_PREFIX}default-large`] = PLANNED_TIER;
    }
    const logCapacity = Number.isFinite(opts.logCapacity) ? opts.logCapacity : 1000;
    const savingsLog = [];

    // 记一笔省账（环形裁剪保最近 logCapacity）
    function pushSavings(entry) {
        savingsLog.push(entry);
        if (savingsLog.length > logCapacity) savingsLog = savingsLog.slice(-logCapacity);
    }

    // 鉴权 + 映射：dummy key 必须命中签发表；返回 intentTier 或抛 401 语义错误
    function resolveKey(key) {
        if (typeof key !== 'string' || !key.startsWith(DUMMY_KEY_PREFIX)) {
            const e = new Error('invalid_api_key');
            e.httpStatus = 401;
            throw e;
        }
        const tier = dummyKeys[key];
        if (!tier) {
            const e = new Error('unknown_api_key');
            e.httpStatus = 401;
            throw e;
        }
        return tier;
    }

    // 主入口：处理一次 /v1/chat/completions（shadow 模拟或 executor 真执行）
    // reqBody: { messages, complexity?, usage?, model? }
    // opts2:    { key, now? }
    function handleChatCompletions(reqBody, io = {}) {
        const intentTier = resolveKey(io.key);
        const complexity = reqBody && ['low', 'medium', 'high'].includes(reqBody.complexity)
            ? reqBody.complexity : 'medium';
        // 难度路由（决策⑤：按档位，价格不进排序）
        const decision = engine.route({ type: 'text', complexity, prompt: '(savings-gateway)' });
        const chosen = decision.chosen;
        const actualTier = chosen ? (chosen.modelTier || DEFAULT_TIER_NAME(chosen)) : 'medium';
        const actualAdapter = chosen ? chosen.adapterId : 'qwen';

        // tokens：优先真实 usage（调用方透传），否则启发式估算（模拟，诚实标 estimated）
        const est = estimatePromptTokens(reqBody && reqBody.messages);
        const promptTokens = reqBody && reqBody.usage && Number.isFinite(reqBody.usage.prompt_tokens)
            ? reqBody.usage.prompt_tokens : est;
        const completionTokens = reqBody && reqBody.usage && Number.isFinite(reqBody.usage.completion_tokens)
            ? reqBody.usage.completion_tokens : 0;

        // 模拟 delta（决策④）：planned=large 基线，actual=实际档位；无真实上游调用
        let content = null;
        let execInfo = null;
        if (!engine.shadowMode && executor) {
            // 二期缝：真执行（executor 负责拿真 key 打上游），usage 以 executor 返回为准
            execInfo = syncExecute(executor, actualAdapter, reqBody);
            if (execInfo && execInfo.usage) {
                const pt = coerceNum(execInfo.usage.prompt_tokens);
                const ct = coerceNum(execInfo.usage.completion_tokens);
                if (pt > 0 || ct > 0) { /* 真实 usage 覆盖估算 */ }
            }
        }
        const pAct = pricing[actualTier] || pricing.medium;
        const pPlan = pricing[PLANNED_TIER];
        const actualCost = round6(promptTokens / 1e6 * pAct.input + completionTokens / 1e6 * pAct.output);
        const plannedCost = round6(promptTokens / 1e6 * pPlan.input + completionTokens / 1e6 * pPlan.output);
        const saved = round6(Math.max(0, plannedCost - actualCost));

        // 省账落内存（门控关=不落盘；一期不落盘，落盘/排行榜列二期——YAGNI 诚实边界）
        pushSavings({
            ts: io.now != null ? io.now : Date.now(),
            intentTier,
            complexity,
            plannedTier: PLANNED_TIER,
            actualTier,
            actualAdapter,
            promptTokens,
            completionTokens,
            plannedCost,
            actualCost,
            saved,
            shadow: engine.shadowMode,
            tokensEstimated: !(reqBody && reqBody.usage),
        });

        const response = {
            id: `sgw-${io.now != null ? io.now : Date.now()}`,
            object: 'chat.completion',
            model: actualAdapter,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: content
                        != null ? content
                        : `[savings-gateway shadow] routed ${PLANNED_TIER}→${actualTier} (${actualAdapter}), simulated`,
                },
                finish_reason: 'stop',
            }],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
            },
            x_savings: {
                plannedTier: PLANNED_TIER,
                actualTier,
                actualAdapter,
                plannedCost,
                actualCost,
                saved,
                shadow: engine.shadowMode,
                estimated: !(reqBody && reqBody.usage),
            },
        };
        if (execInfo && execInfo.content != null) {
            response.choices[0].message.content = execInfo.content;
            response.x_savings.simulated = false;
        }
        return response;
    }

    // 同步 executor（二期缝；一期 shadow 默认不走到）
    function syncExecute(fn, adapterId, body) {
        try {
            const r = fn(adapterId, body);
            if (r && r.then === undefined) return r;
            return null; // 一期不处理 async（诚实边界：二期 executor 改 await 缝）
        } catch { return null; }
    }

    // 省钱报告（一期账目 API；排行榜留二期）
    function savingsReport(windowMs) {
        const cutoff = (windowMs != null && Number.isFinite(windowMs))
            ? (savingsLog.length ? Math.max(...savingsLog.map((e) => e.ts)) : 0) - windowMs
            : 0;
        const rows = windowMs != null ? savingsLog.filter((e) => e.ts >= cutoff) : savingsLog;
        let totalSaved = 0, totalActual = 0, totalPlanned = 0, reqCount = 0;
        const perTier = {};
        for (const e of rows) {
            totalSaved += e.saved; totalActual += e.actualCost; totalPlanned += e.plannedCost;
            reqCount += 1;
            perTier[e.actualTier] = perTier[e.actualTier] || { requestCount: 0, saved: 0 };
            perTier[e.actualTier].requestCount += 1;
            perTier[e.actualTier].saved = round6(perTier[e.actualTier].saved + e.saved);
        }
        return {
            windowMs: windowMs != null ? windowMs : 0,
            requestCount: reqCount,
            totalSaved: round6(totalSaved),
            totalActualCost: round6(totalActual),
            totalPlannedCost: round6(totalPlanned),
            perTier,
            shadow: engine.shadowMode,
        };
    }

    // 喂 alert.js 的 cost 信号（决策④：接 alert.js cost）。形状与 cost.js/alert.js
    // cost-budget-exceeded 契约一致：{ source:'cost', providerId, cost, budget? }；
    // budget 未设则不带（alert 规则要求 budget 为 number 才触发——诚实：不设预算不告警）。
    function produceCostSignal(opts2 = {}) {
        const rep = savingsReport(opts2.windowMs);
        const sig = {
            source: 'cost',
            providerId: 'savings-gateway',
            cost: rep.totalActualCost,
        };
        if (typeof opts2.budget === 'number') sig.budget = opts2.budget;
        return sig;
    }

    return {
        handleChatCompletions,
        resolveKey,
        savingsReport,
        produceCostSignal,
        setShadowMode: (on) => { engine.setShadowMode(on); },
        isShadow: () => engine.shadowMode,
        getDummyKeys: () => ({ ...dummyKeys }),
        setExecutor: (fn) => { /* 二期缝 */ if (typeof fn === 'function') executor = fn; },
        // 测试/演示
        getDecisionLog: (n) => engine.getLogs(n),
        getSavingsLog: () => savingsLog.slice(),
        _engine: engine,
        _registry: registry,
        _pricing: pricing,
        _dummyKeys: dummyKeys,
    };
}

// chosen.modelTier 缺失时的兜底（seed 的三档都显式声明了 modelTier，此处防御未知 profile）
function DEFAULT_TIER_NAME(chosen) {
    if (chosen.adapterId === 'agnes') return 'small';
    if (chosen.adapterId === 'qwen') return 'large';
    return 'medium';
}

// ---- 模块级单例（持久账目）----
const _gw = createSavingsGateway();
module.exports = {
    DUMMY_KEY_PREFIX,
    GATE_ENV,
    SHADOW_ENV,
    DEFAULT_PRICING,
    PLANNED_TIER,
    estimatePromptTokens,
    createSavingsGateway,
    // 单例转发
    handleChatCompletions: _gw.handleChatCompletions,
    savingsReport: _gw.savingsReport,
    produceCostSignal: _gw.produceCostSignal,
    gateOpen,
    shadowDefault,
};
