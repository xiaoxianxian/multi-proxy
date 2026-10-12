// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== 预算预检（codex-proxy/budget-check.js，P7-2）====================
// 目的：在 proxy 热路径（转发上游之前）前置一道**预算闸门**——一次请求最坏情况
// 要烧多少钱，超了当周期剩额就 429 挡掉，别等 manager 事后告警才停。
//
// 三态降级（用户 2026-10-12 拍板）：manager 是被守护的对象，却住在没守护的进程里
// （codex-proxy 有 launchd KeepAlive，manager 只有手动 manage.sh）。所以「manager
// 挂了就拒绝所有请求」会把被守护的 proxy 也拖死（架构倒挂）。三态：
//   exact    —— manager 可达：问它 /api/budget 拿精确剩额，按价表估最坏情况比对。
//   degraded —— manager 不可达 + 本地快照新鲜：对快照判 + **本地累加最坏估计**
//               （每笔请求假设打满 max_tokens 输出价，悲观累加，防降级窗口里被刷爆）。
//   open     —— manager 不可达 + 无可用快照：fail-open 放行 + **只警告一次**（别刷屏）。
//
// 快照（~/.multi-proxy-manager/budget-snapshot.json，proxy 自写）：
//   { configHash, period, remaining, at, accLocal, prices, caps, enabled, mode, source }
//   · configHash：manager 回的预算配置哈希；下次 manager 回来若变了 → 整份快照作废重取。
//   · accLocal：降级窗口里 proxy 本地悲观累加的「已假设花掉」最坏成本；manager 恢复即清零。
//
// 估价口径（与 manager 侧 budget-guard.estimateWorstCaseCost 同）：
//   max_tokens 全按输出价估（输入未知/已省；输出通常更贵，取贵的估才叫最坏情况）。
//   缺 max_tokens / 该 model 无输出价 ⇒ estimate=null ⇒ 放行（拦不住未知，别误伤）。
//
// 纪律（与全站同源）：
//   · **门控默认关**：PROXY_BUDGET_GUARD 不设 ⇒ decide 恒返回 open/allowed ⇒ 三条转发逐字不变。
//   · **纯函数/IO 分离**：evaluate/isFresh/estimate 全纯；fetch + 读写文件可注入，测试不碰网络不碰盘。
//   · **热路径联网有超时**：fetch /api/budget 默认 800ms（PROXY_BUDGET_GUARD_TIMEOUT_MS），超时就降级。
//   · **判据自身异常 → fail-open**：预算模块 bug 不该把正常流量挡了（与 reportUsage 同一条底线）。

const fs = require('fs');
const os = require('os');
const path = require('path');

// ==================== 可注入的 env / 全局（测试可控）====================
function snapshotFilePath() {
  const env = process.env.PROXY_BUDGET_SNAPSHOT_FILE;
  return env && env.trim() ? env.trim() : path.join(os.homedir(), '.multi-proxy-manager', 'budget-snapshot.json');
}
function timeoutMsFromEnv() {
  const v = parseInt(process.env.PROXY_BUDGET_GUARD_TIMEOUT_MS, 10);
  return v > 0 ? v : 800;
}
function ttlMsFromEnv() {
  const v = parseInt(process.env.PROXY_BUDGET_GUARD_SNAPSHOT_TTL_MS, 10);
  return v > 0 ? v : 10 * 60 * 1000;
}

// 测试覆盖：注入 fetch 实现与 manager 地址，避免真打网络。
let _fetchImpl = null;
let _managerUrl = null;
function setTestOverrides(overrides = {}) {
  if (overrides.fetchImpl) _fetchImpl = overrides.fetchImpl;
  if (overrides.managerUrl) _managerUrl = overrides.managerUrl;
}

// 内存快照（精确/降级共用）。门控关时恒为 null ⇒ decide 直接 open。
let _state = null;
let _warnedOpen = false;
function resetStateForTest() { _state = null; _warnedOpen = false; }

// ==================== 纯函数（可单测）====================

