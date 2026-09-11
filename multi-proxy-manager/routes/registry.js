// ==================== 路由：L2 Agent Registry（P0 增量 2b） ====================
// 把 l2/agent-registry.js 内核挂到 manager HTTP API（/api/registry/*）。
//
// 设计：
//   - 非侵入：默认内存存储（零副作用，绝不写 home）；仅当显式设 L2_REGISTRY_DIR
//     才落文件，且写到 manager 自己的目录（由调用方负责，绝不写 ~/.codex 等 agent 目录）。
//   - 认证：GET 只读不挂 auth（与 manager 其它 GET 一致）；写操作（POST/PUT/DELETE）挂 requireAuth。
//   - 响应：{success,error} 简洁文案，不暴露堆栈/内部路径（与 manager P0 安全风格一致）。
const express = require('express');

const { requireAuth } = require('../lib/auth');
const { AgentRegistry, newFileStorage } = require('../../l2/agent-registry');

const router = express.Router();

// 存储可注入：默认内存；设 L2_REGISTRY_DIR 才落文件（manager 自己的 dir，非侵入）。
function buildRegistry() {
    const dir = process.env.L2_REGISTRY_DIR;
    if (dir) return new AgentRegistry({ storage: newFileStorage(dir) });
    return new AgentRegistry();
}
const registry = buildRegistry();

// 列表（只读，不挂 auth）
router.get('/agents', (_req, res) => {
    res.json({ agents: registry.list(), count: registry.count() });
});

// 按能力标签查询（必须 before /agents/:id，避免 :id 捕获 'by-capability'）
router.get('/agents/by-capability/:tag', (req, res) => {
    res.json({ agents: registry.byCapability(req.params.tag) });
});

// 单个（只读）
router.get('/agents/:id', (req, res) => {
    try {
        res.json(registry.get(req.params.id));
     } catch (e) {
        res.status(404).json({ success: false, error: e.message });
    }
});

// 创建
router.post('/agents', requireAuth, (req, res) => {
    try {
        const created = registry.create(req.body || {});
        res.status(201).json(created);
     } catch (e) {
        const isDup = /already exists/.test(e.message);
        res.status(isDup ? 409 : 400).json({
            success: false,
            error: isDup ? 'Agent id already exists' : e.message,
         });
    }
});

// 更新（不可改 id）
router.put('/agents/:id', requireAuth, (req, res) => {
    try {
        res.json(registry.update(req.params.id, req.body || {}));
     } catch (e) {
        const nf = /not found/.test(e.message);
        res.status(nf ? 404 : 400).json({ success: false, error: nf ? 'Agent not found' : e.message });
    }
});

// 删除
router.delete('/agents/:id', requireAuth, (req, res) => {
    try {
        registry.remove(req.params.id);
        res.json({ success: true, removed: req.params.id });
     } catch (e) {
        if (/not found/.test(e.message)) {
            return res.status(404).json({ success: false, error: 'Agent not found' });
         }
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
