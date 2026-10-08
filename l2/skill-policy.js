// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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
//      要真把 skill 关掉，走 skill-hosts.setEnabled() / setConfigDisabled()，且必须显式传 home|project。
//      ⚠️ 2026-10-01 逐宿主验证：`.disabled` 后缀**对 hermes 无效**（hermes 认 config.yaml 的
//      skills.disabled，按 skill 名生效，见 l2/skill-hosts.js 的 DISABLE_MECHANISM），
//      所以落盘通道按机制分组，别一刀切后缀。
//   ③ **policy 默认 enabled:false**（pack 默认关铁律 §3.4），要生效必须显式开。
//
// 诚实边界：estTokens 是**估算**口径（token-policy.estimateTokens：CJK 1.04 token/字 + 其余 0.255/字符，
// 2026-10-01 用本机 129 份真实 SKILL.md 对 o200k 校准，见 tools/token-estimate-calibrate.js），
// 不是 tokenizer 也不是上游 provider usage —— 拿它做硬阈值判断要留余量。

const SK = require('./skill-hosts.js');

// 默认注入预算：按本机实测定的保守值。
// 2026-10-01 复核（口径：l2/token-policy.estimateTokens 校准后 = CJK 1.04 token/字 + 其余 0.255/字符，
// 语料 129 份真实 SKILL.md，真值对照 logs/token-estimate-calibration.json）：
//   候选 129 条 / 合计 390,976 tok（旧口径 358,898，差 9.0%），最贵单条 25,346
//   预算 12000 → 装 2 条（7,684 + 4,132），否决 127 条 / 379,160
//   预算  6000 → 装 1 条（5,698）；预算 25000 → 装 3 条（24,962）
// 「装 2 条」是刻意的：skill 是每次请求都跟着走的常驻开销，装太多等于把上下文租金付给插件。
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

