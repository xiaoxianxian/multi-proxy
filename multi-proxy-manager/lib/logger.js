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

function appendLog(level, proxyName, message, meta = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = formatLogEntry(level, proxyName, message, meta);
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    // Keep last 5000 lines
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').slice(-5000);
    fs.writeFileSync(LOG_FILE, lines.join('\n'));
  } catch (e) {
    // Silently ignore log errors
  }
}

module.exports = { LOG_DIR, LOG_FILE, formatLogEntry, appendLog };
