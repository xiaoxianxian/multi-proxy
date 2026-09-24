// ==================== M4 方向三：错误模式检索与复用（core matching + history） ====================
//
// 3a. 错误模式库：常见错误的 pattern + 解决建议（种子从历史 handover/P0/AGENTS.md/03-adr 真实错误提取，非臆造）
// 3b. 结构化日志：error 级日志匹配到 pattern 后，追加一条 { ts, proxy, pattern_id, ... } 到 error-history.jsonl
// 3c (defer)：logs.html "常见问题" Tab —— 改 1251 行 HTML，风险高，本轮不做，数据层已就绪供前端直接拉 /api/errors/*
//
// 设计：纯匹配/记录/检索，绝不抛、绝不写 providers.json/路由。recordError 是 best-effort 钩子，
// 失败静默（和 appendLog 一致），不影响主日志流。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ERROR_PATTERNS_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'error-patterns.json');
const ERROR_HISTORY_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'error-history.jsonl');
const MAX_HISTORY_LINES = 2000;

// ---------- 种子错误模式库（真实来源：AGENTS.md / 03-adr / P0-FIXES.md / HANDOVER / PROJECT-STATUS） ----------
// id, pattern(RegExp source), resolution(人类可读修复), first_seen
const SEED_PATTERNS = [
  { id: 'better-sqlite3-mismatch', pattern: 'better-sqlite3|NODE_MODULE_VERSION|ABI (mismatch|不匹配|[0-9]{3})',
    resolution: 'cursor-proxy 的 better-sqlite3 native module 与当前 Node 版本不匹配（prebuild 仅支持 Node v22/ABI 127，Node v24/ABI 137 报错）。修复：`cd cursor-proxy && npm rebuild better-sqlite3`（或 `npm install`）。详见 07-ops/ENV-NOTES.md。',
    first_seen: '2026-08-24' },
  { id: 'eperm-bind', pattern: 'EPERM|EACCES.*(bind|listen|0\\.0\\.0\\.0)',
    resolution: 'supertest/端口监听测试在沙箱环境因 EPERM 无法绑定 0.0.0.0。这是环境问题非代码 bug，在正常本地环境或 Docker 中通过；测试需设 PORT 或跳过绑定。',
    first_seen: '2026-08-26' },
  { id: 'econnrefused-upstream', pattern: 'ECONNREFUSED|无法连接到供应商|connection (refused|reset)',
    resolution: '上游/代理未启动或端口不通。检查 `manage.sh status`，必要时 `manage.sh start`；或确认 proxy 监听端口（codex 18790 / hermes 18793 / cursor 18794 / manager 18792）。',
    first_seen: '2026-08-26' },
  { id: 'etimedout', pattern: 'ETIMEDOUT|timed?\\s*out|超时',
    resolution: '网络/上游超时。检查 NO_PROXY 是否误配裸 `*`（会导致所有请求直连被墙 IP 而超时，见 03-adr/0002 / AGENTS.md §2 NO_PROXY 铁律）、代理可达性、上游限流。',
    first_seen: '2026-08-24' },
  { id: 'port-conflict', pattern: 'EADDRINUSE|address already in use|端口.*冲突|already in use',
    resolution: '端口被其它工具占用（如 cc-switch:15721）。用 `tools/agent-proxy-switch` 在 multi-proxy 与 cc-switch 间切换 agent base_url，确认端口归属后再启服务。',
    first_seen: '2026-08-24' },
  { id: 'module-not-found', pattern: 'MODULE_NOT_FOUND|Cannot find module|require\\(.+\\).*failed',
    resolution: '依赖缺失。`cd <proxy> && npm install` 安装依赖；若 better-sqlite3 需 `npm rebuild`（见 better-sqlite3-mismatch）。',
    first_seen: '2026-07-03' },
  { id: 'enoent-file', pattern: 'ENOENT|no such file|does not exist',
    resolution: '文件/路径不存在。检查数据目录 `~/.multi-proxy-manager/`（providers.json / health-history.jsonl / crash-recovery.json）是否齐全；首次运行会自动创建。',
    first_seen: '2026-08-24' },
  { id: 'hermes-flask-faststart', pattern: 'Hermes.*启动失败|Flask.*启动|误报',
    resolution: 'Hermes(Flask) 启动过快导致端口检测误报"启动失败"。manage.sh 已加 sleep 1s 后再检测，无需处理；若仍复现，手动 `manage.sh status` 复查。',
    first_seen: '2026-08-26' },
];

// ---------- 运行时状态（可注入，便于测试） ----------
let patterns = [];
let activeHistoryFile = ERROR_HISTORY_FILE;
let activePatternFile = ERROR_PATTERNS_FILE;
let linesSinceTrim = 0;

function loadPatterns() {
  patterns = [];
  // 先加载种子
  patterns = SEED_PATTERNS.map((p) => ({ ...p }));
  // 尝试合并磁盘上的（用户/历史扩展的）
  try {
   if (fs.existsSync(activePatternFile)) {
     const data = JSON.parse(fs.readFileSync(activePatternFile, 'utf8'));
      if (Array.isArray(data)) {
        const byId = new Map(patterns.map((p) => [p.id, p]));
        for (const dp of data) {
          if (dp && dp.id) byId.set(dp.id, { ...byId.get(dp.id), ...dp });
        }
        patterns = Array.from(byId.values());
      }
    }
  } catch (e) {
    console.error('[ErrorPatterns] load merge failed:', e.message);
  }
  return patterns;
}