// ---- veto：把「被预算否决」真正落到磁盘 ----
//
// 前面的 handler 只做**注入侧记帐**（否决 = 这次请求不注入，磁盘纹丝不动）。
// 但用户真问过一句：「否决到底算不算生效？」—— 如果宿主照样加载那条 skill，下一轮它又回来了。
// 所以这里补上「真关停」：给 skill 目录打 `.disabled` 后缀（skill-hosts 的既有约定）。
//
// ⚠️ 非侵入铁律在这条路径上一次都没松口：
//   ① 必须显式传 home 或 project，**绝不默认 home**（setEnabled 自己就会抛错）；
//   ② 默认 **dry-run**（apply 不传 = 只算不写），想动手得显式 apply:true；
//   ③ 有批量上限 maxDisable（默认 10），防止「预算位一个数字错，本机 127 条 skill 全瞎」；
//   ④ 逐个 try/catch，单条失败不回滚也不中断，如实回报 failed；
//   ⑤ REST 面不上这个动作（routes/skill-hosts.js 只留只读端点），只走代码 / CLI。
function disableExcluded(opts = {}) {
    // ⚠️ 作用域必须往账本里传：不传 project/home 的话 scanLedger 会去扫**本机全账本**，
    // 那 apply 就会拿「~/.hermes 里最贵的那几条」当目标去动磁盘 —— 正是非侵入铁律要防的事。
    const scanOpts = { tokens: true, ...(opts.ledgerOpts || {}) };
    if (opts.project) { scanOpts.project = opts.project; }
    if (opts.home) { scanOpts.home = opts.home; }
    const ledger = opts.ledger || SK.scanLedger(scanOpts);
    const cands = candidates(ledger, opts);
    const plan = planSkillBudget(cands, opts);
    const targets = opts.excluded || plan.excluded;         // 允许外部指定要动谁（默认就是被否决的那批）
    const apply = opts.apply === true;
    const maxDisable = Number.isFinite(opts.maxDisable) ? opts.maxDisable : 10;
    if (!opts.home && !opts.project) {
        throw new Error('disableExcluded: must pass explicit {home} or {project} (never defaults to home)');
    }
    const apply2 = maxDisable > 0 && targets.length > maxDisable ? maxDisable : targets.length;
    const list = targets.slice(0, apply2);                   // 只动前 maxDisable 个（cost DESC 已排序）
    const applied = [], failed = [], skipped = [];
    // 账本里真实存在的条目（key 与 scanLedger 一致）；原生通道写配置不看磁盘，
    // 少了这道校验就会把「幽灵条目」静默写进 skills.disabled，用户以为被关了其实根本不存在。
    const known = new Set(ledger.entries.map((e) => `${e.host}/${e.category || ''}/${String(e.name).replace(new RegExp(SK.DISABLE_SUFFIX + '$'), '')}`));
    const byMechanism = { suffix: [], 'native-config': [] };   // 按宿主真禁用机制分组，别一处后缀一处配置各写各的
    for (const s of list) {
        if (s.disabled) { skipped.push({ name: s.name, reason: 'already-disabled' }); continue; }
        const name = String(s.name || '').replace(new RegExp(SK.DISABLE_SUFFIX + '$'), '');
        if (!name) { skipped.push({ name: s.name, reason: 'empty-name' }); continue; }
        if (!apply) { skipped.push({ name, reason: 'dry-run' }); continue; }
        const mech = SK.disableMechanismOf(s.host).strategy || 'suffix';
        if (!known.has(`${s.host}/${s.category || ''}/${name}`)) {
            failed.push({ host: s.host, name, reason: 'not-found' });
            continue;
        }
        byMechanism[mech] = byMechanism[mech] || [];
        byMechanism[mech].push({ name, category: s.category || null, host: s.host, estTokens: s.estTokens });
    }
    for (const [mech, group] of Object.entries(byMechanism)) {
        if (!group.length) { continue; }
        if (mech === 'native-config') {
            if (!apply) { for (const g of group) { skipped.push({ name: g.name, reason: 'dry-run' }); } continue; }
            try {
                const r = SK.setConfigDisabled(group[0].host, group.map((g) => g.name),
                    { home: opts.home, project: opts.project, enabled: false, apply });
                if (r && r.ok) {
                    for (const g of group) {
                        applied.push({ host: g.host, name: g.name, mechanism: 'native-config',
                            config: r.config, backup: r.backup, estTokens: g.estTokens });
                    }
                } else {
                    for (const g of group) { failed.push({ host: g.host, name: g.name, reason: (r && r.reason) || 'config-failed' }); }
                }
            } catch (e) {
                for (const g of group) { failed.push({ host: g.host, name: g.name, reason: e.message }); }
            }
            continue;
        }
        for (const g of group) {
            try {
                const r = SK.setEnabled(g.host, g.name, false,
                    { home: opts.home, project: opts.project, category: g.category });
                if (r && r.ok) { applied.push({ host: g.host, name: g.name, to: r.to, strategy: r.strategy, estTokens: g.estTokens }); }
                else { failed.push({ host: g.host, name: g.name, reason: (r && r.reason) || 'not-found' }); }
            } catch (e) {
                failed.push({ host: g.host, name: g.name, reason: e.message });
            }
        }
    }
    return {
        apply, dryRun: !apply,
        budget: plan.budget,
        // 注意：excludedCount 是「否决了几条」（全量口径），wouldDisable 是「真动手动了几个」（已受 maxDisable 截断）
        excludedCount: plan.excludedCount,
        excludedTokens: plan.excludedTokens,
        wouldDisable: list.length,
        maxDisable,
        actionDisabled: apply2 < targets.length,             // true = 因为撞上批量上限没动完
        applied, failed, skipped,
        mechanism: { suffix: (byMechanism.suffix || []).length, 'native-config': (byMechanism['native-config'] || []).length },
    };
}

module.exports = {
    DEFAULT_BUDGET,
    candidates,
    planSkillBudget,
    createSkillBudgetPolicy,
    explainSkillBudget,
    disableExcluded,
    SK,
};
