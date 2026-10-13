// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// Route Engine — L2 编排引擎核心（P1 增量 1）
// 职责：按能力标签 + 模型类型 + 模型档位路由任务到候选 adapter，支持 shadow 模式。
//
// 设计原则（与 Agent Registry + Plugin Runtime 同构）：
//    - 非侵入④：只读 Registry + Plugin Runtime，不修改 agent 任何文件。
//    - Shadow 模式先行：默认不执行真实任务，只记录路由决策日志。
//    - 可注入：registry/pluginRuntime 可注入，便于测试。
//    - 模型类型优先：multimodal 任务优先匹配 multimodal 代理（避免文本代理误接图像任务）。
//    - 复杂度档位（complexity→modelTier）：按任务难度选最合适的模型档位。
//      decomposer 已在子任务打上 complexity（low/medium/high），route() 消费它映射到
//      档位（small/medium/large）。见 l2/COMPLEXITY-MODE.md。
//      关键：tierMatch 只对**显式声明了 modelTier** 的 profile 生效——
//      未设 modelTier 的 profile 不参与档位加分，行为完全不变（向后兼容旧 profile）。

const { MODEL_TIERS, DEFAULT_TIER } = require('./agent-registry');
// 共享底座（质量工程 §三）：complexity→tier 映射 / 无候选兜底策略的唯一事实源。
const { mapTier, resolveNoCandidatePolicy } = require('./knowledge-base/routing-base.js');
// 语义审阅层（质量工程 2.2）：route() 决策是否真能接这活（默认关，零行为变更）。
const { reviewRouteDecision, assertSemantic } = require('./semantic-review.js');
// LLM judge 复判（二期口子落地，2026-10-03）：Clef SystemOne 复判复杂度档位（默认关，只观测不改档）。
const {
    judgeComplexity,
    judgeRisk,
    DEFAULT_TIMEOUT_MS: DEFAULT_JUDGE_TIMEOUT,
} = require('./decision-judge.js');
// shadow 日志算钱（route-engine-spec.md:90）：复用 cost.js 的 token→钱 口径（CNY / 百万 token），
// 不另立一套价目算法——价目表仍由调用方注入，缺价返回 null（cost.js 同款「不拿 0 冒充」纪律）。
const { tokenCost } = require('./cost.js');

// §4/§5 交接触发器契约 + 循环熔断（agent-infra/handoff-contract.md）。
// 默认 null = 不观测（零行为变更铁律：不注入就不改任何现有行为）。
// 注入 HandoffGuard 后 route() 只在 decision.handoff 写观测结果，**不改档位、不自动切**
// ——切模型的所有权归调用方，route 仍遵守 N3「纯决策、绝不自动执行」。

const DEFAULT_LOG_CAPACITY = 100;

// log_redaction 三档：默认 'full' = 现状（taskPrompt 截前 50 字，不改变行为）。
// 'metadata_only' = 日志不记任务正文（仅元数据长度，供审计不含内容）；'off' = 完全不记 taskPrompt。
// 门控默认 full：符合「门控默认关 / 不改变现有行为」非侵入铁律——脱敏是可选增强，默认零变化。
const DEFAULT_LOG_REDACTION = 'full';

