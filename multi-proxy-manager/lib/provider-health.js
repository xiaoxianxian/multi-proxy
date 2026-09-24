// ==================== M2 方向二：Provider 故障自动标记与隔离（纯记录层） ====================
//
// 核心不变式（与 M1 健康图 / M6 shadow 同构）：本模块只「记录 + 判定 + 聚合」，
// 绝不改动 providers.json、不改路由、不 flip enabled。自动「跳过 / 标记 enabled=false」
// 属高后果动作（误禁用会重排全局路由），默认 observe，需 PROXY_HEALTH_ISOLATE=1 才由
// 上层执行——本模块永远只「建议」，从不「执行」。见 ITERATION-ROADMAP M2-2a/2b。
//
// 复用现成件：成败判定由调用方用 forward.js 的 classifyUpstreamError 得到布尔 ok 后传入，
// 本模块不发起任何上游请求（零新增流量、零扣费风险）。
//
// 2a. 连续 N 次失败 → unhealthy，unhealthyUntil = now + isolateDelayMs（默认 5min）后重新试探
// 2b. 跨 proxy 聚合：同一 providerId 在窗口内被 ≥ crossProxyThreshold 个不同 proxy 报失败
//     → 升级为「全网故障」，否则为「单 proxy 抖动」
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROVIDER_HEALTH_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'provider-health.json');
const DEFAULT_CONFIG = {
  failureThreshold: 3,            // 连续失败 N 次 → 标记 unhealthy / 建议隔离
  isolateDelayMs: 5 * 60 * 1000,  // 5min 后自动重新试探（unhealthyUntil）
  crossProxyThreshold: 2,         // ≥N 个不同 proxy 在窗口内报同一 provider 失败 → 全网故障
  crossProxyWindowMs: 5 * 60 * 1000,
};

let activeFile = PROVIDER_HEALTH_FILE;
let currentConfig = { ...DEFAULT_CONFIG };
let clock = () => Date.now();

// providerId -> record
//   { providerId, status:'healthy'|'unhealthy', consecutiveFailures, consecutiveSuccesses,
//     lastProbeAt, unhealthySince, unhealthyUntil, lastSource }
const health = new Map();
// providerId -> Array<{ source, at }>（仅记失败事件，供 2b 跨 proxy 聚合）
const recentFailures = new Map();

// ---------- 测试 / 调度可注入 ----------
function setHealthFile(filepath) { activeFile = filepath; }
function setHealthConfig(patch) { currentConfig = { ...currentConfig, ...patch }; }
function setClock(fn) { clock = fn; }
function resetProviderHealth() { health.clear(); recentFailures.clear(); }

// ---------- 持久化（镜像 crash-recovery.json 模式；失败 best-effort） ----------
function ensureDir() {
  const dir = path.dirname(activeFile);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }
}

function loadProviderHealth() {
  try {
    ensureDir();
    if (fs.existsSync(activeFile)) {
      const data = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      if (data && typeof data === 'object') {
        for (const [id, rec] of Object.entries(data)) {
          if (rec && typeof rec === 'object') health.set(id, rec);
          if (rec && Array.isArray(rec._recentFailures)) recentFailures.set(id, rec._recentFailures);
        }
      }
    }
  } catch (e) {
    console.error('[ProviderHealth] load failed:', e.message);
  }
}

function saveProviderHealth() {
  try {
    ensureDir();
    const out = {};
    for (const [id, rec] of health) {
      out[id] = { ...rec, _recentFailures: recentFailures.get(id) || [] };
    }
    const tmp = activeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, activeFile);
  } catch (e) {
    console.error('[ProviderHealth] save failed:', e.message);
  }
}

// 启动时载入持久化状态
loadProviderHealth();

