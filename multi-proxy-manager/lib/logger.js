// ==================== 日志系统 ====================
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(os.homedir(), '.multi-proxy-manager', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'requests.log');

/**
 * Format a log entry as a JSON lines record.
 * Unified output format: {"ts":"...","level":"...","proxy":"...","msg":"...","meta":{}}
 * Used by both appendLog and formatLogEntry.
 */
function formatLogEntry(level, proxy, message, meta = {}) {
  return {
    ts: new Date().toISOString(),
    level: level.toUpperCase(),
    proxy: proxy || 'system',
    msg: message,
    meta: meta || {},
  };
}

// 裁剪策略：每追加 TRIM_INTERVAL 条才做一次全文件重写（保留最后 HARD_LIMIT 行），
// 文件稳定在 HARD_LIMIT ~ HARD_LIMIT+TRIM_INTERVAL 行之间。
// 避免旧实现"每写一条就整读整写"的 O(n²) 写放大。
const HARD_LIMIT = 5000;
const TRIM_INTERVAL = 500;
let linesSinceTrim = 0;

function trimLogFile() {
  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = content.split('\n').slice(-HARD_LIMIT);
  fs.writeFileSync(LOG_FILE, lines.join('\n'));
}

function appendLog(level, proxyName, message, meta = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = formatLogEntry(level, proxyName, message, meta);
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    linesSinceTrim++;
    // Keep last ~5000 lines; full rewrite only once per TRIM_INTERVAL appends
    if (linesSinceTrim >= TRIM_INTERVAL) {
      trimLogFile();
      linesSinceTrim = 0;
    }
  } catch (e) {
    // Silently ignore log errors
    linesSinceTrim = 0;
  }
}

module.exports = { LOG_DIR, LOG_FILE, formatLogEntry, appendLog };