// 请求体 → max_tokens 数字（也认 max_completion_tokens，某些客户端这么叫）。
function extractMaxTokens(body) {
  if (!body || typeof body !== 'object') return null;
  const v = body.max_tokens != null ? body.max_tokens : body.max_completion_tokens;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 价格表（{[modelId]:{input,output}}）按 model 查价，大小写不敏感（权限机制宁往 proxy 偏）。
function lookupPrice(prices, model) {
  if (!prices || typeof prices !== 'object' || !model) return null;
  if (prices[model]) return prices[model];
  const lower = String(model).toLowerCase();
  if (prices[lower]) return prices[lower];
  for (const k of Object.keys(prices)) if (k.toLowerCase() === lower) return prices[k];
  return null;
}

// 最坏情况成本：max_tokens 全按输出价（每 token）。缺输出价 ⇒ null（不猜 0）。
function estimateWorstCaseCost(maxTokens, pricing) {
  const n = Number(maxTokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pOut = pricing && Number(pricing.output);
  if (!Number.isFinite(pOut) || pOut <= 0) return null;
  return n / 1e6 * pOut;
}

// 当前周期键（与 snapshot.period 同宽：月=YYYY-MM，日=YYYY-MM-DD）。
function periodKeyForNow(now) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
  const y = get('year'), m = get('month'), day = get('day');
  if (!y || !m) return null;
  return `${y}-${m}-${day}`;
}
function periodMatches(snapshotPeriod, now) {
  if (!snapshotPeriod) return false;
  const cur = periodKeyForNow(now);
  if (!cur) return false;
  return snapshotPeriod.length === 7 ? cur.slice(0, 7) === snapshotPeriod : cur === snapshotPeriod;
}

// 快照新鲜度（降级窗口能否用它）：启用 + 有 at + TTL 内 + 同周期。
function isFresh(state, now, ttlMs) {
  if (!state || !state.enabled) return false;
  if (typeof state.at !== 'number' || Number.isNaN(state.at)) return false;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) return false;
  if (t - state.at > ttlMs) return false;
  if (!periodMatches(state.period, now)) return false;
  return true;
}

// 给定一份快照（带 remaining + prices），算这笔请求该不该放。
// 注意：这里不碰 _state，纯比对；accLocal 的加减由 decide 负责。
function evaluate(model, maxTokens, snap) {
  if (!snap || !snap.enabled) return { allowed: true, state: 'disabled', estimate: null, remaining: null };
  const estimate = estimateWorstCaseCost(maxTokens, lookupPrice(snap.prices, model));
  if (estimate == null) return { allowed: true, state: 'no-estimate', estimate: null, remaining: snap.remaining };
  const remaining = Math.max(0, (Number(snap.remaining) || 0) - (Number(snap.accLocal) || 0));
  const allowed = estimate <= remaining;
  return {
    allowed,
    estimate,
    remaining,
    deficit: allowed ? 0 : Math.round((estimate - remaining) * 1e6) / 1e6,
  };
}

// ==================== IO（可注入 / 可 fail）====================