// ---------- 门控：隔离动作的执行开关（默认关 = observe） ----------
function isolateEnabled() {
  const v = String(process.env.PROXY_HEALTH_ISOLATE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// ---------- 核心：记录一次探活结果（纯记录，零副作用） ----------
// opts: { source?: 'codex'|'hermes'|'cursor'|'manual', now?: number, persist?: boolean }
// 返回更新后的 record。绝不触碰 providers.json / 路由。
function recordProbe(providerId, ok, opts = {}) {
  if (!providerId) return null;
  const now = typeof opts.now === 'number' ? opts.now : clock();
  const cfg = currentConfig;
  const source = opts.source || 'manual';

  let rec = health.get(providerId);
  if (!rec) {
    rec = {
      providerId,
      status: 'healthy',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastProbeAt: now,
      unhealthySince: null,
      unhealthyUntil: null,
      lastSource: source,
    };
    health.set(providerId, rec);
  }

  rec.lastProbeAt = now;
  rec.lastSource = source;

  if (ok) {
    rec.consecutiveSuccesses++;
    rec.consecutiveFailures = 0;
    // 成功 → 解除隔离建议
    rec.status = 'healthy';
    rec.unhealthySince = null;
    rec.unhealthyUntil = null;
  } else {
    rec.consecutiveFailures++;
    rec.consecutiveSuccesses = 0;
    // 记入失败事件（供 2b 跨 proxy 聚合），按窗口裁剪
    const arr = recentFailures.get(providerId) || [];
    arr.push({ source, at: now });
    const cutoff = now - cfg.crossProxyWindowMs;
    recentFailures.set(providerId, arr.filter((e) => e.at >= cutoff));

    if (rec.consecutiveFailures >= cfg.failureThreshold && rec.status !== 'unhealthy') {
      rec.status = 'unhealthy';
      rec.unhealthySince = now;
      rec.unhealthyUntil = now + cfg.isolateDelayMs;
    }
  }

  const result = { ...rec };
  if (opts.persist !== false) saveProviderHealth();
  return result;
}

// ---------- 查询 ----------
function isIsolated(record, now) {
  if (!record) return false;
  const t = typeof now === 'number' ? now : clock();
  return record.status === 'unhealthy' && record.unhealthyUntil != null && t < record.unhealthyUntil;
}

// 是否仍处于「建议隔离」窗口（纯判定，不含执行）
function shouldIsolateNow(providerId, now) {
  return isIsolated(health.get(providerId), now);
}

/**
 * 2b. 跨 proxy 故障聚合。
 * 返回 { verdict:'network-wide'|'single-proxy', sources:[], count }
 * 窗口内 ≥ crossProxyThreshold 个不同 source 报同一 providerId 失败 → 全网故障。
 */
function correlateCrossProxy(providerId, now) {
  const t = typeof now === 'number' ? now : clock();
  const window = currentConfig.crossProxyWindowMs;
  const cutoff = t - window;
  const evts = (recentFailures.get(providerId) || []).filter((e) => e.at >= cutoff);
  const distinct = new Set(evts.map((e) => e.source));
  return {
    verdict: distinct.size >= currentConfig.crossProxyThreshold ? 'network-wide' : 'single-proxy',
    sources: Array.from(distinct),
    count: distinct.size,
  };
}

// 当前建议隔离的 provider（status=unhealthy 且仍在窗口内）——dashboard「Provider Health」数据源。
// observe 模式下这只是建议清单，不执行任何路由/启用变更。
function listIsolated(now) {
  const t = typeof now === 'number' ? now : clock();
  const out = [];
  for (const [id, rec] of health) {
    if (isIsolated(rec, t)) out.push({ providerId: id, ...rec });
  }
  return out;
}

function getProviderHealth(providerId) {
  const rec = health.get(providerId);
  if (!rec) return null;
  return { ...rec };
}

module.exports = {
  recordProbe,
  isIsolated,
  shouldIsolateNow,
  correlateCrossProxy,
  listIsolated,
  getProviderHealth,
  isolateEnabled,
  loadProviderHealth,
  saveProviderHealth,
  setHealthFile,
  setHealthConfig,
  setClock,
  resetProviderHealth,
  DEFAULT_CONFIG,
  PROVIDER_HEALTH_FILE,
};