// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 P3 · skill-hosts 生产接线：把 l2/skill-hosts.js（宿主 adapter）接上 manager 真实链路。
// 与 routes/skill-service.js 同款门控 + 非侵入④ + 异常 catch→4xx。
//
// 设计（只读面 + 门控默认关）：
//   - 门控 PROXY_L2_SKILLHOSTS ∈ {1,true,on} 才放行，默认 0 → 403 零副作用（热路径零影响）。
//   - **只暴露只读面**：scan（纯读目录）+ plan（dry-run 只算不写）。
//     不暴露 install / setEnabled —— HTTP 面默认绝不写 agent 目录，非侵入④ 的铁律。
//     要真写必须走本地工具直接调 l2/skill-hosts.js 并显式传 home|project。
//   - scan 默认扫 $HOME；传 ?project=<dir> 时扫项目级目录（project 优先）。
//   - 不落任何中枢状态：内核 scan/plan 都是纯函数式只读，无单例无持久化。

const express = require('express');
const SH = require('../../l2/skill-hosts.js');
const SP = require('../../l2/skill-policy.js');

const router = express.Router();

// 门控：PROXY_L2_SKILLHOSTS ∈ {1,true,on} 才放行，其余一律 403（默认零副作用）
function isGatedOpen() {
    const v = String(process.env.PROXY_L2_SKILLHOSTS || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}
const NOT_OPEN_MSG =
   'PROXY_L2_SKILLHOSTS 未开启（默认关）→ skill-hosts 路由拒服务；' +
   '开灰度：PROXY_L2_SKILLHOSTS=1 node server.js。';

function gate(req, res, next) {
    if (!isGatedOpen()) { return res.status(403).json({ error: 'skill-hosts-gate-closed', hint: NOT_OPEN_MSG }); }
    next();
}
router.use(gate);

// GET / → 宿主表（含 skillSwitch 标记：谁在 SkillSwitch 五件套里）
router.get('/', (_req, res) => {
    try {
        res.json(SH.listHosts());
    } catch (e) {
        res.status(500).json({ error: 'skill-hosts-list-failed', detail: e.message });
    }
});

// GET /ledger → 全量扫描所有宿主 + token 汇总（只读，供 Web UI 一次拉全量）
// 默认不开 tokens（要读一遍文件），显式 ?tokens=1 才量。
router.get('/ledger', (req, res) => {
    try {
        const opts = {};
        if (req.query.project) { opts.project = req.query.project; }
        if (req.query.tokens === '1' || req.query.tokens === 'true') { opts.tokens = true; }
        if (req.query.hosts) { opts.hosts = String(req.query.hosts).split(',').filter(Boolean); }
        res.json(SH.scanLedger(opts));
    } catch (e) {
        res.status(e.message.includes('unknown host') ? 404 : 500)
            .json({ error: 'skill-hosts-ledger-failed', detail: e.message });
    }
});

// GET /:hostId/scan?project=<dir>&tokens=1 → 只读扫描。不写任何文件。
router.get('/:hostId/scan', (req, res) => {
    try {
        const opts = {};
        if (req.query.project) { opts.project = req.query.project; }
        if (req.query.tokens === '1' || req.query.tokens === 'true') { opts.tokens = true; }
        const r = SH.scan(req.params.hostId, opts);
        if (!r.exists) { return res.status(404).json({ error: 'host-not-installed', host: req.params.hostId, dir: r.dir }); }
        res.json(r);
    } catch (e) {
        // 含未知宿主（getHost 抛错）
        res.status(e.message.includes('unknown host') ? 404 : 500)
            .json({ error: 'skill-hosts-scan-failed', detail: e.message });
    }
});

// POST /budget-plan → skill 预算 dry-run：只回答「给这么多预算会关掉哪几条」。
// 纯算：不建 policy、不跑 apply、不落盘。l2/skill-policy.js 的 explainSkillBudget 口径。
// body: { project?, host?, budget?, kind? }
router.post('/budget-plan', (req, res) => {
    try {
        const b = req.body || {};
        const opts = {};
        if (b.project) { opts.project = b.project; }
        // 未知宿主 → 404（跟 scan 一个口径，别静默返回空账本）
        if (b.host) { SP.SK.getHost(b.host); opts.host = b.host; }
        const out = SP.explainSkillBudget({
            ...(opts.host ? { host: opts.host } : {}),
            ...(b.kind ? { kind: b.kind } : {}),
            ...(Number.isFinite(Number(b.budget)) && b.budget !== '' ? { budget: Number(b.budget) } : {}),
            ledgerOpts: opts,
        });
        res.json(out);
    } catch (e) {
        res.status(e.message.includes('unknown host') ? 404 : 500)
            .json({ error: 'skill-hosts-budget-plan-failed', detail: e.message });
    }
});

// POST /plan → planInstall dry-run：只回答「装下去会写什么」，一个字节都不写。
// body: { host, name, description?, content?, project? }
router.post('/plan', (req, res) => {
    try {
        const b = req.body || {};
        if (!b.host) { return res.status(400).json({ error: 'missing-host' }); }
        if (!b.name) { return res.status(400).json({ error: 'missing-name' }); }
        const skill = { name: b.name, description: b.description || '', content: b.content || '' };
        res.json(SH.planInstall(skill, b.host, b.project ? { project: b.project } : {}));
    } catch (e) {
        res.status(e.message.includes('unknown host') ? 404 : 500)
            .json({ error: 'skill-hosts-plan-failed', detail: e.message });
    }
});

module.exports = router;
module.exports._isGatedOpenForTest = isGatedOpen;
