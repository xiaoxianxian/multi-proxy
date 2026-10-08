// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// Sessions API — M7 任务级 Session 管理路由
// 挂载到 /api/sessions/*
//
// 端点：
//   GET    /api/sessions          — 列表（支持 ?proxy=&status=&limit=）
//   GET    /api/sessions/:id      — 详情
//   POST   /api/sessions          — 创建
//   PUT    /api/sessions/:id      — 更新状态
//   POST   /api/sessions/:id/abort — 手动中止
//   DELETE /api/sessions/:id      — 删除
//
// B 类副作用故障处置（门控默认关，开启见 MULTI_PROXY_SIDE_EFFECT_GUARD=1）：
//   POST   /api/sessions/:id/step — 增加权限门禁 + 幂等跳过（门控开时生效）
//   POST   /api/sessions/:id/resume — 先对账再续跑，有 unknown 则 409
//   GET    /api/sessions/reconcile/pending — 待对账队列（崩溃后谁还没查清）
//   POST   /api/sessions/reconcile — 对账决策（skip / retry / manual）

const express = require('express');
const router = express.Router();

// 注入 sessionStore（从 server.js require）；未注入时 lazy 实例化
// 注意：lib/session-store.js 导出的是 { SessionStore } 类模块，必须 new 出实例，
// 否则 getStore().list/create 等方法不存在（曾导致 /api/sessions 全 400/500）。
let sessionStore = null;

function getStore() {
    if (!sessionStore) {
        const { SessionStore } = require('../lib/session-store');
        sessionStore = new SessionStore();
    }
    return sessionStore;
}

// 注入 sideEffectGuard —— B 类副作用故障处置链路（幂等键 + 权限门禁 + 动作审计）
//
// 形态与 getStore() 一致：lazy 实例化。**门控默认关（铁律④）** ——
// 未启用时 beforeAction 返回 reason='guard-disabled'，路由按原逻辑走，零行为变更。
//
// 权限门禁复用 curator 的 tool-capability-gate（同一份逻辑，不在这里重复实现）；
// curator pack 不可用时降级为「不校验权限」，不阻断主流程。
let sideEffectGuard = null;

function getGuard() {
    if (!sideEffectGuard) {
        const { SideEffectGuard } = require('../lib/side-effect-guard');
        let gate = null;
        try {
            const { handler } = require('../../packs/curator/policies/tool-capability-gate');
            gate = (toolName) => handler({ toolName, rawOutput: '' });
        } catch { /* curator pack 不可用 → 不校验权限 */ }
        sideEffectGuard = new SideEffectGuard({ gate });
    }
    return sideEffectGuard;
}

