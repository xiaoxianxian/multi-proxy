'use strict';

// L2 P0 · knowledge-base（RAG 知识库）生产接线：把 l2/knowledge-base/knowledge-base.js 内核接上 manager HTTP API。
// 镜像 routes/memory-merge.js / routes/skill-service.js 挂法（门控默认关 + catch→4xx/403 + 状态复位钩子）。
//
// 设计（非侵入④ + 门控默认关 + 拉模式）：
//     - 门控 PROXY_KNOWLEDGE_BASE ∈ {1,true,on} 才放行，其余一律 403（默认零副作用，与 skill/memory/mcp 同模式）。
//     - 单例 KnowledgeBase：默认仅内存（PROXY_KNOWLEDGE_BASE_DIR 才落盘到 manager 自己的目录，绝不写 ~/.codex 等 agent 文件）。
//     - 拉模式：检索是「查询」，由调用方显式 POST /retrieve 触发，服务本身不自动向任何 agent 注入知识。
//     - 异常一律 catch → 4xx，不冒泡；写操作（ingest/remove）加 requireAuth，读不强制登录（对齐 skill/memory 读不鉴权）。
//
// 路由面（YAGNI，对齐内核 API）：
//   GET        /api/knowledge        → status（ready/docs/chunks/persisted）
//   GET        /api/knowledge/docs    → 列文档摘要
//   POST   /api/knowledge/retrieve   → 检索 { query, topK?, scope? } → results[]
//   POST /api/knowledge/ingest       → 摄取一篇 { id, title, text, tags?, scope? }（requireAuth）
//   DELETE /api/knowledge/docs/:id    → 删除一篇（requireAuth）

const express = require('express');
const { requireAuth } = require('../lib/auth');
const { KnowledgeBase } = require('../../l2/knowledge-base/knowledge-base.js');

// 单例：默认仅内存；PROXY_KNOWLEDGE_BASE_DIR 才落盘（非侵入，绝不写 home）
let kb = new KnowledgeBase();

const router = express.Router();

// 门控：PROXY_KNOWLEDGE_BASE ∈ {1,true,on} 才放行，其余一律 403（默认零副作用）
function isGatedOpen() {
    const v = String(process.env.PROXY_KNOWLEDGE_BASE || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}
const NOT_OPEN_MSG =
    'PROXY_KNOWLEDGE_BASE 未开启（默认关）→ knowledge-base 路由拒服务；' +
    '开灰度：PROXY_KNOWLEDGE_BASE=1 node server.js（+ PROXY_KNOWLEDGE_BASE_DIR 才落盘）。';

function gate(req, res, next) {
    if (!isGatedOpen()) return res.status(403).json({ error: 'knowledge-gate-closed', hint: NOT_OPEN_MSG });
    next();
}
router.use(gate);

// GET /status → 内核 status()
router.get('/status', (_req, res) => {
    res.json(kb.status());
});

// GET /docs → 列文档摘要
router.get('/docs', (_req, res) => {
    res.json(kb.list());
});

// POST /retrieve → 检索（拉模式：调用方显式调用）
// query: { query, topK?, scope? }
router.post('/retrieve', (req, res) => {
    try {
        const b = req.body || {};
        res.json(kb.retrieve({
            query: b.query,
            topK: b.topK != null ? Number(b.topK) : undefined,
            scope: b.scope,
        }));
    } catch (e) {
        res.status(400).json({ error: 'knowledge-retrieve-failed', message: e.message });
    }
});

// POST /ingest → 摄取一篇（requireAuth，写操作）
// body: { id, title, text, tags?, scope? }
router.post('/ingest', requireAuth, (req, res) => {
    try {
        const b = req.body || {};
        if (!b.id || !b.text) return res.status(400).json({ error: 'knowledge-ingest-failed', message: 'id and text required' });
        const n = kb.ingest({ id: b.id, title: b.title, text: b.text, tags: b.tags, scope: b.scope });
        res.json({ ingested: n, id: b.id });
    } catch (e) {
        res.status(400).json({ error: 'knowledge-ingest-failed', message: e.message });
    }
});

// DELETE /docs/:id → 删除一篇（requireAuth，写操作）
router.delete('/docs/:id', requireAuth, (req, res) => {
    const had = kb.remove(req.params.id);
    res.json({ removed: had, id: req.params.id });
});

// 测试辅助：复位单例（门控关闭/未设 dir 时回退内存空库）
// 注意：必须在 module.exports = router 之后设，否则被覆盖丢失。
module.exports = router;
router._resetForTest = () => { kb = new KnowledgeBase(); };
