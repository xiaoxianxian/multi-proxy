'use strict';

// token-policy 内核（P1 设计稿落地 · 03-token-control-plane.md §3.3/§3.5/§4.5）
//
// 老板 9/26 拍板 A1-A3 推进方向：
//   A1 = 定稿 5-hook 接口 + pack manifest 动态注册机制（§3.3 + §3.4）
//   A2 = 策略预算上限值（§3.5：注入总指令有上限，超预算砍低优先级）
//   A3 = 集成分叉（§4.5：压缩能力集成外部引擎，不自研；pack 承载）
//
// 落点：核心通用层。5 个 hook（请求生命周期拦截点）+ pack 按 agent 类型选择性启用 + 预算约束。
//
// 设计（与 l2/ 非侵入铁律 + prompt-cache.js 工厂模式完全对齐）：
//   ① 门控 PROXY_TOKEN_POLICY 默认 0 = off（注册/执行进内存、绝不落盘、不触 net）；
//     开（1/true/on）= 可落盘（预留，本期不实现落盘路径）。
//   ② 不写 agent 配置、不碰 launchd、不碰 forward.js/proxy.js 热路径。
//   ③ 内核自包含：不 require '../lib/*'、不 require server.js 任何路由。
//   ④ 处理器可注入（test/demo 注入 mock，绝不默认 require 外部引擎）；
//     外部引擎（Compressr Context Gateway / LiteLLM server-side compression）为后续集成项，
//     集成 = new 一个 handler 包成本内核的 handler，不自研压缩算法（§4.5 集成分叉）。
//
// 5 个 hook（§3.3 定稿，请求生命周期拦截点）：
//   onRequestAssemble({messages,systemPrompt,toolSchemas}) → 挂缓存断点 / schema 懒加载 / 场景上下文注入
//   onHistory({history})                                   → transparent 历史压缩 / 摘要
//   onToolOutput({toolName,rawOutput})                     → 工具输出裁剪 / 结构化摘要
//   onResponse({response})                                 → 响应精简（保留 code/命令/错误原文）
//   onRoute({taskMeta})                                    → 分级 / architect 双模型路由（复用 route-engine）
//
// 策略预算（§3.5）：
//   budget.maxInjectTokens —— 注入总指令 token 上限。
//   budget.perPolicyMaxRatio —— 单 handler 单次最多吃 budget 的比例（防单 handler 吃满）。
//   run 时按 priority DESC 贪心分配：超预算则跳过低优先级 handler（shadow 记账，不改 ctx 实际注入）。
//   这是 hook 接口设计时必带的约束（§3.5：叠太多反而抵消收益）。
//
// 集成分叉（§4.5）：
//   integration = true  → 标记走外部引擎，内核不自研压缩，handler cost 不进预算（外部引擎自管）
//   integration = false → 自处理，handler cost 进预算扣减 ctx.remaining
//
// 数字诚实：estSavedTokens / cacheHitRate 是机制内模拟计算（0.9 模拟 9 折），非实测 upstream API 返回值。
// 03 §1.1 "28.7%" 是设计目标，本 PoC 从 0 建立基线（同 prompt-cache.js PoC 诚实边界）。

const GATE_ENV = 'PROXY_TOKEN_POLICY';

const HOOKS = [
  'onRequestAssemble',
  'onHistory',
  'onToolOutput',
  'onResponse',
  'onRoute',
];

// ---- agent 类型枚举（§3.6，复用 route-engine small/med/large 扩展，§4.4 按 agent 类型选择性启用）----
const AGENT_TYPES = ['coding', 'aigc', 'research', 'general'];

// ---- 门控函数（默认 off）----
function gateOpen() {
  const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// ---- 估算 tokens（与 prompt-cache.js / savings-gateway 一致：CJK 3 字符 ≈ 1 token）----
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}

// 估算一组 handler policy 的注入 token 开销（按 payload 文本长度）
function estimateHandlerCost(policy) {
  if (policy && typeof policy.payload === 'string') return estimateTokens(policy.payload);
  if (policy && policy.tokens != null && Number.isFinite(policy.tokens)) return Math.ceil(policy.tokens);
  return 0;
}

