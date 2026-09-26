'use strict';

// prompt-cache 内核（P0 PoC · 03-token-control-plane.md §5 P0）
//
// 目标：给 multi-proxy 引入「prompt-cache 断点管理」的最初可验证层。
// 核心机制：前缀哈希 → 命中/未命中计数 → 报告 cacheHitRate。
//
// 设计（与 l2/ 非侵入铁律完全对齐）：
//   ① 门控 PROXY_PROMPT_CACHE 默认 0 = observe（决策/计数进内存、绝不落盘）；
//      开（=1/true/on）= 可落盘（预留，一期不实现落盘路径）。
//   ② 不写 agent 配置、不碰 launchd、不碰 forward.js/proxy.js 热路径。
//   ③ 内核自包含：不 require '../lib/*'、不 require server.js 任何路由。
//   ④ 注入缝：executor 预留供二期接真实上游 cache_control 标记注入。
//
// 前缀哈希设计：
//   请求上下文 = [systemPrompt, toolSchemas, messages[0:N]]
//   稳定前缀（cache key）= systemPrompt + toolSchemas + messages[0]
//   变动部分（不计入 key）= messages[1:] （每次新 user 消息）
//   命中规则：相同前缀 → cache hit；新前缀 → cache miss + 注册断点
//
// 缓存键计算：
//   hashInput = JSON.stringify({ sp: systemPrompt, ts: toolSchemas, m0: messages[0] })
//   hashKey   = crc32(hashInput)   ← 确定性 32 位哈希（无外部依赖，纯 JS）
//
// 一期边界（PoC 诚实声明）：
//   - 只做内存计数 + 决策报告（cacheHitRate/estimatedTokensSaved/cacheBreakpoints）。
//   - 不真注入 cache_control 到 upstream request（二期 executor 缝预留）。
//   - 不真省 token（省 token 是上游 API 的事，PoC 只证明机制逻辑正确）。
//   - 不接入任何现有 HTTP 路由（零热路径触碰）。
//
// 数字诚实：cacheHitRate 是「机制内模拟计算」，非实测 upstream API 返回值；
//  03 文档的 "cacheHit 28.7%" 是设计目标，本 PoC 从 0 建立基线。

const GATE_ENV = 'PROXY_PROMPT_CACHE';

// ---- 门控函数（默认 off）----
function gateOpen() {
  const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// ---- CRC32 纯 JS 实现（确定性，无外部依赖）----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(str) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) {
    crc = CRC_TABLE[(crc ^ str.charCodeAt(i)) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---- 前缀哈希输入构建 ----
// systemPrompt: string（可为 null/undefined）
// toolSchemas:  数组（tool definitions，可为 undefined）
// messages:    数组（OpenAI 格式 [{role, content, ...}]）
// 稳定前缀 = systemPrompt + toolSchemas + messages[0]（first message 固定）
// 变动部分 = messages[1:] 不影响 cache key
function buildPrefixKey(systemPrompt, toolSchemas, messages) {
  const sp = systemPrompt || '';
  const ts = Array.isArray(toolSchemas) ? JSON.stringify(toolSchemas) : '';
  const m0  = (Array.isArray(messages) && messages.length > 0)
        ? JSON.stringify(messages[0]) : '';
  return crc32(`sp:${sp}|ts:${ts}|m0:${m0}`);
}

// ---- 估算 tokens（与 savings-gateway 一致：CJK 3 字符 ≈ 1 token）----
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}

function estimateAssemblyTokens(systemPrompt, toolSchemas, messages) {
  let chars = 0;
  if (systemPrompt && typeof systemPrompt === 'string') chars += systemPrompt.length;
  if (Array.isArray(toolSchemas)) {
    for (const t of toolSchemas) {
      chars += JSON.stringify(t).length;
    }
  }
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const c = m && m.content;
      if (typeof c === 'string') chars += c.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 3));
}

