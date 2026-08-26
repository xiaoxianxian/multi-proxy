// ==================== Agent 代理所有权冲突检测 ====================
// 作用：开/关某个 agent 的 Proxy-rebuild 代理前，先判断该 agent 的
// base_url 是否被「其他代理工具」（如 cc-switch）占用。
//
// 判定方式（与 tools/agent-proxy-switch 一致）：直接读各 agent 自己的
// 配置文件里的 base_url，而非只看端口。原因：端口监听不代表「正在代理
// 这个 agent」，配置文件里的 base_url 才是 agent 真正把流量送出去的地方。
//
// 占用者清单 OCCUPANT_PORTS 可配置（便于未来扩展 trae/workbuddy 等）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 已知「其他代理工具」占用的端口。base_url 指向其中任一即视为被占用。
// cc-switch 监听 15721（见 CLAUDE.md / agent-proxy-switch）。
const OCCUPANT_PORTS = (process.env.PROXY_OCCUPANT_PORTS || '15721')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// 各 agent 配置文件路径（每次调用时解析 os.homedir()，避免模块加载时固化 HOME）
function codexCfgPath() { return path.join(os.homedir(), '.codex', 'config.toml'); }
function hermesCfgPath() { return path.join(os.homedir(), '.hermes', 'config.yaml'); }

// 从 URL 中取端口（支持 http://host:port/...）
function portOf(url) {
  if (!url) return null;
  const m = String(url).match(/:\/\/[^:/]+:(\d+)/);
  return m ? m[1] : null;
}

function readCodexUrl() {
  const CODEX_CFG = codexCfgPath();
  if (!fs.existsSync(CODEX_CFG)) return null;
  const txt = fs.readFileSync(CODEX_CFG, 'utf8');
  const block = txt.match(/\[model_providers\.custom\][^\[]*/);
  if (!block) return null;
  const line = block[0].match(/base_url\s*=\s*"([^"]+)"/);
  return line ? line[1] : null;
}

function readHermesUrl() {
  const HERMES_CFG = hermesCfgPath();
  if (!fs.existsSync(HERMES_CFG)) return null;
  const txt = fs.readFileSync(HERMES_CFG, 'utf8').split('\n');
  let inModel = false;
  for (const line of txt) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) {
      inModel = /^model:[ \t]*$/.test(line);
      continue;
    }
    if (inModel && /^  base_url:/.test(line)) {
      return line.replace(/^  base_url:[ \t]*/, '').replace(/^"|"$/g, '').trim() || null;
    }
  }
  return null;
}

// 各 agent 的 base_url 读取器
const READERS = {
  codex: readCodexUrl,
  hermes: readHermesUrl,
  // cursor 的 base_url 在 GUI 里（半自动），无稳定配置文件可解析；
  // 其「被占用」由调用方结合端口旁证判断，此处返回 null（不误报）。
  cursor: () => null,
};

/**
 * 检测某 agent 是否被其他工具占用。
 * @param {string} agent codex | hermes | cursor
 * @returns {{ occupied: boolean, by?: string, baseUrl?: string }}
 */
function detectOccupancy(agent) {
  const reader = READERS[agent];
  if (!reader) return { occupied: false };
  const url = reader();
  if (!url) return { occupied: false };
  const port = portOf(url);
  if (port && OCCUPANT_PORTS.includes(port)) {
    return { occupied: true, by: `port:${port}`, baseUrl: url };
  }
  return { occupied: false };
}

/**
 * 批量检测。返回 { codex, hermes, cursor } 各自占用情况。
 */
function detectAll() {
  const out = {};
  for (const agent of Object.keys(READERS)) {
    out[agent] = detectOccupancy(agent);
  }
  return out;
}

module.exports = { OCCUPANT_PORTS, detectOccupancy, detectAll, portOf };
