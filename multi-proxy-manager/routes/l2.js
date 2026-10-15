// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).

// ==================== 路由：L2 影子能力可视化（只读 · 零下游） ====================
//
// GET /api/l2/shadow-map
//   在 shadow 姿态下，用 seed 出来的 Agent Registry 枚举每种「能力标签」会被路由到哪个
//   adapter（纯 route() 计算，不触发任何下游 adapter、不联网、不写盘）。
//   这正是 l2/observe-shadow-run.js 那张 capability 表的来源——把它固化成可随时拉取的端点，
//   让 dashboard「影子模式」页能把 L2 的影子能力变成可见卖点。
//
// 设计纪律：
//   - 纯只读：route() 在 shadowMode:true 下只做决策计算，不发请求、不触 executor。
//   - 懒 require：l2 模块仅在首次请求时加载，且全部包在 try/catch——l2 若因环境缺依赖无法
//     加载，端点返回 200 + {available:false} 而非拖垮 manager（L2 仍是旁路，不进热路径）。
//   - 不修改任何模块行为（与 L2 非侵入铁律一致）。

const express = require('express');
const router = express.Router();

let cached = null; // 极轻量缓存：seed 是纯函数且昂贵度低，但避免每次刷新都重算

router.get('/shadow-map', (_req, res) => {
  if (cached) { res.json(cached); return; }
  try {
    // 懒加载 l2（与 observe-shadow-run.js 同款调用）
    const { AgentRegistry } = require('../../l2/agent-registry.js');
    const { PluginRuntime } = require('../../l2/plugin-runtime.js');
    const { RouteEngine } = require('../../l2/route-engine.js');
    const { seedDefaultProfiles } = require('../../l2/mcp-default-seed.js');
    const { resolveNoCandidatePolicy } = require('../../l2/knowledge-base/routing-base.js');

    const policy = resolveNoCandidatePolicy();

    const registry = new AgentRegistry();
    seedDefaultProfiles(registry);

    const routeEngine = new RouteEngine({
      registry,
      pluginRuntime: new PluginRuntime({ logger: { log: () => {} } }),
      shadowMode: true,
    });

    // 收集所有能力标签
    const tagSet = new Set();
    for (const p of registry.list()) (p.capabilityTags || []).forEach((t) => tagSet.add(t));

    const capabilities = [];
    const gaps = [];
    for (const type of Array.from(tagSet).sort()) {
      // 候选 adapter（拥有该 tag 的 profile）
      const candidates = registry.list()
        .filter((p) => (p.capabilityTags || []).includes(type))
        .map((p) => ({ profileId: p.id, adapterId: p.adapterId, modelTier: p.modelTier || null, modelType: p.modelType || null }));

      let decision = null;
      let routeError = null;
      try {
        decision = routeEngine.route({ id: `shadow-${type}`, type, complexity: 'medium', prompt: type });
      } catch (e) {
        routeError = e && e.message || String(e);
      }

      const chosen = decision && decision.chosen && decision.chosen.adapterId || null;
      const noCandidate = !!(decision && decision.noCandidate);
      const rejected = !!(decision && decision.rejected);
      const expectedTier = decision && decision.expectedTier || null;

      if (noCandidate) gaps.push(type);

      capabilities.push({ type, chosen, noCandidate, rejected, expectedTier, routeError, candidates });
    }

    cached = {
      available: true,
      shadowMode: true,
      policy: policy.strategy,
      generatedAt: new Date().toISOString(),
      capabilityCount: capabilities.length,
      gapCount: gaps.length,
      gaps,
      capabilities,
    };
    res.json(cached);
  } catch (e) {
    res.json({ available: false, error: e && e.message || String(e), generatedAt: new Date().toISOString() });
  }
});

module.exports = router;