// ---- 工厂：每实例独立 store（测试隔离）----
function createPromptCache(opts = {}) {
  // 断点注册表：key → { firstTs, lastTs, hitCount, missCount, prefixTokens, estTokensSaved }
  const breakPoints = new Map();
  const history = []; // 环形裁剪，最大 historyCapacity
  const historyCapacity = Number.isFinite(opts.historyCapacity) ? opts.historyCapacity : 1000;
  // 门控开 = 可落盘（一期不实现，预留）；关 = observe（默认）
  const gate = typeof opts.gate === 'boolean' ? opts.gate : gateOpen();

  // 注册 / 查询一次请求的 cache 状态
  // 入参：{ systemPrompt, toolSchemas, messages, now? }
  // 返回：{ cacheKey, hit, breakpoint, estTokensSaved, estTokensUsed }
  function record(req = {}, io = {}) {
    const { systemPrompt, toolSchemas, messages } = req;
    const now = io.now != null ? io.now : Date.now();
    const key = buildPrefixKey(systemPrompt, toolSchemas, messages);
    const prefixTokens = estimateAssemblyTokens(systemPrompt, toolSchemas, messages);
    let bp = breakPoints.get(key);
    const hit  = bp != null;
    if (!bp) {
      // cache miss：注册新断点
      bp = {
        cacheKey: key,
        firstTs: now,
        lastTs: now,
        hitCount: 0,
        missCount: 1,
        prefixTokens,
        estTokensSaved: 0,
      };
      breakPoints.set(key, bp);
    } else {
      // cache hit：计数 +
      bp.hitCount++;
      bp.lastTs = now;
      // 估算节省：本次 prefix tokens 命中，省掉重发的成本
      // （一期模拟：命中时 prefix 不重新计费，节省 = 0.9 * prefixTokens * per-token-rate）
      //  实际节省率由上游 API 决定，此处用 0.9（03 文档的 cache_control 9 折）
      bp.estTokensSaved += Math.round(prefixTokens * 0.9);
    }

    const entry = {
      ts: now,
      cacheKey: key,
      hit,
      prefixTokens,
      estTokensUsed: prefixTokens,  // 一期全量重发基线 token；命中时不重新计费
      estTokensSaved: hit ? bp.estTokensSaved : 0,
    };
    history.push(entry);
    if (history.length > historyCapacity) {
      history.splice(0, history.length - historyCapacity);
    }
    return {
      cacheKey: key,
      hit,
      breakpoint: bp,
      estTokensUsed: prefixTokens,
      estTokensSaved: entry.estTokensSaved,
    };
  }

  // 报告（窗口内 cacheHitRate + 累计 token 节省）
  function report(windowMs) {
    const cutoff = (windowMs != null && Number.isFinite(windowMs))
      ? (history.length ? Math.max(...history.map((e) => e.ts)) : 0) - windowMs
      : 0;
    const rows = windowMs != null ? history.filter((e) => e.ts >= cutoff) : history;
    let totalHits = 0, totalMisses = 0, totalTokensSaved = 0, totalTokensUsed = 0;
    for (const e of rows) {
      if (e.hit) totalHits += 1; else totalMisses += 1;
      totalTokensSaved += e.estTokensSaved;
      totalTokensUsed += e.estTokensUsed;
    }
    const total = totalHits + totalMisses;
    const cacheHitRate = total > 0 ? totalHits / total : 0;
    return {
      windowMs,
      requestCount: total,
      cacheHits: totalHits,
      cacheMisses: totalMisses,
      cacheHitRate: Math.round(cacheHitRate * 10000) / 100, // 百分比如 45.5
      totalEstTokensUsed: totalTokensUsed,
      totalEstTokensSaved: totalTokensSaved,
      breakPointCount: breakPoints.size,
      gate,
    };
  }

  // 断点列表（供路由/调试用）
  function listBreakPoints() {
    return Array.from(breakPoints.values()).sort((a, b) => b.hitCount - a.hitCount);
  }

  // 门控状态查询
  function isGateOpen() { return gate; }

  return {
    record,
    report,
    listBreakPoints,
    isGateOpen,
    getBreakPointCount: () => breakPoints.size,
    getHistory: () => history.slice(),
    _breakPoints: breakPoints,
  };
}

// ---- 模块级单例（持久 store）----
const _cache = createPromptCache();

module.exports = {
  GATE_ENV,
  gateOpen,
  crc32,
  buildPrefixKey,
  estimateTokens,
  estimateAssemblyTokens,
  createPromptCache,
  // 单例转发
  record: _cache.record,
  report: _cache.report,
  listBreakPoints: _cache.listBreakPoints,
  isGateOpen: _cache.isGateOpen,
  getBreakPointCount: _cache.getBreakPointCount,
};
