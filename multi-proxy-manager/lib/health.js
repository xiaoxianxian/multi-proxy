// ==================== M1 DAG 健康依赖图：归一化 + 持久化 ====================
// 每个 proxy 的 /health 已升级为 { status, checks, reasons, ... }，但三处契约不一致：
//   - codex/hermes: status ∈ {'healthy','degraded'}
//   - cursor: status ∈ {'ok','degraded'}
// 此处归一化为 ROADMAP 规定的 {'ok','degraded','down'}，并附上：
//   - overall：合并 manager 侧故障信号（进程未运行 / 熔断）
//   - reasons：人类可读的根因标签（供 dashboard 徽章展示）
//   - checks：各项检查的布尔明细
// 持久化：每次 /api/status 拉取把结果追加一行到 ~/.multi-proxy-manager/health-history.jsonl，
// 便于回溯「某段时间某 proxy 为什么不健康」。
const fs = require('fs');
const path = require('path');
const os = require('os');

const HEALTH_HISTORY_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'health-history.jsonl');
const MAX_HISTORY_LINES = 2000;

// 测试可用 setHistoryFile() 重定向持久化路径（默认指向 ~/.multi-proxy-manager/）。
let activeHistoryFile = HEALTH_HISTORY_FILE;

// 归一化单个 proxy 的 /health 响应为统一契约。
// raw 可能为 null（进程未运行 / 拉取失败）—— 此时降级为 'down' / 'unreachable'。
// faultSignal：manager 侧已知故障（如熔断 consecutiveFailures>=5），强制降级 overall。
function normalizeProxyHealth(name, raw, { faultSignal } = {}) {
  // 进程未运行或拉取失败 —— 无法判定内部状态
  if (!raw || typeof raw !== 'object') {
    return {
      name,
      status: 'down',
      overall: 'down',
      checks: raw ? raw.checks || {} : { process: false },
      reasons: raw ? (raw.reasons || []) : ['代理未运行或不响应 /health'],
      raw,
    };
  }

  const checks = raw.checks || {};
  const reasons = Array.isArray(raw.reasons) ? raw.reasons.slice() : [];

  // 归一化 status（兼容两套契约）
  let status = String(raw.status || '');
  if (status === 'healthy') status = 'ok';
  else if (status === 'ok') status = 'ok';
  else if (status === 'degraded' || status === 'warning' || status === 'unhealthy') status = 'degraded';
  else status = 'down';

  // overall：合并 manager 侧故障信号
  let overall = status;
  if (faultSignal || !checks.process) {
    overall = 'down';
    if (!reasons.length) reasons.unshift(faultSignal ? '连续崩溃，已进入故障熔断' : '进程未运行');
   }
  // degraded 也叠加 faultSignal 描述
  if (faultSignal && overall === 'degraded') {
    reasons.unshift('连续崩溃，已进入故障熔断');
   }

  return { name, status, overall, checks, reasons, raw };
}

// 追加一行到 health-history.jsonl（best-effort，写入失败不影响主流程）。
// 计数触发式裁剪：每 500 行重写保留最后 MAX_HISTORY_LINES 行，避免 O(n²) 写放大。
let linesSinceTrim = 0;
function ensureDir() {
  const dir = path.dirname(activeHistoryFile);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
}

function persistHealthHistory(entry) {
  try {
    ensureDir();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(activeHistoryFile, line);
    linesSinceTrim++;
    if (linesSinceTrim >= 500) {
      linesSinceTrim = 0;
      trimHistory();
      }
    } catch (e) {
      // 计数复位，避免异常后立刻再次触发裁剪放大 IO
    linesSinceTrim = 0;
    }
}

function trimHistory() {
  try {
    if (!fs.existsSync(activeHistoryFile)) return;
    const raw = fs.readFileSync(activeHistoryFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length > MAX_HISTORY_LINES) {
      const kept = lines.slice(lines.length - MAX_HISTORY_LINES);
      const tmp = activeHistoryFile + '.tmp';
      fs.writeFileSync(tmp, kept.join('\n') + '\n');
      fs.renameSync(tmp, activeHistoryFile);
      }
    } catch {
      // 裁剪失败不致命
    }
}

// 读取最近的 N 条健康历史（倒序），用于 dashboard「健康趋势」回溯。
function readRecentHealth(limit = 100) {
  try {
    if (!fs.existsSync(activeHistoryFile)) return [];
    const raw = fs.readFileSync(activeHistoryFile, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const recent = lines.slice(-limit);
    return recent.map(l => {
      try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean).reverse();
    } catch {
    return [];
    }
}

// 测试 / 手动重定向持久化路径（默认 ~/.multi-proxy-manager/health-history.jsonl）。
function setHistoryFile(filepath) {
  activeHistoryFile = filepath;
  linesSinceTrim = 0;
}

module.exports = {
  normalizeProxyHealth,
  persistHealthHistory,
  trimHistory,
  readRecentHealth,
  setHistoryFile,
  HEALTH_HISTORY_FILE,
  MAX_HISTORY_LINES,
};