// 启动时载入
loadPatterns();

function ensureDir() {
  const dir = path.dirname(activeHistoryFile);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
}

// ---------- 匹配（返回首个命中 pattern；null 表示无匹配） ----------
function matchError(message) {
  if (!message || typeof message !== 'string') return null;
  for (const p of patterns) {
    try {
      const re = p.re || new RegExp(p.pattern, 'i');
      p.re = re;
      if (re.test(message)) return { ...p };
    } catch {
      /* 单个 pattern 正则出错不影响其它 */
    }
  }
  return null;
}

// ---------- 记录一条错误到结构化历史（best-effort，绝不抛） ----------
// 返回写入的 entry；无匹配仍记录（pattern_id=null），便于按 proxy 检索全部 error 日志
function recordError(opts = {}) {
  const { proxy, rawMessage, level = 'error', ts, persist = true } = opts;
  const entry = {
    ts: ts || new Date().toISOString(),
    proxy: proxy || 'system',
    level: String(level).toUpperCase(),
    error_type: rawMessage.slice(0, 80),
    pattern_id: null,
   };
  if (rawMessage) {
    const m = matchError(rawMessage);
    if (m) {
      entry.pattern_id = m.id;
      entry.resolution_hint = m.resolution;
       // frequency 持久化仅在 persist 时（避免测试 persist:false 仍写盘）
      if (persist !== false) entry.frequency = (bumpPatternFreq(m.id) || 0) + 1;
     }
   }
  if (persist !== false) appendHistory(entry);
  return entry;
}

// ---------- pattern 频次（best-effort 计数，持久化到 error-patterns.json） ----------
function bumpPatternFreq(id) {
  try {
    let data = [];
    if (fs.existsSync(activePatternFile)) {
      data = JSON.parse(fs.readFileSync(activePatternFile, 'utf8'));
      if (!Array.isArray(data)) data = [];
     }
    let found = data.find((p) => p.id === id);
    if (found) { found.occurrences = (found.occurrences || 0) + 1; }
    else {
      const seed = SEED_PATTERNS.find((p) => p.id === id);
      data.push({ id, occurrences: 1, resolution: seed ? seed.resolution : null, first_seen: new Date().toISOString().slice(0, 10) });
    }
    ensurePatternsDir();
    const tmp = activePatternFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, activePatternFile);
    return data.find((p) => p.id === id).occurrences;
  } catch {
    return null;
  }
}

function ensurePatternsDir() {
  const dir = path.dirname(activePatternFile);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
}

// ---------- 历史持久化（jsonl，裁剪与 health-history 同策略） ----------
function appendHistory(entry) {
  try {
    ensureDir();
    fs.appendFileSync(activeHistoryFile, JSON.stringify(entry) + '\n');
    linesSinceTrim++;
    if (linesSinceTrim >= 500) {
      trimHistory();
      linesSinceTrim = 0;
    }
  } catch {
    linesSinceTrim = 0;
  }
}

function trimHistory() {
  try {
    if (!fs.existsSync(activeHistoryFile)) return;
    const lines = fs.readFileSync(activeHistoryFile, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length > MAX_HISTORY_LINES) {
      const kept = lines.slice(lines.length - MAX_HISTORY_LINES);
      const tmp = activeHistoryFile + '.tmp';
      fs.writeFileSync(tmp, kept.join('\n') + '\n');
      fs.renameSync(tmp, activeHistoryFile);
    }
  } catch { /* non-fatal */ }
}

// ---------- 查询 ----------
function getPatterns(sortDesc = true) {
  const out = patterns.map((p) => ({
    id: p.id,
    pattern: p.pattern,
    resolution: p.resolution,
    first_seen: p.first_seen,
    frequency: p.frequency != null ? p.frequency : null,
   }));
  if (sortDesc) out.sort((a, b) => (b.frequency || 0) - (a.frequency || 0) || a.id.localeCompare(b.id));
  return out;
}

function getHistory(limit = 100) {
  try {
    if (!fs.existsSync(activeHistoryFile)) return [];
    const lines = fs.readFileSync(activeHistoryFile, 'utf8').split('\n').filter((l) => l.trim());
    const recent = lines.slice(-limit);
    return recent.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

// 3c. 关键词检索（纯 substring，匹配 proxy / error_type / resolution_hint）
function searchHistory(keyword, limit = 50) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return getHistory(limit);
  return getHistory(9999).filter((e) => {
    const hay = [e.proxy, e.error_type, e.resolution_hint, e.pattern_id, e.level].join(' ').toLowerCase();
    return hay.includes(kw);
   }).slice(0, limit);
}

// 注入接口（测试 / 重置用）
function setPatterns(list) { patterns = list; }
function resetErrorPatterns() { patterns = []; }
function setHistoryFile(f) { activeHistoryFile = f; linesSinceTrim = 0; }
function setPatternFile(f) { activePatternFile = f; }

module.exports = {
  matchError,
  recordError,
  getPatterns,
  getHistory,
  searchHistory,
  loadPatterns,
  setPatterns,
  resetErrorPatterns,
  setHistoryFile,
  setPatternFile,
  SEED_PATTERNS,
  ERROR_PATTERNS_FILE,
  ERROR_HISTORY_FILE,
  MAX_HISTORY_LINES,
};