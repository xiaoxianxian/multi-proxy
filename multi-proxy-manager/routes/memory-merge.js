'use strict';

// L2 P3 · memory-merge 生产接线：把 l2/memory-merge.js 内核接上 manager 真实链路。
// 镜像 routes/orchestration.js / routes/skill-service.js 挂法（门控默认关 + catch→4xx）。
//
// 设计（非侵入④ + 门控默认关）：
//    - 门控 PROXY_L2_MEMORY ∈ {1,true,on} 才放行，默认 0 → 403 零副作用。
//    - 内核纯函数（merge/validateMemoryDoc/envInject）无状态 → 单请求即完成，无常寿命态。
//    - 不写任何 agent 文件：merge 默认 strategy='shared'（共享优先，冲突时 personal 覆盖），
//      不默认写 personal 层；envInject 默认零副作用（未在 DEFAULT_ENV_MAP 的 type 不注）。
//    - 异常一律 catch → 4xx，不冒泡。
//
// 路由面（YAGNI，对齐内核 API）：
//   POST  /api/memory-merge/merge            → 合并 shared+personal → 返回合并文档 + meta
//   POST  /api/memory-merge/validate          → 校验一份 memory doc（specVersion + entries 等）
//   POST  /api/memory-merge/env-inject        → 把合并结果投影到 env / context（默认零注入）

const express = require('express');
const { merge, envInject, validateMemoryDoc } = require('../../l2/memory-merge.js');

const router = express.Router();

// 门控：PROXY_L2_MEMORY ∈ {1,true,on} 才放行，其余一律 403（默认零副作用）
function isGatedOpen() {
    const v = String(process.env.PROXY_L2_MEMORY || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}
const NOT_OPEN_MSG =
    'PROXY_L2_MEMORY 未开启（默认关）→ memory-merge 路由拒服务；' +
    '开灰度：PROXY_L2_MEMORY=1 node server.js。';

function gate(req, res, next) {
   if (!isGatedOpen()) return res.status(403).json({ error: 'memory-merge-gate-closed', hint: NOT_OPEN_MSG });
 next();
}
router.use(gate);

// POST /merge → 合并 shared + personal 两层 → 返回 { specVersion, entries, meta }
// body: { shared, personal, strategy? } strategy ∈ {shared, personal, error}，默认 shared
router.post('/merge', (req, res) => {
 try {
    const b = (req.body || {});
    const opts = {};
    if (b.strategy) opts.strategy = b.strategy;    // 缺省走内核 DEFAULT_STRATEGY
    const out = merge(b.shared, b.personal, opts);
    res.json(out);
 } catch (e) {
    res.status(400).json({ error: 'memory-merge-failed', message: e.message });
 }
});

// POST /validate → 校验一份 memory doc，返回 { valid, errors }
// body: { doc } 或直接是 doc 本体
router.post('/validate', (req, res) => {
 const doc = (req.body && req.body.doc) ? req.body.doc : (req.body || {});
    const r = validateMemoryDoc(doc);
    res.status(r.valid ? 200 : 400).json(r);
});

// POST /env-inject → 把 merged 结果投影到 env / context
// body: { merged, env?, envMap?, contextMaxLen? }
router.post('/env-inject', (req, res) => {
 try {
    const b = (req.body || {});
    const opts = {};
    if (b.env) opts.env = b.env;
    if (b.envMap) opts.envMap = b.envMap;
    if (b.contextMaxLen != null) opts.contextMaxLen = b.contextMaxLen;
    res.json(envInject(b.merged, opts));
 } catch (e) {
    res.status(400).json({ error: 'memory-env-inject-failed', message: e.message });
 }
});

module.exports = router;

// 测试辅助：memory-merge 无状态，无需单例重置；保留以对齐同组路由测试约定。
module.exports._resetForTest = () => { /* no-op：无状态 */ };