// 打 manager /api/budget，带超时。返回 {ok, snap} 或 {ok:false, error}。
// 不抛：超时 / 网络错都走 ok:false，交给 decide 走降级。
async function fetchBudgetSnapshot(opts = {}) {
  const managerUrl = opts.managerUrl || _managerUrl || process.env.MANAGER_URL || 'http://127.0.0.1:18792';
  const url = String(managerUrl).replace(/\/$/, '') + '/api/budget';
  const timeoutMs = opts.timeoutMs || timeoutMsFromEnv();
  const doFetch = opts.fetchImpl || _fetchImpl || ((u, init) => fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'content-type': 'application/json' };
  const token = opts.token || process.env.MANAGER_AGENT_TOKEN || process.env.PROXY_AUTH_TOKEN;
  if (token) headers['x-agent-token'] = token;
  try {
    const resp = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!resp.ok) return { ok: false, error: `manager /api/budget HTTP ${resp.status}` };
    const snap = await resp.json();
    return { ok: true, snap };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function writeSnapshotFile(state, file) {
  const f = file || snapshotFilePath();
  try {
    if (!fs.existsSync(path.dirname(f))) fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (e) {
    console.error(`[BUDGET-GUARD] 写快照失败（降级判定仍可用，仅重启后无持久快照）: ${e.message}`);
    return false;
  }
}
function loadSnapshotFile(file) {
  const f = file || snapshotFilePath();
  try {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.warn(`[BUDGET-GUARD] 读快照失败，当作无快照: ${e.message}`);
  }
  return null;
}
// 启动期把磁盘快照读进内存（decide 的降级分支会在调用时再判新鲜度，陈旧的会被忽略）。
function seedStateFromFile(file) {
  _state = loadSnapshotFile(file);
  return _state;
}

function warnOnceOpen() {
  if (!_warnedOpen) {
    _warnedOpen = true;
    console.warn('[BUDGET-GUARD] manager 不可达且无可用快照 → fail-open（放行，不拦）。恢复后自动转精确。');
  }
}

// ==================== 主判定（三态）====================
async function decide(model, maxTokens, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const ttlMs = opts.ttlMs || ttlMsFromEnv();
  const timeoutMs = opts.timeoutMs || timeoutMsFromEnv();

  // 1) 精确：manager 可达 → 用真剩额，悲观累加清零（精确模式下不需要 buffer）。
  const fetched = await fetchBudgetSnapshot({ managerUrl: opts.managerUrl, timeoutMs, fetchImpl: opts.fetchImpl, token: opts.token, now });
  if (fetched.ok && fetched.snap && fetched.snap.enabled) {
    const snap = fetched.snap;
    _state = {
      configHash: snap.configHash,
      period: snap.period,
      remaining: snap.remaining,
      at: now.getTime(),
      accLocal: 0,                 // 精确模式拿到真剩额，pessimism buffer 清零
      prices: snap.prices,
      caps: snap.caps,
      enabled: true,
      mode: 'exact',
      source: 'manager',
    };
    const res = evaluate(model, maxTokens, _state);
    writeSnapshotFile(_state, opts.snapshotFile);
    return { state: 'exact', allowed: res.allowed, estimate: res.estimate, remaining: snap.remaining, deficit: res.deficit, source: 'manager' };
  }

  // 2) 降级：manager 挂了，但有新鲜本地快照 → 对快照判 + 本地悲观累加。
  if (isFresh(_state, now, ttlMs)) {
    const res = evaluate(model, maxTokens, _state);
    if (res.allowed) _state.accLocal = (Number(_state.accLocal) || 0) + (res.estimate || 0);
    _state.mode = 'degraded';
    _state.source = 'local-snapshot';
    writeSnapshotFile(_state, opts.snapshotFile);
    return {
      state: 'degraded',
      allowed: res.allowed,
      estimate: res.estimate,
      remaining: Math.max(0, (Number(_state.remaining) || 0) - (Number(_state.accLocal) || 0)),
      deficit: res.deficit,
      source: 'local-snapshot',
    };
  }

  // 3) 开放：manager 不可达 + 无可用快照 → 放行 + 只警告一次。
  warnOnceOpen();
  return { state: 'open', allowed: true, estimate: null, remaining: null, source: 'fail-open' };
}

// /health 用的状态快照（门控关时 _state 恒 null ⇒ enabled:false）。
function getStatus() {
  if (!_state) return { enabled: false, mode: 'open', source: 'none' };
  return {
    enabled: true,
    mode: _state.mode || 'unknown',
    source: _state.source,
    lastAt: _state.at,
    configHash: _state.configHash,
    remaining: _state.remaining,
    accLocal: _state.accLocal,
  };
}

module.exports = {
  SNAPSHOT_FILE_DEFAULT: path.join(os.homedir(), '.multi-proxy-manager', 'budget-snapshot.json'),
  snapshotFilePath,
  timeoutMsFromEnv,
  ttlMsFromEnv,
  setTestOverrides,
  resetStateForTest,
  extractMaxTokens,
  lookupPrice,
  estimateWorstCaseCost,
  periodKeyForNow,
  periodMatches,
  isFresh,
  evaluate,
  fetchBudgetSnapshot,
  writeSnapshotFile,
  loadSnapshotFile,
  seedStateFromFile,
  decide,
  getStatus,
};
