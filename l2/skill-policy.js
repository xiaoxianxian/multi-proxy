'use strict';

// skill → token-policy 的控制面桥：把「上下文资产账本」接进注入决策，让它**能按 cost 否决**。
//
// 要解决的问题：l2/skill-hosts.js 的 scanLedger 量出了「宿主里躺着 144 条 skill、约 359k tokens」，
// 但那只是**看得见**。这里把它接上 token-policy 的 onRequestAssemble，变成**算得清也挡得住**。
//
// 三条设计决策（都是权衡，写下来免得后人误读）：
//   ① **不改 token-policy 内核**。它的 p.cost 是注册时静态算死的（token-policy.js:107），
//      天生不适合「每次请求动态选几条」。所以让 handler 自己吃 ctx.skillBudget 做贪心，
//      把被否决的部分以 netTokenDelta（负 = 净省）上报 —— 现有 estSaved 累加器就能记账，零 diff。
//      ⚠️ 由此带出一条使用约束：本 policy 的 cost 是「注入上限」而非「全量总和」（默认 12000），
//      **token-policy 的 budget.maxInjectTokens 必须 ≥ 它**，否则会被 §3.5 贪心判成 skipped
//      （handler 仍会跑，但结果里 applied=false，别误读成「没生效」）。见 demo。
//   ② **否决 ≠ 删文件**。落点是 proxy 侧的注入决策 + 记账 + 可观测，绝不碰 agent 目录
//      （非侵入④铁律；而且 skill 是 agent 自己按目录加载的，proxy 删了它下一轮也读不到）。
//      要真把 skill 关掉，走 skill-hosts.setEnabled() 并显式传 home|project。
//   ③ **policy 默认 enabled:false**（pack 默认关铁律 §3.4），要生效必须显式开。
//
// 诚实边界：estTokens 是估算口径（token-policy.estimateTokens：中文 3 字 ≈ 1 token），
// 不是 tokenizer 也不是上游 provider usage —— 拿它做硬阈值判断要留余量。

const SK = require('./skill-hosts.js');

// 默认注入预算：按本机实测定的保守值（单条最大 28,547 tok / 144 条合计 ~359k）。
// 用 ctx.skillBudget 覆盖（请求级），传了就以 ctx 为准。
const DEFAULT_BUDGET = 12000;

// 账本 → 候选条目（纯数据变换，不读盘）
// 三种条目进不了预算：disabled（`.disabled` 后缀 = 用户已手动关）、estTokens=null（量不了，绝不按 0 算）、
// 宿主/类型被显式过滤。
function candidates(ledger, opts = {}) {
    const entries = (ledger && ledger.entries) || [];
    return entries.filter((s) => {
        if (s.estTokens == null) { return false; }              // 量不了 → 不参与决策，不是 0
        if (opts.excludeDisabled !== false && s.disabled) { return false; }
        if (opts.host && s.host !== opts.host) { return false; }
        if (opts.kind && s.kind !== opts.kind) { return false; }
        return true;
    });
}

// 预算分配（纯函数，好测）：按 cost DESC 贪心，塞不下的显式 excluded。
// 形状跟 token-policy 的 §3.5 贪心对齐，但这里是「本次请求能装几条」，粒度更细。
function planSkillBudget(cands, opts = {}) {
    const raw = opts.budget != null ? opts.budget : DEFAULT_BUDGET;
    const cap = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET;
    const sorted = [...cands].sort((a, b) => (b.estTokens || 0) - (a.estTokens || 0));
    const injected = [], excluded = [];
    let used = 0;
    for (const s of sorted) {
        if (used + s.estTokens <= cap) { used += s.estTokens; injected.push(s); }
        else { excluded.push(s); }
    }
    return {
        budget: cap,
        injected,
        excluded,
        injectedTokens: used,
        excludedTokens: excluded.reduce((n, s) => n + s.estTokens, 0),
        injectedCount: injected.length,
        excludedCount: excluded.length,
        netTokenDelta: -excluded.reduce((n, s) => n + s.estTokens, 0),
    };
}

