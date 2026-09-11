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

const express = require('express');
const router = express.Router();

// 注入 sessionStore（从 server.js require）
let sessionStore = null;

function getStore() {
    if (!sessionStore) {
        sessionStore = require('../lib/session-store');
    }
    return sessionStore;
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
router.post('/:id/step', (req, res) => {
    try {
        const step = getStore().addStep(req.params.id, req.body);
        res.json({ ok: true, session: step });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// POST /api/sessions/:id/resume — 续跑（从最后一步继续）
router.post('/:id/resume', (req, res) => {
    try {
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

module.exports = router;
