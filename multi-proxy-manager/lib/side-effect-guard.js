'use strict';

// Side Effect Guard — B 类副作用故障的端到端处置链路（编排层）
//
// 把三块已落地的零件串成一条回路：
//   ① tool-capability-gate  → 权限门禁（这个工具/动作有没有资格跑）
//   ② session-store         → 幂等键（这步是不是已经做过了）
//   ③ action-audit          → 动作审计（到底改成什么样了，含 unknown 态）
//
// 链路（对应原文那张「先查原动作，再决定是否重试」的图）：
//   执行前 beforeAction：先查权限 → 再查幂等 → 放行/跳过/拦截
//   执行后 recordResult：把结果记进审计（accepted / completed / failed / unknown）
//   崩溃后 reconcile   ：按幂等键拉历史 → 给出 skip / retry / manual 三选一
//
// 🔴 本模块存在的核心理由，就一条：**unknown 态绝不直接重试。**
//   对副作用操作，最危险的不是明确失败，而是「不知道成没成」。
//   明确失败可以重试；unknown 必须先对账，查不清就转人工——这是原文最硬的一条。
//
// 非侵入：门控默认关；业务执行由调用方注入 executor，本模块不自己发起写操作。

const { ActionAudit } = require('./action-audit');
const { SessionStore } = require('./session-store');

// 对账结论三选一（不含「直接重试 unknown」这一项，是故意的）
const DECISIONS = ['skip', 'retry', 'manual'];

class SideEffectGuard {
    /**
     * @param {object} opts
     *   audit    {ActionAudit}  动作审计实例（可注入，便于测试）
     *   store    {SessionStore} session store 实例（可注入）
     *   gate     {function}     权限判定函数 (toolName) => { blocked:bool, reason }；不传 = 不校验
     *   enabled  {boolean}      门控；默认关（铁律④）。不传时读 env MULTI_PROXY_SIDE_EFFECT_GUARD
     *   manualDeadlineMs {number} unknown 态存活超过这个时长就转人工，默认 30 分钟
     */
    constructor({ audit = null, store = null, gate = null, enabled = null, manualDeadlineMs = 30 * 60 * 1000 } = {}) {
        this.audit = audit || new ActionAudit();
        this.store = store || new SessionStore();
        this.gate = gate;
        this.enabled = enabled === null
            ? process.env.MULTI_PROXY_SIDE_EFFECT_GUARD === '1'
            : Boolean(enabled);
        this.manualDeadlineMs = manualDeadlineMs;
    }

    /**
     * 执行前查证：权限 → 幂等 → 放行/跳过/拦截。
     * @returns {object} { proceed, reason, existing }
     *   proceed=true  可以执行
     *   proceed=false 不能执行；reason 说明为什么
     *     'guard-disabled'     门控关（调用方按原逻辑跑，本模块不介入）
     *     'blocked-by-gate'    权限门禁拦下
     *     'already-completed'  幂等键命中且最终态是 completed → 跳过，别重复做
     */
    beforeAction({ toolName, idempotencyKey, actor, resource, sessionId } = {}) {
        if (!this.enabled) return { proceed: false, reason: 'guard-disabled' };

        // ① 权限门禁
        if (typeof this.gate === 'function') {
            const g = this.gate(toolName) || {};
            if (g.blocked) return { proceed: false, reason: 'blocked-by-gate', gateReason: g.reason || null };
        }

        // ② 幂等查证：命中且已 completed → 跳过（崩溃重放时「跳过已完成」的落地点）
        if (idempotencyKey) {
            const history = this.audit.queryByIdempotencyKey(idempotencyKey);
            const completed = history.find((e) => e.result === 'completed');
            if (completed) {
                return { proceed: false, reason: 'already-completed', existing: completed };
            }
            // session 层也查一次（两条账本互补：审计记动作，session 记 step）
            if (sessionId && typeof this.store.replayStep === 'function') {
                try {
                    const step = this.store.replayStep(sessionId, idempotencyKey);
                    if (step && step.status === 'done') {
                        return { proceed: false, reason: 'already-completed', existing: step };
                    }
                } catch { /* session 不存在时 ignore，审计账本为准 */ }
            }
        }

        // ③ 放行前先记一条 proposed（有据可查：这个动作被提出过）
        this.audit.record({
            actor, action: toolName, resource, idempotencyKey,
            result: 'proposed', sourceOfTruth: 'guard',
            meta: { phase: 'before' },
        });
        return { proceed: true, reason: 'ok' };
    }

    /**
     * 执行后记结果。
     * @param {string} result ACTION_RESULTS 之一；传错/不传 → fail-safe 回落 unknown
     */
    recordResult({ idempotencyKey, result, actor, resource, action, sourceOfTruth, meta } = {}) {
        return this.audit.record({
            actor, action, resource, idempotencyKey, result,
            sourceOfTruth, meta: { ...(meta || {}), phase: 'after' },
        });
    }

    /**
     * 崩溃后：列出仍处于未终结状态的动作（需人工介入 / 继续对账的队列）。
     *
     * 🔴 用 queryUnresolved（未终结）而不是 queryUnknown（严格 unknown）：
     *    进程在记完 proposed 之后猝死，留下的是 proposed 孤儿 —— result 字段
     *    是 'proposed'，只筛 unknown 会整笔漏掉。2026-10-07 真 SIGKILL 演练实测。
     *    未终结 = 最后一条不是 completed / failed，即「还没有确定答案」。
     */
    pendingReconciliation() {
        return this.audit.queryUnresolved();
    }

    /**
     * 对账决策：给定幂等键，返回 skip / retry / manual 三选一。
     *
     * 规则（对齐原文「先对账，再重试」）：
     *   - 历史里有 completed          → skip（已完成，绝不重复）
     *   - 最后态 failed               → retry（明确失败，可安全重试）
     *   - 最后态 unknown 且在期限内   → manual（🔴 不直接重试：先查源系统，查清了再决定）
     *   - 最后态 unknown 且超期限     → manual（转人工，别无限等）
     *   - 最后态 accepted             → manual（只有受理回执，业务没确认完成，不能当完成）
     *   - 无历史                      → manual（没有账本依据，不敢自动重试）
     */
    reconcile(idempotencyKey, { now = Date.now() } = {}) {
        const history = this.audit.queryByIdempotencyKey(idempotencyKey);
        if (!history.length) {
            return { decision: 'manual', reason: 'no-history', history: [] };
        }
        const last = history[history.length - 1];

        if (history.some((e) => e.result === 'completed')) {
            return { decision: 'skip', reason: 'already-completed', history };
        }
        if (last.result === 'failed') {
            return { decision: 'retry', reason: 'explicit-failure', history };
        }
        if (last.result === 'unknown') {
            const aged = now - new Date(last.ts).getTime() >= this.manualDeadlineMs;
            // 🔴 unknown 一律不自动重试：期限内等查证，超期限转人工
            return { decision: 'manual', reason: aged ? 'unknown-past-deadline' : 'unknown-awaiting-reconciliation', history };
        }
        if (last.result === 'accepted') {
            return { decision: 'manual', reason: 'accepted-not-confirmed', history };
        }
        // proposed 且无后续 = 不确定有没有真发出去，同 unknown 处理
        return { decision: 'manual', reason: 'unresolved-state', history };
    }
}

module.exports = { SideEffectGuard, DECISIONS };
