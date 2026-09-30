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
//   /run 支持 per-call 质量层：body.quality=true（+ qualityThrow=true 硬拒）；
//   等价 env  gate：PROXY_L2_QUALITY=1。默认关 → 与既有行为逐字一致。

const express = require('express');
const router = express.Router();
const { Orchestrator } = require('../../l2/orchestrator.js');
const { decompose } = require('../../l2/decomposer.js');
const { makeLlmDecomposer } = require('../../l2/llm-decomposer.js');

// 质量层（2.2 需候选信息）的共享 RouteEngine：与 routes/registry.js 共用**同一份** process 级
// registry 单例（避免 registry 分裂 P2-1）。惰性构造：默认关时不 require、不建对象（零副作用）。
let _routeEngine = null;
function getRouteEngine() {
  if (!_routeEngine) {
    const { RouteEngine } = require('../../l2/route-engine.js');
    const { getSharedRegistry } = require('./registry.js');
    _routeEngine = new RouteEngine({ registry: getSharedRegistry(), shadowMode: true });
  }
  return _routeEngine;
}

// 质量层开关（与 MCP 入口 l2/mcp-server.js 同一套纪律）：
//   env PROXY_L2_QUALITY=1 或 per-call body.quality===true 才启用 2.2/2.3；
//   默认关 → Orchestrator 构造/行为与既有逐字一致（零行为变更铁律）。
function isQualityGateOpen() {
  const v = String(process.env.PROXY_L2_QUALITY || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// 把质量层开关落到单例 Orchestrator 上（单例要保证协作历史跨请求累积，故按请求改开关而非重建）。
//   开：挂共享 routeEngine + 2.2/2.3 开关，并在跑之前清空上轮诊断（避免单例跨请求串味）。
//   关：全部复位为 false + routeEngine=undefined —— 与构造默认值一致，逐字零行为变更。
function applyQuality(orch, on, shouldThrow) {
  if (on) {
    orch.routeEngine = getRouteEngine();   // 仅此时挂载：默认不挂时 shadow 产物不含 routedVia 等差异
    orch.semanticReview = true;
    orch.semanticThrow = !!shouldThrow;
    orch.fidelityCheck = true;
    orch.fidelityThrow = !!shouldThrow;
    orch._semanticIssues = [];
    orch._fidelityIssues = [];
  } else {
    orch.semanticReview = false;
    orch.semanticThrow = false;
    orch.fidelityCheck = false;
    orch.fidelityThrow = false;
  }
  return on;
}

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

// 门控：PROXY_LLM_DECOMPOSE ∈ {1,true,on} 才用 LLM 拆解，缺省关 → 走内置模板拆解。
//    LLM 拆解仅发生在 shadow 前置（纯数据、不触真实 adapter），任何失败已在 makeLlmDecomposer 内
//    降级回 templateDecompose，故关/开都不破坏热路径；默认关 = 零 LLM 依赖、确定可复现。
function isLlmDecomposeOpen() {
  const v = String(process.env.PROXY_LLM_DECOMPOSE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// LLM 拆解连接配置（全部来自 env，缺省走内核默认 127.0.0.1:11434）
function buildLlmCfg() {
  return {
    baseUrl: process.env.PROXY_LLM_BASE_URL || undefined,
    model: process.env.PROXY_LLM_MODEL || undefined,
    token: process.env.PROXY_LLM_TOKEN || undefined,
    timeoutMs: process.env.PROXY_LLM_TIMEOUT_MS ? Number(process.env.PROXY_LLM_TIMEOUT_MS) : undefined,
  };
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
  // 质量层：env PROXY_L2_QUALITY=1 或 per-call quality:true 才开（默认关，零行为变更）
  const qualityOn = isQualityGateOpen() || reqBody.quality === true;
  try {
    const orch = getOrchestrator();
    orch.setShadowMode(shadowMode);
    applyQuality(orch, qualityOn, reqBody.qualityThrow === true);
    let result;
    if (dag && Array.isArray(dag.subtasks) && dag.subtasks.length > 0) {
       // 直供 DAG（跳过拆解，便于测试 + 高级用法）
      result = await orch.run(dag, { maxRetries, ctx: reqBody.ctx });
     } else if (typeof input === 'string' && input.length > 0) {
       if (isLlmDecomposeOpen()) {
        // LLM 拆解（PROXY_LLM_DECOMPOSE 开）：内核内已带失败降级，恒产出合法 DAG →
        // 走「直供 DAG」同一路径，不触碰单例的 shadow/历史语义。
        const llmDecompose = makeLlmDecomposer(buildLlmCfg());
        result = await orch.run(await llmDecompose(input, { input }), { maxRetries, ctx: reqBody.ctx });
       } else {
        // 默认：内置模板拆解（确定性、零 LLM 依赖）
        result = await orch.runFromInput(input, { maxRetries, ctx: reqBody.ctx });
       }
     } else {
      return res.status(400).json({ error: 'orchestration-no-input', hint: 'body 须提供 input 或 dag' });
    }
    const payload = {
      runId: result.history ? result.history.runId : null,
      template: result.history ? result.history.template : null,
      shadowMode,
      subtasks: result.history ? result.history.subtasks : [],
      results: Object.values(result.results || {}).map((r) => ({ id: r.id, status: r.status })),
    };
    // 质量层观测 sidecar：仅开启时附加（默认关 → 响应与既有逐字一致，零行为变更）
    if (qualityOn) {
      payload.quality = {
        semanticIssues: orch._semanticIssues || [],   // 2.2 语义审阅：某 type 无候选 / 模态不匹配
        fidelityIssues: orch._fidelityIssues || [],   // 2.3 执行保真：透传字段被改样
      };
    }
    res.json(payload);
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