// 本期两项缺口的门控（默认关 = 与今天逐字节一致）。
//   PROXY_ROUTE_HARD_RULES  → force_provider / exclude_providers 硬规则覆盖（spec:87 / ADR-0005:28-29）
//   PROXY_ROUTE_SHADOW_COST → shadow 日志算「可省 ¥X」（spec:90）
// 读法与 routing-base / cost.js 同款：'1' | 'true' | 'on' 开，其余（含不设）关。
function envOn(name) {
    const v = String(process.env[name] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

class RouteEngine {
    constructor({ registry, pluginRuntime, shadowMode = true, logCapacity = DEFAULT_LOG_CAPACITY, executor = null, semanticReview = false, semanticThrow = false, noCandidateStrategy = null, llmJudge = false, riskGate = false,
        riskTimeoutMs = DEFAULT_JUDGE_TIMEOUT, handoffGuard = null,
        hardRules = null, shadowCost = null, pricing = null } = {}) {
        this.registry = registry;
        this.pluginRuntime = pluginRuntime || { listCapabilities: () => [] };
        this.shadowMode = shadowMode;
        this.log = []; // 路由决策日志，最多 logCapacity 条
        this.logCapacity = logCapacity;
        this.semanticReview = semanticReview; // 质量工程 2.2：决策语义审阅（默认关）
        this.semanticThrow = semanticThrow;   // 默认关：打开则 error 级语义问题硬拒
        // log_redaction：控制 decision.taskPrompt 脱敏。默认 'full'（现状不变），见上方注释。
        this.logRedaction = DEFAULT_LOG_REDACTION;
        // L2 P3 真执行器注入：(adapterId, task, ctx, runOpts) => Promise<value>。
        // 默认 null = 保持 stub（status:'queued'），零行为变更。
        this.executor = executor;
        // 无候选兜底策略（质量工程 §四 待办②）：null = 走 env/底座默认值。
        this.noCandidateStrategy = noCandidateStrategy;
        // LLM judge 复判（二期口子）：默认关，零行为变更。
        // 开启后只把复判结果写进 decision.judge 供观测，**不改档位**——
        // complexity 定价权归 Portico（Portico/02-架构设计.md 条款 5）。
        this.llmJudge = llmJudge;
        // 风险打标旁路（l2/decision-judge.js 的 judgeRisk）：一次前向同时出
        // 「拦不拦」和「哪一类」，与复杂度 judge 是两个独立开关——
        // 路由要观测档位，打标要观测类别，开一个是另一半人不需要的开销。
        this.riskGate = riskGate;
        // 打标超时默认沿用热路径的 1500ms；批处理/测试要放宽（serve idle 后冷启 8-12s，
        // 撞上绝对被掐成 null，看着像模型废了其实是超时）。
        this.riskTimeoutMs = riskTimeoutMs;
        this._judgeCalls = new Set(); // 未落地的 judge promise，供 awaitJudges() 收口
        // 风险旁路单独一份：二次确认（Portico 侧动作）只关心「哪一类、要不要复核」，
        // 不该被 complexity judge 拖着一起等——两条旁路的收口粒度不同，分开存。
        this._riskCalls = new Set();
        // §4/§5 交接触发器契约 + 循环熔断（agent-infra/handoff-contract.md）。
        // 默认 null = 不观测（零行为变更）；注入 l2/handoff-reason.js 的 HandoffGuard 后，
        // route() 只在 decision.handoff 写「该不该切 / 卡在乒乓还是预算」的观测，
        // **不改档位、不自动切**——切模型所有权归调用方（N3 纯决策铁律不破）。
        this.handoffGuard = handoffGuard;
        // 硬规则覆盖（spec:87 / ADR-0005:28-29 / security-whitepaper.md:62）：
        // 调用方可用 force_provider / exclude_providers 压过引擎建议。默认关（env 或显式开）→ 零行为变更。
        this.hardRules = hardRules == null ? envOn('PROXY_ROUTE_HARD_RULES') : !!hardRules;
        // shadow 日志算钱（spec:90）：默认关 → 只记建议、不算钱（现状不变）。
        this.shadowCost = shadowCost == null ? envOn('PROXY_ROUTE_SHADOW_COST') : !!shadowCost;
        // 价目表：{ [adapterId]: { input, output } }（CNY / 百万 token，与 cost.js tokenCost 同口径），
        // 由调用方注入。引擎**不内置**任何价格——内置就是编数，缺价一律记 null。
        this.pricing = pricing;
      }

     // 按任务类型路由：返回候选 adapter 列表 + 路由决策日志
    route(task) {
        if (!task || !task.type) throw new Error('task.type required');

        const decision = {
            timestamp: new Date().toISOString(),
            taskId: task.id || null,
            taskType: task.type,
            taskPrompt: this._redact(task.prompt), // taskPrompt 按 log_redaction 门控脱敏
            candidates: [],
            chosen: null,
            shadowMode: this.shadowMode,
            action: 'log-only', // log-only | execute
         };

         // 解析期望的模型类型（模态维度）
        const expectedModelType = task.modelType || this._inferModelType(task.type);

         // 解析期望的模型档位（复杂度维度，complexity 路由的落点）
        const expectedTier = this._mapTier(task.complexity);
        decision.expectedTier = expectedTier; // 记录期望档位，供消费者/日志/审计

        // LLM judge 异步旁路复判（默认关，l2/decision-judge.js）。
        // 结果只写进 decision.judge 供观测/统计，**不改档位**：
        // complexity 定价权归 Portico（Portico/02-架构设计.md 条款 5），这里不越权。
        // 不 await —— 旁路不能阻塞热路径；judge 不可用时返回 null，零影响。
        if (this.llmJudge && typeof task.prompt === 'string' && task.prompt.length > 0) {
            decision.judgePending = true; // 同步标记：让消费者知道「在途」，不是没有
            const p = judgeComplexity(task.prompt.slice(0, 2000))
                // 无条件回填（失败为 null）：好让消费者分清「没跑」和「跑了没结果」。
                .then((j) => { decision.judge = j; })
                .catch(() => { /* 旁路失败不影响路由 */ })
                .finally(() => {
                    decision.judgePending = false;
                    this._judgeCalls.delete(p);
                });
            this._judgeCalls.add(p);
        }

        // 风险打标旁路（同样只观测、不改档位；打标结论归审核侧，不进 Portico 定价）
        // 无条件回填（失败为 null）：与 judge 一样，好让消费者分清「没跑」和「跑了没结果」。
        if (this.riskGate && typeof task.prompt === 'string' && task.prompt.length > 0) {
            decision.riskPending = true;
            const pr = judgeRisk(task.prompt.slice(0, 2000), { timeoutMs: this.riskTimeoutMs })
                .then((r) => { decision.risk = r; })
                .catch(() => { /* 旁路失败不影响路由 */ })
                .finally(() => {
                    decision.riskPending = false;
                    this._riskCalls.delete(pr);
                });
            this._riskCalls.add(pr);
        }

         // 查询 Registry 中具备该能力的 agent profile
        const allProfiles = this.registry ? this.registry.list() : [];

         // 查询 Plugin Runtime 中已启动的插件能力
        const pluginCaps = this.pluginRuntime.listCapabilities();

         // 合并候选：从 Registry 和 Plugin Runtime 中提取 adapter 信息
        const candidateMap = new Map();

        for (const profile of allProfiles) {
            if (profile.adapterId) {
                 // 精确匹配：modelType + capabilityTags + modelTier
                const modelMatch = profile.modelType === expectedModelType;
                const tagMatch = Array.isArray(profile.capabilityTags) && profile.capabilityTags.includes(task.type);
                // tierMatch：仅当 profile 显式声明了 modelTier 且匹配期望档位时为 true。
                // 未设 modelTier 的 profile 不参与档位加分（向后兼容旧 profile 行为不变）。
                const tierMatch = profile.modelTier !== undefined && profile.modelTier === expectedTier;

                if (tagMatch) {
                    candidateMap.set(profile.adapterId, {
                        adapterId: profile.adapterId,
                        source: 'registry',
                        confidence: this._calcConfidence(profile.capabilityTags, task.type, profile.modelType, expectedModelType, tierMatch),
                        modelTypeMatch: modelMatch,
                        tierMatch,
                        modelTier: profile.modelTier !== undefined ? profile.modelTier : null,
                        expectedTier,
                     });
                 }
             }
         }

        for (const cap of pluginCaps) {
            if (!candidateMap.has(cap.plugin)) {
                // plugin 无 modelTier 概念，tierMatch=false（不参与档位加分）
                candidateMap.set(cap.plugin, {
                    adapterId: cap.plugin,
                    source: 'plugin',
                    confidence: this._calcConfidence([cap.capability], task.type, null, expectedModelType, false),
                    modelTypeMatch: false,
                    tierMatch: false,
                    modelTier: null,
                    expectedTier,
                 });
             }
         }

         // 硬规则覆盖（门控 PROXY_ROUTE_HARD_RULES，默认关 → pool 就是原候选，排序/选中逐字节不变）：
         // exclude_providers 先剔除、force_provider 再在**剩余**候选里强制选中——排除优先于强制，
         // 因为「不许用」是硬约束，被排除者不该因 force 复活（规格未写两者优先级，取此最小解释）。
        let pool = [...candidateMap.values()];
        if (this.hardRules) {
            const hr = this._hardRules(task, pool);
            if (hr) { decision.hardRule = hr.rule; pool = hr.pool; }
        }

         // 排序：modelTypeMatch（真 > 假）→ tierMatch（真 > 假）→ confidence
        decision.candidates = pool.sort((a, b) => {
            if (a.modelTypeMatch !== b.modelTypeMatch) {
                return a.modelTypeMatch ? -1 : 1;
             }
            if (a.tierMatch !== b.tierMatch) {
                return a.tierMatch ? -1 : 1;
             }
            return b.confidence - a.confidence;
         });
        decision.chosen = (decision.hardRule && decision.hardRule.forced) || decision.candidates[0] || null;

        // 无候选兜底策略（质量工程 §四 待办②）：把此前隐式的「chosen=null 却照样执行」
        // 显式化、可审计、可配置。默认 observe —— 与既有行为逐字一致（零行为变更铁律）。
        if (!decision.chosen) {
            const policy = resolveNoCandidatePolicy(this.noCandidateStrategy);
            decision.noCandidate = true;                    // 诊断：本次压根选不出 adapter
            decision.noCandidatePolicy = policy.strategy;   // 本次生效策略，便于事后复盘
            decision.noCandidateReason =
                `no registered adapter claims capability "${task.type}" (tier=${expectedTier}, modelType=${expectedModelType || 'any'})`;
            if (policy.strategy === 'fallback-default') {
                // 只在 defaultAdapterId 确实注册过时兜底；没注册就保持 null（不随便挑一个充数）。
                const fb = policy.defaultAdapterId
                    ? allProfiles.find((p) => p.adapterId === policy.defaultAdapterId)
                    : null;
                if (fb) {
                    decision.chosen = {
                        adapterId: fb.adapterId,
                        source: 'policy-fallback',   // 区别于 'registry' / 'plugin'
                        confidence: 0,
                        modelTypeMatch: fb.modelType === expectedModelType,
                        tierMatch: false,
                        modelTier: fb.modelTier !== undefined ? fb.modelTier : null,
                        expectedTier,
                    };
                    decision.degraded = true;       // 明示：这是兜底，不是能力匹配的结果
                }
            } else if (policy.strategy === 'reject') {
                decision.rejected = true;           // 执行器据此硬失败，不再「无路由也执行」
            }
        }

        // 语义审阅层（质量工程 2.2）：选中的 adapter 是否真能接这活（默认关，零行为变更）。
         if (this.semanticReview) {
             const rev = reviewRouteDecision(decision, task);
             decision.semanticIssues = rev.issues;
             if (!rev.ok && this.semanticThrow) assertSemantic(rev.issues);
         }

         // L2 Step 4（N3 防双执行）：route() 纯决策——绝不自动执行。
         // 非 shadow 且选中：只把 action 标记为 'execute'（决策意图），
         // 执行彻底交调用方（_execute / runDag / orchestrate）。
         // 之前此处在非 shadow 下 fire-and-forget 调 _execute 且 0 读取
         // decision.execution，一旦注入 executor 会与调用方二次 execute → 上游双调用。
         if (!this.shadowMode && decision.chosen) {
             decision.action = 'execute';
         }

        // §4/§5 交接触发器契约观测（默认关，零行为变更）：
        // 注入 handoffGuard 时，把「本次选中的 adapter 该不该自动切 owner」写进
        // decision.handoff 供 shadow 日志 / 健康看板观测。route 只观测、不切——
        // 真正切模型由调用方拿 decision.handoff.allow 决定（N3 铁律：纯决策）。
        if (this.handoffGuard && decision.chosen) {
            const next = decision.chosen.adapterId;
            decision.handoff = this.handoffGuard.shouldHandoff(next);
        }

        // shadow 日志算钱（spec:90，门控 PROXY_ROUTE_SHADOW_COST，默认关）：
        // 影子路由记的是「建议走 A 但实际走 B」，这里顺带把两者价差算成 savings（可省 ¥X）。
        // 只在 shadow 下算——非 shadow 是已经派发过的真请求，价差不再是「可省」而是「已花」，
        // 语义不同，本期不碰（最小解释）。
        if (this.shadowCost && this.shadowMode && decision.chosen) {
            decision.shadowCost = this._shadowCost(task, decision.chosen.adapterId);
        }

        this._pushLog(decision);
        return decision;
     }

     // 批量路由：对任务列表依次路由
    batchRoute(tasks) {
        return tasks.map(task => this.route(task));
     }

     // 启用/禁用 shadow 模式
    setShadowMode(on) {
        this.shadowMode = on;
     }

     // 获取路由日志（最近 N 条）
    getLogs(limit = 20) {
        return this.log.slice(-limit);
     }

     // 清空调用
     clearLogs() {
       this.log = [];
     }

     // 设置 log_redaction 档：'full'(默认)/'metadata_only'/'off'。
     setLogRedaction(level) {
       if (['full', 'metadata_only', 'off'].includes(level)) this.logRedaction = level;
       // 未知值保持原档不变
     }

     // ---- 私有方法 ----

     // 启发式推导任务期望的模型类型（模态维度）
    _inferModelType(taskType) {
        if (['vision', 'image', 'video', 'text2video'].includes(taskType)) return 'multimodal';
        if (['audio', 'tts', 'stt'].includes(taskType)) return 'audio';
        return 'text';
     }

     // 复杂度 → 档位映射（complexity 路由，见 l2/COMPLEXITY-MODE.md §2.2）
     // 映射定义已收口到共享底座 routing-base（质量工程 §三，落点 2）：改档位只改 routing-base。
     // 本期静态（decomposer 标签）；二期 LLM judge 动态复判，接口预留于此。
    _mapTier(complexity) {
        const mapped = mapTier(complexity); // routing-base：low→small / high→large / 其余→medium（与原硬编码一致）
        return MODEL_TIERS.has(mapped) ? mapped : DEFAULT_TIER; // 档位合法性兜底不变
     }

     // 校验档位合法性（二期 LLM judge 复判后、或外部传入 tier 时校验用）
     isValidTier(tier) {
        return MODEL_TIERS.has(tier);
     }

     // confidence 计算：capabilityTags 命中 +1 / modelType 命中 +1 / modelTier 命中 +1
     _calcConfidence(tags, targetType, profileModelType, expectedModelType, tierMatch = false) {
        let score = 0;
        if (tags.includes(targetType)) score += 1;
        if (profileModelType === expectedModelType) score += 1;
        if (tierMatch) score += 1;
        return score;
     }

    // 硬规则覆盖（默认关）。task 字段按规格原形 snake_case（force_provider / exclude_providers），
    // camelCase 同义——调用方两种写法都收（task 上其它字段本来就是 camelCase）。
    // 最小解释：force 只在**剔除后的候选**里挑，不在候选里就不凭空造候选（记 forced=null + reason），
    // 由调用方从 decision.hardRule 看出来「规则没生效」，而不是静默当作没写。
    _hardRules(task, pool) {
        const force = task.forceProvider || task.force_provider || null;
        const rawExclude = task.excludeProviders || task.exclude_providers || null;
        const exclude = [].concat(rawExclude || []).filter((x) => typeof x === 'string' && x);
        if (!force && !exclude.length) return null;
        const excluded = new Set(exclude);
        const kept = excluded.size ? pool.filter((c) => !excluded.has(c.adapterId)) : pool;
        const forced = force ? kept.find((c) => c.adapterId === force) || null : null;
        return {
            // rule 进 decision（日志/审计看得见）；pool 只回给 route() 重新排序，不进日志。
            rule: {
                forceProvider: force,
                excludeProviders: exclude,
                forced,                   // route() 据此覆盖 chosen；null = 未强制
                reason: force && !forced ? `force_provider "${force}" not in candidates (kept ${kept.length})` : null,
            },
            pool: kept,
        };
    }

    // 「建议 A vs 实际 B」的价差（门控 PROXY_ROUTE_SHADOW_COST）。
    // baseline 取 task.actualProvider（实际走的那家）；token 取 task.tokens。
    // 缺任一项 → savings=null + reason，绝不填 0 冒充「没省钱」（cost.js 同款纪律）。
    _shadowCost(task, suggested) {
        const baseline = task.actualProvider || task.actual_provider || null;
        const out = { suggested, baseline, currency: 'CNY', savings: null, priced: false, reason: null };
        if (!baseline) { out.reason = 'no baseline provider (task.actualProvider)'; return out; }
        if (!task.tokens) { out.reason = 'no token usage (task.tokens)'; return out; }
        const pSug = this.pricing && this.pricing[suggested] || null;
        const pBase = this.pricing && this.pricing[baseline] || null;
        if (!pSug || !pBase) { out.reason = `missing pricing for ${!pSug ? suggested : baseline}`; return out; }
        const cSug = tokenCost(task.tokens, pSug);
        const cBase = tokenCost(task.tokens, pBase);
        if (cSug == null || cBase == null) { out.reason = 'unpriced (invalid tokens/pricing)'; return out; }
        out.suggestedCost = Math.round(cSug * 1e6) / 1e6;
        out.baselineCost = Math.round(cBase * 1e6) / 1e6;
        out.savings = Math.round((cBase - cSug) * 1e6) / 1e6;   // 正数 = 建议更省（可省 ¥X）
        out.priced = true;
        return out;
    }

    // shadow 日志汇总：回答「智能路由到底省不省钱」——把 ring buffer 里算得出价的条目累加。
    // 只统计 priced 条目，算不出的单独计数（unpriced），免得被 null 污染成「省了 0」。
    savingsSummary() {
        let savings = 0, priced = 0, unpriced = 0;
        for (const d of this.log) {
            const c = d && d.shadowCost;
            if (!c) continue;
            if (c.priced) { savings += c.savings; priced++; } else { unpriced++; }
        }
        return { entries: this.log.length, priced, unpriced, currency: 'CNY', savings: Math.round(savings * 1e6) / 1e6 };
    }

     _pushLog(decision) {
         this.log.push(decision);
         if (this.log.length > this.logCapacity) {
             this.log = this.log.slice(-this.logCapacity);
         }
     }

     // taskPrompt 脱敏（按 this.logRedaction 档）。
     // 'full'：现状——字符串截前 50 字，非字符串记 '...'，无 prompt 记 null（零行为变更）。
     // 'metadata_only'：有 prompt 只记元数据 { hasPrompt, length }，不留正文。
     // 'off'：不记（null）。
     _redact(prompt) {
         if (this.logRedaction === 'off') return null;
         if (this.logRedaction === 'metadata_only') {
             return prompt != null ? { hasPrompt: true, length: (typeof prompt === 'string' ? prompt.length : 0) } : null;
         }
         // 'full'（默认）：维持现状
         return prompt ? (typeof prompt === 'string' ? prompt.slice(0, 50) : '...') : null;
     }

    async _execute(adapterId, task, ctx, runOpts) {
        // L2 P3：executor 注入时代理执行；否则保持 stub（status:'queued'），零行为变更
     if (typeof this.executor === 'function') {
            try {
                const value = await this.executor(adapterId, task, ctx, runOpts);
                return { adapterId, status: 'done', value };
             } catch (e) {
                return { adapterId, status: 'failed', error: e && e.message || String(e) };
            }
          }
     return { adapterId, status: 'queued' };
      }

     // L2 P3：通过 Orchestrator 跑一个 DAG，每个子任务用本 engine.route 选 adapter，
     // 路由决策用 shadow 模式（不触发 route 内部的 _execute 执行副作用），
     // 真正的执行由 orchestrator 通过 bridge executor 调 _execute 完成。
     // 默认零副作用：dag/orchestrator 都按调用方给；不写盘不联网。
     runDag(dag, runOpts = {}) {
       const { Orchestrator } = require('./orchestrator.js');
       // 路由决策阶段强制 shadow——避免 route() 内部 _execute 造成双重执行。
       const wasShadow = this.shadowMode;
       this.setShadowMode(true);
       try {
           const bridge = async (st, ctx) => {
               const task = st;
               const decision = this.route(task);
               const chosen = decision && decision.chosen;
               if (!chosen) return { shadow: true, via: 'unrouted', decision };
               // 非 shadow 才真执行；恢复后由 orchestrator.run 的 shadowMode 决定
               const exec = wasShadow
                    ? { shadow: true, via: chosen.adapterId, decision }
                    : await this._execute(chosen.adapterId, task, ctx, runOpts);
               return wasShadow
                    ? exec
                    : { ...exec, adapter: chosen.adapterId, via: 'route-engine' };
            };
           const orchestrator = new Orchestrator({
               executor: bridge,
               routeEngine: this,
               shadowMode: wasShadow,
               ...('maxRetries' in runOpts ? { maxRetries: runOpts.maxRetries } : {}),
               ...('dir' in runOpts ? { dir: runOpts.dir } : {}),
            });
           return orchestrator.run(dag, runOpts);
        } finally {
           this.setShadowMode(wasShadow);
        }
      }

    /**
     * 等所有在途 judge 落地（供测试 / 批处理收口用）。
     * 热路径不 await —— judge 是旁路观测，路由结果不受它影响。
     */
    /// 收口**所有**旁路（complexity judge + 风险打标），供测试/批处理一次性拿全量结果。
    /// 风险那条虽然单独存（见 awaitRisk），但这里的语义是「等全」，漏掉任何一路都是坑。
    async awaitJudges(timeoutMs = DEFAULT_JUDGE_TIMEOUT) {
        const pending = [...this._judgeCalls, ...this._riskCalls];
        if (!pending.length) return;
        await Promise.race([
            Promise.allSettled(pending),
            new Promise((r) => setTimeout(r, timeoutMs)),
        ]);
    }

    /// 只收口风险旁路（decision.risk）。Portico 的二次确认动作要拿 needsConfirm，
    /// 但那与「这条请求该走哪个档位」无关——不该等 complexity judge。
    /// 没有开 riskGate 时立即返回（零等待），与 awaitJudges 的空集行为一致。
    /// @param {number} [timeoutMs=DEFAULT_JUDGE_TIMEOUT] 收口超时，超时后按「跑了没结果」放行
    async awaitRisk(timeoutMs = DEFAULT_JUDGE_TIMEOUT) {
        const pending = [...this._riskCalls];
        if (!pending.length) return;
        await Promise.race([
            Promise.allSettled(pending),
            new Promise((r) => setTimeout(r, timeoutMs)),
        ]);
    }
}

module.exports = { RouteEngine, DEFAULT_JUDGE_TIMEOUT };
