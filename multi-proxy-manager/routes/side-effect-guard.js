'use strict';

// 业务侧副作用防护 — HTTP 端点
//
// 为什么存在：side-effect-guard 的逻辑寄生在 multi-proxy-manager（JS），而真实业务
// （如审核平台的机审判定提交，Python 工具链）是另一个项目、另一门语言。把 guard
// 暴露成 HTTP 端点，让外部业务通过 before-action / record-result / reconcile 接入，
// **零重复造**（不把这套逻辑用 Python 重写一遍），且跨语言无障碍。
//
// 🔴 存储隔离：本路由的 guard 用 guard-business 独立目录，与 multi-proxy 自己的
// session 账本（sessions.json / 默认 action-audit.log）物理隔离——审核平台的"业务
// 动作"不该混进 manager 的"session step"。
//
// 门控：before-action / record-result 受 MULTI_PROXY_SIDE_EFFECT_GUARD 控制（默认关）；
// reconcile/pending 是只读诊断端点，不受门控（崩溃后无论门控开否都应能查待对账队列）。

const os = require('os');
const path = require('path');

const BUSINESS_GUARD_DIR = path.join(os.homedir(), '.multi-proxy-manager', 'guard-business');

let guard = null;

function getGuard() {
    if (!guard) {
        const { SideEffectGuard } = require('../lib/side-effect-guard');
        const { ActionAudit } = require('../lib/action-audit');
        const { SessionStore } = require('../lib/session-store');
        guard = new SideEffectGuard({
            audit: new ActionAudit({ dir: BUSINESS_GUARD_DIR }),
            store: new SessionStore({ dir: BUSINESS_GUARD_DIR }),
            gate: null, // 业务侧权限由调用方自管，不接 curator tool gate
        });
    }
    return guard;
}

const router = require('express').Router();

// 注入（测试用，避免污染真实 guard-business 账本）
router.setGuard = (g) => { guard = g; };

// POST /api/guard/before-action
// body: { action, resource, idempotencyKey, actor, sessionId?, toolName? }
router.post('/before-action', (req, res) => {
    const g = getGuard();
    if (!g.enabled) return res.json({ proceed: false, reason: 'guard-disabled' });
    try {
        const out = g.beforeAction(req.body || {});
        res.json({
            proceed: out.proceed,
            reason: out.reason,
            existing: out.existing || null,
            gateReason: out.gateReason || null,
        });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// POST /api/guard/record-result
// body: { idempotencyKey, result, actor?, resource?, action?, sourceOfTruth?, meta? }
router.post('/record-result', (req, res) => {
    const g = getGuard();
    if (!g.enabled) return res.json({ ok: true, skipped: 'guard-disabled' });
    try {
        const rec = g.recordResult(req.body || {});
        res.json({ ok: Boolean(rec) });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// GET /api/guard/reconcile/pending — 只读取待对账队列（崩溃恢复用），不受门控
router.get('/reconcile/pending', (req, res) => {
    try {
        res.json({ items: getGuard().pendingReconciliation() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/guard/reconcile — 按幂等键给对账决策（只读，不受门控）
// body: { idempotencyKey }
router.post('/reconcile', (req, res) => {
    try {
        const { idempotencyKey } = req.body || {};
        if (!idempotencyKey) return res.status(400).json({ ok: false, error: 'idempotencyKey required' });
        res.json(getGuard().reconcile(idempotencyKey));
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.BUSINESS_GUARD_DIR = BUSINESS_GUARD_DIR;
module.exports = router;