// GET /api/sessions
router.get('/', (req, res) => {
    try {
        const { proxy, status, limit = 20 } = req.query;
        const filter = {};
        if (proxy) filter.proxy = proxy;
        if (status) filter.status = status;
        if (limit) filter.limit = parseInt(limit);
        const sessions = getStore().list(filter);
        res.json({ ok: true, count: sessions.length, sessions });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/sessions/running
router.get('/running', (req, res) => {
    try {
        const sessions = getStore().getRunning();
        res.json({ ok: true, count: sessions.length, sessions });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ⚠️ 以下两个 /reconcile* 路由必须定义在 /:id 之前，否则会被通配路由吃掉。
//
// GET /api/sessions/reconcile/pending — 待对账队列
//   崩溃重启后：哪些动作「不知道成没成」，需要查源系统确认。
//   只读查询，不依赖门控开关（账本本来就在那儿）。
router.get('/reconcile/pending', (req, res) => {
    try {
        const guard = getGuard();
        const pending = guard.pendingReconciliation();
        res.json({ ok: true, count: pending.length, pending, guardEnabled: guard.enabled });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/sessions/reconcile — 对账决策
//   body: { idempotencyKey }
//   返回 { decision: 'skip' | 'retry' | 'manual', reason, history }
//   🔴 返回值里永远不会有「unknown → retry」：unknown 一律 manual（先查源系统）。
router.post('/reconcile', (req, res) => {
    try {
        const body = req.body || {};
        const key = body.idempotencyKey || body.idempotency_key;
        if (!key) return res.status(400).json({ ok: false, error: 'idempotencyKey required' });
        const verdict = getGuard().reconcile(key);
        res.json({ ok: true, idempotencyKey: key, ...verdict });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/sessions/:id
router.get('/:id', (req, res) => {
    try {
        const session = getStore().get(req.params.id);
        res.json({ ok: true, session });
    } catch (e) {
        res.status(404).json({ ok: false, error: e.message });
    }
});

// POST /api/sessions
router.post('/', (req, res) => {
    try {
        const { proxy, task, targetProvider, targetAdapter } = req.body;
        if (!proxy || !task) {
            return res.status(400).json({ ok: false, error: 'proxy and task required' });
        }
        const session = getStore().create({ proxy, task, targetProvider, targetAdapter });
        res.status(201).json({ ok: true, session });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// PUT /api/sessions/:id
router.put('/:id', (req, res) => {
    try {
        const session = getStore().update(req.params.id, req.body);
        res.json({ ok: true, session });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// POST /api/sessions/:id/step — 添加步骤
//
// 门控开启时走 B 类故障处置链路：权限门禁 → 幂等查证 → 放行 / 跳过 / 拦截。
// 门控关闭时完全等同于原逻辑（铁律④ 零行为变更）。
//
// body 可选字段（门控开启时才生效）：
//   tool            工具/动作名（权限门禁判定用）
//   idempotencyKey  幂等键（同 key 已完成则跳过，不重复执行）
//   actor / resource / sourceOfTruth / result —— 审计留痕用；带 result 时补记终态
router.post('/:id/step', (req, res) => {
    try {
        const body = req.body || {};
        const guard = getGuard();
        const key = body.idempotencyKey || body.idempotency_key;

        if (guard.enabled) {
            const verdict = guard.beforeAction({
                toolName: body.tool,
                idempotencyKey: key,
                actor: body.actor || 'sessions-api',
                resource: body.resource || null,
                sessionId: req.params.id,
            });
            // 权限门禁拦下：工具未授权
            if (verdict.reason === 'blocked-by-gate') {
                return res.status(403).json({
                    ok: false, error: 'tool-not-permitted',
                    gateReason: verdict.gateReason || null,
                });
            }
            // 幂等键命中且已完成：崩溃重放时「跳过已完成」，绝不重复执行
            if (verdict.reason === 'already-completed') {
                return res.json({
                    ok: true, skipped: true, reason: 'already-completed',
                    existing: verdict.existing || null,
                });
            }
            // proceed=true：放行前已记一条 proposed 留痕
        }

        const step = getStore().addStep(req.params.id, body);

        // 调用方带回业务结果时补记终态（proposed → accepted/completed/failed/unknown），
        // 账本才完整；没有 result 时这一步停留在 proposed，交由对账裁决。
        if (guard.enabled && body.result) {
            guard.recordResult({
                idempotencyKey: key,
                result: body.result,
                actor: body.actor || 'sessions-api',
                resource: body.resource || null,
                action: body.tool,
                sourceOfTruth: body.sourceOfTruth || 'caller',
            });
        }
        res.json({ ok: true, session: step });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// POST /api/sessions/:id/resume — 续跑（从最后一步继续）
//
// 🔴 门控开启时执行「先对账、再续跑」（原文恢复顺序的核心）：
//    存在 unknown 动作时拒绝盲继续 —— 结果未知的动作，续跑就是重复执行。
//    unknown 的正确处置是查源系统确认，不是重跑一遍。
//    门控关闭时完全等同于原逻辑。
router.post('/:id/resume', (req, res) => {
    try {
        const guard = getGuard();
        if (guard.enabled) {
            const pending = guard.pendingReconciliation();
            if (pending.length) {
                return res.status(409).json({
                    ok: false,
                    error: 'unreconciled-unknown-actions',
                    hint: '存在结果未知的动作，必须先对账再续跑（unknown 绝不直接重试）',
                    count: pending.length,
                    pending,
                });
            }
        }
        const session = getStore().get(req.params.id);
        if (session.status !== 'failed' && session.status !== 'aborted') {
            return res.status(400).json({ ok: false, error: '只能续跑 failed/aborted 状态的任务' });
        }
        // 重新标记为 running
        const updated = getStore().update(req.params.id, { status: 'running', resumedAt: new Date().toISOString() });
        res.json({ ok: true, session: updated });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// POST /api/sessions/:id/abort
router.post('/:id/abort', (req, res) => {
    try {
        const session = getStore().abort(req.params.id, req.body.by || 'user');
        res.json({ ok: true, session });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// POST /api/sessions/:id/done
router.post('/:id/done', (req, res) => {
    try {
        const session = getStore().markDone(req.params.id);
        res.json({ ok: true, session });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// POST /api/sessions/:id/fail
router.post('/:id/fail', (req, res) => {
    try {
        const session = getStore().markFailed(req.params.id, req.body.error || new Error('unknown'));
        res.json({ ok: true, session });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// DELETE /api/sessions/:id
router.delete('/:id', (req, res) => {
    try {
        getStore().remove(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.status(404).json({ ok: false, error: e.message });
    }
});

// 注入 store（由 server.js 调用）
router.setStore = (store) => {
    sessionStore = store;
};

// 注入 guard（测试用：把账本重定向到 tmp，避免污染真实 ~/.multi-proxy-manager）
router.setGuard = (guard) => {
    sideEffectGuard = guard;
};

module.exports = router;
