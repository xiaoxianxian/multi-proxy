'use strict';

// L2 P3 · skill-service 生产接线：把 l2/skill-service.js 内核接上 manager 真实链路。
// 镜像 routes/orchestration.js 挂法（门控默认关 + 长寿命单例 + 异常 catch→4xx）。
//
// 设计（非侵入④ + 门控默认关）：
//   - 门控 PROXY_L2_SKILL ∈ {1,true,on} 才放行，默认 0 → 403 零副作用（热路径零影响）。
//   - 长寿命 module-level 单例 SkillService：条目跨请求累积才有意义（重启即失，留 P3 落盘）。
//   - 不写任何 agent 文件（skill service 内核自带 store，HTTP 仅读写内存态）。
//   - 异常一律 catch → 4xx，不冒泡污染 manager 主进程。
//
// 路由面（YAGNI，对齐内核 API）：
//   GET    /api/skill-service            → 列全部最新条目（list 过滤）
//   POST   /api/skill-service            → 创建技能（create；body=raw 技能）
//   GET    /api/skill-service/:key       → 取某 name/id 最新版本
//   PUT    /api/skill-service/:key        → 更新 + 默认 bump patch
//   POST   /api/skill-service/:key/bump    → bump 版本
//   POST   /api/skill-service/:key/rollback → 回滚到 targetVersion

const express = require('express');
const { createSkillService } = require('../../l2/skill-service.js');

const router = express.Router();

// 长寿命单例：内存态跨请求累积（重启即失；持久化留 P3 dir 落盘）
let _svc = null;
function getService() {
    if (!_svc) { _svc = createSkillService(); }
    return _svc;
}

// 门控：PROXY_L2_SKILL ∈ {1,true,on} 才放行，其余一律 403（默认零副作用）
function isGatedOpen() {
    const v = String(process.env.PROXY_L2_SKILL || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}
const NOT_OPEN_MSG =
   'PROXY_L2_SKILL 未开启（默认关）→ skill-service 路由拒服务；' +
   '开灰度：PROXY_L2_SKILL=1 node server.js。';

function gate(req, res, next) {
   if (!isGatedOpen()) return res.status(403).json({ error: 'skill-service-gate-closed', hint: NOT_OPEN_MSG });
 next();
}
router.use(gate);

// GET / → 列全部最新条目（?source= builtin|custom / ?tags= a,b / ?enabled= true|false / ?name=）
router.get('/', (req, res) => {
 try {
 const f = {};
    if (req.query.source) f.source = req.query.source;
    if (req.query.name) f.name = req.query.name;
    if (req.query.tags) f.tags = String(req.query.tags).split(',').map((s) => s.trim()).filter(Boolean);
    if (req.query.enabled !== undefined) f.enabled = req.query.enabled === 'true' || req.query.enabled === '1';
    res.json(getService().list(f));
 } catch (e) {
    res.status(500).json({ error: 'skill-service-list-failed', message: e.message });
 }
});

// POST / → 创建技能（body = raw 技能；可选 source=builtin）
router.post('/', (req, res) => {
 try {
    const raw = (req.body || {});
    const opts = raw.source ? { source: raw.source } : {};
   const entry = getService().create(raw, opts);
    res.status(201).json(entry);
 } catch (e) {
    res.status(400).json({ error: 'skill-service-create-failed', message: e.message });
 }
});

// GET /:key → 取某 name 或 id 的最新版
router.get('/:key', (req, res) => {
 try {
    res.json(getService().get(req.params.key));
 } catch (e) {
     res.status(404).json({ error: 'skill-not-found', message: e.message });
 }
});

// PUT /:key → 更新 + 默认 bump patch（body = patch 字段）
router.put('/:key', (req, res) => {
 try {
    const opts = {};
    if (req.body && req.body.version) opts.version = req.body.version;
    const next = getService().update(req.params.key, (req.body || {}), opts);
    res.json(next);
 } catch (e) {
    const status = /not found/i.test(e.message) ? 404 : 400;
    res.status(status).json({ error: 'skill-service-update-failed', message: e.message });
 }
});

// POST /:key/bump → bump 版本（body 可选 version）
router.post('/:key/bump', (req, res) => {
 try {
    const opts = {};
    if (req.body && req.body.version) opts.version = req.body.version;
    res.json(getService().bump(req.params.key, opts));
 } catch (e) {
    res.status(404).json({ error: 'skill-service-bump-failed', message: e.message });
 }
});

// POST /:key/rollback → 回滚到 targetVersion
router.post('/:key/rollback', (req, res) => {
 const target = (req.body || {}).targetVersion;
    if (!target) return res.status(400).json({ error: 'skill-service-rollback-no-target', hint: 'body.targetVersion required' });
 try {
    res.json(getService().rollback(req.params.key, target));
 } catch (e) {
    const m = e.message || '';
    const status = /not found/i.test(m) ? 404 : 400;
    res.status(status).json({ error: 'skill-service-rollback-failed', message: m });
 }
});

module.exports = router;

// 测试辅助（不暴露到路由，仅供单测重置单例验证长寿命语义）
module.exports._resetForTest = () => { _svc = null; };