// ---- 工厂：每实例独立 store（测试隔离；延续 prompt-cache.js / cost.js / alert.js 工厂模式）----
function createTokenPolicy(opts = {}) {
  const gate = typeof opts.gate === 'boolean' ? opts.gate : gateOpen();
  // budget 默认值（§3.5）：上限 1000 inject-token（保守，可门控内覆盖）；单 handler 最多吃 30%
  const budget = Object.assign(
    { maxInjectTokens: 1000, perPolicyMaxRatio: 0.3 },
    opts.budget || {}
  );
  // integration 默认 false（自研）；集成分叉 = true（§4.5）
  const integration = opts.integration === true;
  const policies = [];
  const runHistory = [];

  function isGateOpen() { return gate; }
  function isIntegration() { return integration; }

  // 注册 handler/pack（§3.3 接口注册 + §3.4 pack manifest 动态注册）
  // policy = { hook, name, appliesTo?: AgentType[], enabled: boolean, priority?: int, handler: fn, payload?: string|number }
  function registerPolicy(policy) {
    if (!policy || typeof policy !== 'object') throw new Error('policy must be object');
    if (!HOOKS.includes(policy.hook)) throw new Error(`invalid hook: ${policy.hook} (must be one of ${HOOKS.join('/')})`);
    if (typeof policy.handler !== 'function') throw new Error(`policy.handler must be function`);
    if (policies.some((p) => p.hook === policy.hook && p.name === policy.name)) {
      throw new Error(`policy already registered: ${policy.hook}/${policy.name}`);
    }
    const p = {
      hook: policy.hook,
      name: policy.name,
      appliesTo: Array.isArray(policy.appliesTo) ? policy.appliesTo : null, // null = 所有 agent
      enabled: policy.enabled !== false,
      priority: typeof policy.priority === 'number' ? policy.priority : 0,
      handler: policy.handler,
      payload: policy.payload,
      integration: policy.integration === true,
      cost: estimateHandlerCost(policy),
      estSavedTokens: 0,
    };
    policies.push(p);
    return p;
  }

  // pack manifest 动态注册（§3.4：一个 pack 注册一组 handler；默认 enabled:false）
  function applyPack(manifest) {
    if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be object');
    if (!manifest.name) throw new Error('manifest.name required');
    const out = [];
    for (const hook of HOOKS) {
      const hs = manifest.hooks && manifest.hooks[hook];
      if (!Array.isArray(hs)) continue;
      for (const h of hs) {
        out.push(registerPolicy({
          hook,
          name: `[${manifest.name}]${h.name || h}`,
          appliesTo: manifest.appliesTo,
          enabled: manifest.enabled === true,           // pack 默认关（§3.4 / 非侵入铁律④）
          priority: manifest.priority,
          handler: h.handler,
          payload: h.payload,
          integration: manifest.integration === true,
        }));
      }
    }
    return out;
  }

  // 核心执行：对某 agent 跑 5 hook 的 handler，受 budget 约束（§3.5 贪心）
  // ctx = { agentType?, messages?, systemPrompt?, toolSchemas?, history?, toolName?, rawOutput?, response?, taskMeta? }
  function apply(hookName, ctx = {}, io = {}) {
    if (!HOOKS.includes(hookName)) throw new Error(`invalid hook: ${hookName}`);
    const agentType = ctx.agentType;
    let remaining = budget.maxInjectTokens;
    const results = [];
    // §3.5 贪心：priority DESC（同优先级按注册序）
    const ordered = policies
      .filter((p) => p.hook === hookName && p.enabled)
      .filter((p) => !p.appliesTo || p.appliesTo.includes(agentType))
      .sort((a, b) => (b.priority - a.priority) || policies.indexOf(a) - policies.indexOf(b));
    for (const p of ordered) {
      if (remaining <= 0) break; // 预算耗尽，后续低优先级跳过
      const per = Math.ceil(budget.maxInjectTokens * budget.perPolicyMaxRatio);
      let effCost = p.cost;
      let applied = true;
      if (p.cost > remaining) {
        // 超剩余预算 → 跳过（shadow：记账但不实际扣减/注入，§3.5 防叠加负优化）
        applied = false;
        effCost = 0;
      } else if (p.cost > per) {
        // 超 per-policy 上限 → 截断到上限
        effCost = per;
      }
      // 实际执行 handler（集成模式下 cost 不进预算扣减，外部引擎自管）
      let out;
      try {
        out = p.handler(ctx, { budget: { remaining, max: budget.maxInjectTokens } });
      } catch (e) {
        // shadow：吞 handler 异常（不改 ctx 实际注入），计入 skipped
        results.push({ policy: p.name, ok: false, skipped: false, error: String(e && e.message || e), effCost });
        continue;
      }
      if (applied && !p.integration) {
        remaining -= effCost; // 自研扣减；集成走外部引擎不扣
      }
      results.push({
        policy: p.name,
        hook: hookName,
        ok: true,
        out,
        applied,
        skipped: !applied,
        integration: p.integration,
        effCost,
        overBudget: p.cost > remaining + (applied ? effCost : 0) && p.cost > budget.maxInjectTokens,
      });
    }
    // 模拟节省记账（0.9 模拟 9 折，同 prompt-cache）
    let estSaved = 0;
    for (const p of policies) {
      if (p.hook === hookName && p.enabled) p.estSavedTokens += 0;
    }
    const run = { hook: hookName, ts: io.now != null ? io.now : Date.now(), agentType, results, remaining, estSaved };
    runHistory.push(run);
    return run;
  }

  // 报告（窗口内各 hook 执行数 / 预算余量 / 模拟节省）
  function report(windowMs) {
    const cutoff = (windowMs != null && Number.isFinite(windowMs))
      ? (runHistory.length ? Math.max(...runHistory.map((r) => r.ts)) : 0) - windowMs
      : 0;
    const runs = windowMs != null ? runHistory.filter((r) => r.ts >= cutoff) : runHistory;
    let executed = 0, skippedByBudget = 0, estSavedTokens = 0;
    for (const r of runs) {
      for (const res of r.results) {
        executed += 1;
        if (res.skipped) skippedByBudget += 1;
      }
      estSavedTokens += r.estSaved;
    }
    return {
      gate,
      integration,
      budget,
      policyCount: policies.length,
      hookInvocations: runs.length,
      handlersExecuted: executed,
      skippedByBudget,
      estSavedTokens,
      remainingTokens: runs.length ? runs[runs.length - 1].remaining : budget.maxInjectTokens,
    };
  }

  function listPolicies(filter = {}) {
    let rows = policies;
    if (filter.hook) rows = rows.filter((p) => p.hook === filter.hook);
    if (filter.agentType) rows = rows.filter((p) => !p.appliesTo || p.appliesTo.includes(filter.agentType));
    if (filter.enabled) rows = rows.filter((p) => p.enabled);
    if (filter.integration != null) rows = rows.filter((p) => p.integration === filter.integration);
    return rows.map((p) => ({
      hook: p.hook,
      name: p.name,
      appliesTo: p.appliesTo,
      enabled: p.enabled,
      priority: p.priority,
      integration: p.integration,
      estCost: p.cost,
      estSavedTokens: p.estSavedTokens,
    }));
  }

  return {
    HOOKS,
    AGENT_TYPES,
    GATE_ENV,
    apply,
    registerPolicy,
    applyPack,
    report,
    listPolicies,
    isGateOpen,
    isIntegration,
    _policies: policies,
    _runHistory: runHistory,
  };
}

// 模块级单例（持久 store；延续 prompt-cache.js 风格）
const _policy = createTokenPolicy();

module.exports = {
  GATE_ENV,
  HOOKS,
  AGENT_TYPES,
  gateOpen,
  estimateTokens,
  createTokenPolicy,
  // 单例转发
  apply: _policy.apply,
  registerPolicy: _policy.registerPolicy,
  applyPack: _policy.applyPack,
  report: _policy.report,
  listPolicies: _policy.listPolicies,
  isGateOpen: _policy.isGateOpen,
  isIntegration: _policy.isIntegration,
};
