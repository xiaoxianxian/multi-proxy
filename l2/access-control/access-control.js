'use strict';

// l2/access-control
// G6 权限边界 / RBAC（取自 Paperclip 治理四柱之「RBAC + scoped secrets」）
// 三档模型直接复用 DBX MCP 的语义：read_only / safe_write / high_risk_write
//
// 纪律：默认关（disabled），门控关时 guard 一律放行——接入热路径也零行为变更；
//       开启后默认最严（unknown 操作 / unknown 调用方 → 拒绝），fail-safe。
//
// 落点：给不同调用方（claude / codex / cc-switch …）分权限档，
//       在代理替调用方执行「有副作用的操作」（写成本库、改配置、删 thread、exec 工具…）前先 guard 一道。

const fs = require('fs');

// ── 三档：越往上权限越大（白名单式） ──
const TIERS = ['read_only', 'safe_write', 'high_risk_write'];

const TIER_CAPS = {
  read_only:       ['read'],
  safe_write:      ['read', 'safe_write'],
  high_risk_write: ['read', 'safe_write', 'high_risk_write'],
};

// 操作 → 类别。新增操作默认走 config.defaultCategory（默认 high_risk_write，最严）。
// 调用方只需声明自己要做的操作名，不必关心档位细节。
const DEFAULT_OP_CATEGORY = {
  // read：只读 / 计算类（转发对话、列模型、embedding）
  'chat.completions': 'read',
  'models.list': 'read',
  'embeddings': 'read',
  'savings.read': 'read',
  // safe_write：不破坏现有状态的非危险写（建 thread、追加消息、记录成本）
  'thread.create': 'safe_write',
  'message.append': 'safe_write',
  'savings.record': 'safe_write',
  'config.set': 'safe_write',
  // high_risk_write：可能破坏 / 外泄的写（删、exec、落库写）
  'thread.delete': 'high_risk_write',
  'file.delete': 'high_risk_write',
  'db.write': 'high_risk_write',
  'exec': 'high_risk_write',
};

// 默认调用方档位（fail-safe：谁没显式声明，谁就是最严的 read_only）
const DEFAULT_CALLER_TIERS = {
  'cc-switch': 'read_only', // 第三方上游网关：只许它过只读流量，绝不许它写我们的库
};

const GATE_ENV = 'PROXY_ACCESS_GATE';
const DISABLED_ENV = 'PROXY_ACCESS_DISABLED';

function gateOpen() {
  if (process.env[DISABLED_ENV] != null && process.env[DISABLED_ENV] !== '') return false;
  if (process.env[GATE_ENV] === 'closed') return false;
  return true; // 默认开；但上面 read_only 默认最严，开了也不放行越权操作
}

function loadConfig(opts = {}) {
  const cfg = {
    defaultTier: 'read_only',
    callerTiers: Object.assign({}, DEFAULT_CALLER_TIERS),
    opCategory: Object.assign({}, DEFAULT_OP_CATEGORY),
    defaultCategory: 'high_risk_write', // 未知操作默认最严
    disabled: !gateOpen(),
  };
  // 显式传入（测试 / 内嵌）
  if (opts.config) {
    const c = opts.config;
    if (c.defaultTier && TIERS.includes(c.defaultTier)) cfg.defaultTier = c.defaultTier;
    if (c.callerTiers) Object.assign(cfg.callerTiers, c.callerTiers);
    if (c.opCategory) Object.assign(cfg.opCategory, c.opCategory);
    if (c.defaultCategory) cfg.defaultCategory = c.defaultCategory;
  }
  // env 覆盖
  if (process.env.PROXY_ACCESS_DEFAULT_TIER && TIERS.includes(process.env.PROXY_ACCESS_DEFAULT_TIER)) {
    cfg.defaultTier = process.env.PROXY_ACCESS_DEFAULT_TIER;
  }
  if (process.env.PROXY_ACCESS_CALLER_TIERS) {
    try {
      const map = JSON.parse(process.env.PROXY_ACCESS_CALLER_TIERS);
      for (const [k, v] of Object.entries(map)) if (TIERS.includes(v)) cfg.callerTiers[k] = v;
    } catch (_) { /* 解析失败保持默认，不抛 */ }
  }
  return cfg;
}

function createAccessControl(opts = {}) {
  const cfg = loadConfig(opts);

  function tierOf(caller) {
    return cfg.callerTiers[caller] || cfg.defaultTier;
  }
  function categoryOf(operation) {
    return cfg.opCategory[operation] || cfg.defaultCategory;
  }

  // 核心守卫：调用方要做 operation，是否被其档位允许
  function guard(operation, guardOpts = {}) {
    const caller = guardOpts.caller || 'anonymous';
    if (cfg.disabled) {
      return { allowed: true, caller, tier: tierOf(caller), operation, category: categoryOf(operation), disabled: true, reason: null };
    }
    const tier = tierOf(caller);
    const category = categoryOf(operation);
    const allowed = TIER_CAPS[tier].includes(category);
    return {
      allowed,
      caller,
      tier,
      operation,
      category,
      disabled: false,
      reason: allowed ? null : `tier "${tier}" 不允许类别 "${category}"（操作 "${operation}"）`,
    };
  }

  // 批量预检一组操作，返回首个被拒项（全过返回 null）
  function guardAll(operations, guardOpts = {}) {
    for (const op of operations) {
      const r = guard(op, guardOpts);
      if (!r.allowed) return r;
    }
    return null;
  }

  function report() {
    return {
      module: 'access-control',
      disabled: cfg.disabled,
      defaultTier: cfg.defaultTier,
      defaultCategory: cfg.defaultCategory,
      tiers: TIERS,
      callerTiers: cfg.callerTiers,
      gateOpen: gateOpen(),
    };
  }

  return { guard, guardAll, tierOf, categoryOf, report, _config: cfg };
}

module.exports = { createAccessControl, TIERS, TIER_CAPS, DEFAULT_OP_CATEGORY, DEFAULT_CALLER_TIERS };