// 造一个可直接 registerPolicy / applyPack 的 token-policy policy 描述。
// ledger 在**构造时**取一次并闭包带进 handler —— 别让每次 apply 都重新扫 144 个文件。
function createSkillBudgetPolicy(opts = {}) {
    const ledger = opts.ledger || SK.scanLedger({ tokens: true, ...(opts.ledgerOpts || {}) });
    const cands = candidates(ledger, opts);
    const agentType = opts.agentType || 'coding';
    const cost = Number.isFinite(opts.cost) ? opts.cost : DEFAULT_BUDGET;
    const handler = (ctx = {}, io = {}) => {
        // 请求级预算优先；不传就取「token-policy 的总上限」与「本 policy 的注入上限」中更小的那个
        const capIo = io && io.budget && Number.isFinite(io.budget.max) ? io.budget.max : DEFAULT_BUDGET;
        const raw = ctx.skillBudget != null ? ctx.skillBudget : Math.min(capIo, cost);
        const plan = planSkillBudget(cands, { budget: raw });
        return {
            ...plan,
            agentType: ctx.agentType || agentType,
            scope: (ledger.entries && ledger.entries[0] && ledger.entries[0].scope) || 'global',
            // 负 = 净省。token-policy 的 estSaved 直接累加这个值 —— 不装能省的那部分就记在这。
            netTokenDelta: -plan.excludedTokens,
            note: plan.excludedCount ? `excluded ${plan.excludedCount} skill(s)` : 'all-fits',
        };
    };
    return {
        hook: 'onRequestAssemble',
        name: opts.name || `[skill-budget]${opts.host || 'all'}`,
        appliesTo: Array.isArray(opts.appliesTo) ? opts.appliesTo : [agentType],
        enabled: opts.enabled === true,                          // 默认关（§3.4 pack 默认关铁律）
        priority: Number.isFinite(opts.priority) ? opts.priority : 50,
        handler,
        cost,                                                    // 注入上限，不是全量总和（见 ①）
        // ⚠️ 字段对齐：token-policy.registerPolicy 走 estimateHandlerCost，只认 payload / tokens，
        // **不认 cost**。少写 tokens 会被静默算成 cost=0（policy 变「不花钱」直接放行），
        // 而 handler 照跑、budget 照样裁 —— 极难发现。必须双写 tokens。
        tokens: cost,
    };
}

// dry-run：不建 policy、不跑 apply，直接回答「给 X 预算会关掉哪几条」。给 CLI / REST / 文档用。
function explainSkillBudget(opts = {}) {
    const ledger = opts.ledger || SK.scanLedger({ tokens: true, ...(opts.ledgerOpts || {}) });
    const cands = candidates(ledger, opts);
    const plan = planSkillBudget(cands, opts);
    const shape = (s) => ({
        host: s.host, name: s.name, kind: s.kind, category: s.category || null,
        estTokens: s.estTokens, disabled: !!s.disabled,
        scope: s.scope || 'global',      // 项目级还是全局 —— 混着看最容易误判
    });
    return {
        budget: plan.budget,
        candidates: cands.length,
        candidatesTokens: cands.reduce((n, s) => n + s.estTokens, 0),
        injected: plan.injected.map(shape),
        excluded: plan.excluded.map(shape),
        injectedTokens: plan.injectedTokens,
        excludedTokens: plan.excludedTokens,
        injectedCount: plan.injectedCount,
        excludedCount: plan.excludedCount,
        netTokenDelta: -plan.excludedTokens,
        at: new Date().toISOString(),
    };
}

module.exports = {
    DEFAULT_BUDGET,
    candidates,
    planSkillBudget,
    createSkillBudgetPolicy,
    explainSkillBudget,
    SK,
};
