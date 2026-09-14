'use strict';

// L2 P2 · 编排引擎 → 生产接线：/api/orchestration 把 orchestrator+decomposer
// 接上 manager 真实链路。镜像 registry/sessions 挂载风格，挂在代理 wildcard 之前。
//
// 设计（与 D6-a/D6-b 门控同风格）：
//    - 门控 PROXY_ORCHESTRATION 默认 0（关）→ 403，热路径零副作用；=1 才放行。
//    - 长寿命 module-level 单例 Orchestrator：协作历史跨请求累积才有意义。
//    - shadowMode 默认 true：非侵入，不触碰真实 adapter。
//    - 异常一律 catch → 4xx，不冒泡污染 manager 主进程。
//
// 路由面（最小，YAGNI）：
//   GET  /api/orchestration        → 协作历史
//   POST /api/orchestration/run    → 触发一次编排（input 拆解 或 dag 直供）
//   POST /api/orchestration/shadow → 开关 shadowMode

const express = require('express');
const router = express.Router();
const { Orchestrator } = require('../../l2/orchestrator.js');
const { decompose } = require('../../l2/decomposer.js');

// 长寿命单例：协作历史内存态累积（重启即失；持久化留 P3 dir 落盘）
let _orchestrator = null;
function getOrchestrator() {
  if (!_orchestrator) {
    _orchestrator = new Orchestrator({
      // 默认 shadow：不注入 executor/routeEngine，shadow 下不被调用（零副作用）
      shadowMode: true,
      dir: null,
      decomposer: async (input, opts = {}) => decompose(input, { ...opts, input }),
    });
  }
  return _orchestrator;
}

// 门控：PROXY_ORCHESTRATION ∈ {1,true,on} 才放行，其余一律拒（默认零副作用）
function isGatedOpen() {
  const v = String(process.env.PROXY_ORCHESTRATION || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const NOT_OPEN_MSG =
  'PROXY_ORCHESTRATION 未开启（默认关）→ 编排路由拒服务；' +
  '开灰度：PROXY_ORCHESTRATION=1 node server.js。';

// ---- 门控中间件 ----
function gate(req, res, next) {
  if (!isGatedOpen()) return res.status(403).json({ error: 'orchestration-gate-closed', hint: NOT_OPEN_MSG });
  next();
}
router.use(gate);

// GET / → 协作历史
router.get('/', (req, res) => {
  try {
    const list = getOrchestrator().getHistory() || [];
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'orchestration-history-failed', message: e.message });
  }
});

// POST /run → 触发一次编排
router.post('/run', async (req, res) => {
  const reqBody = (req.body || {});
  const input = reqBody.input;
  const dag = reqBody.dag;
  const shadowMode = reqBody.shadowMode === undefined ? true : !!reqBody.shadowMode;
  const maxRetries = reqBody.maxRetries != null ? Number(reqBody.maxRetries) : undefined;
  try {
    const orch = getOrchestrator();
    orch.setShadowMode(shadowMode);
    let result;
    if (dag && Array.isArray(dag.subtasks) && dag.subtasks.length > 0) {
      // 直供 DAG（跳过拆解，便于测试 + 高级用法）
      result = await orch.run(dag, { maxRetries, ctx: reqBody.ctx });
    } else if (typeof input === 'string' && input.length > 0) {
      // 从原始输入拆解（用单例已注入的 decomposer）
      result = await orch.runFromInput(input, { maxRetries, ctx: reqBody.ctx });
    } else {
      return res.status(400).json({ error: 'orchestration-no-input', hint: 'body 须提供 input 或 dag' });
    }
    res.json({
      runId: result.history ? result.history.runId : null,
      template: result.history ? result.history.template : null,
      shadowMode,
      subtasks: result.history ? result.history.subtasks : [],
      results: Object.values(result.results || {}).map((r) => ({ id: r.id, status: r.status })),
    });
  } catch (e) {
    // 环 / 调度不收敛 / 拆解异常：转 400，不冒泡
    res.status(400).json({ error: 'orchestration-run-failed', message: e.message });
  }
});

// POST /shadow → 开关 shadowMode
router.post('/shadow', (req, res) => {
  const body = (req.body || {});
  if (body.shadow === undefined) {
    const current = getOrchestrator().shadowMode;
    return res.json({ shadowMode: current });
  }
  getOrchestrator().setShadowMode(!!body.shadow);
  res.json({ shadowMode: !!body.shadow });
});

module.exports = router;

// 测试辅助（不暴露到路由，仅供单测重置单例验证长寿命语义）
module.exports._resetForTest = () => { _orchestrator = null; };
