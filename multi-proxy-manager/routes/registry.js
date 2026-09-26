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
// L2 热路径 Step 1：进程级共享单例，消除 registry 分裂（P2-1）。
// seedDefaultProfiles 幂等（mcp-default-seed.js:47 已存在的 id 跳过），
// 仅在 count()===0 时执行一次，与 mcp.js / gateway.js 共用同一 seed 来源。
let _shared = null;
function getSharedRegistry() {
    if (!_shared) {
        const dir = process.env.L2_REGISTRY_DIR;
        _shared = dir
            ? new AgentRegistry({ storage: newFileStorage(dir) })
            : new AgentRegistry();
        if (_shared.count() === 0) {
            const { seedDefaultProfiles } = require('../../l2/mcp-default-seed.js');
            seedDefaultProfiles(_shared);
        }
    }
    return _shared;
}
// 测试隔离钩子
function _resetSharedRegistry() { _shared = null; }

// CRUD 路由仍引用共享单例，与 MCP bridge 面看到同一份 agent
const registry = getSharedRegistry();

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
// Step 1：把共享单例访问器作为命名属性挂到同一导出对象，
// 让 routes/mcp.js 能注入同一份 registry（消除 registry 分裂 P2-1）。
// router 仍是默认导出，app.use('/api/registry', router) 不变。
module.exports.getSharedRegistry = getSharedRegistry;
module.exports._resetSharedRegistry = _resetSharedRegistry;
