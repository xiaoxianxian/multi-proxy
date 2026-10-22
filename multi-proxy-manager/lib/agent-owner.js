// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// ==================== Agent 代理所有权冲突检测 ====================
// 作用：开/关某个 agent 的 Proxy-rebuild 代理前，先判断该 agent 的
// base_url 是否被「其他代理工具」（如 cc-switch）占用。
//
// 判定方式（与 tools/agent-proxy-switch 一致）：直接读各 agent 自己的
// 配置文件里的 base_url，而非只看端口。原因：端口监听不代表「正在代理
// 这个 agent」，配置文件里的 base_url 才是 agent 真正把流量送出去的地方。
//
// 占用者清单 OCCUPANT_PORTS 可配置（便于未来扩展 trae/workbuddy 等）。
//
// 三种结论（调用方必须区分 free 与 unknown）：
//   status='occupied' — 读到 base_url，且其端口属于竞品占用端口（真正的冲突）
//   status='free'     — 读到了该 agent 的配置真源，其中没有指向竞品端口的 base_url
//   status='unknown'  — 该 agent 没有可解析的配置真源（cursor / generic / dsh），
//                       或配置文件不存在 / 不可读。**不是**「已确认未被占用」，
//                       上层不能把它当成安全信号。
// 三种情况下 occupied 语义不变（boolean），老调用方无需改动；新增 status
// 供上层区分「检测过没问题」与「根本检测不了」。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 已知「其他代理工具」占用的端口。base_url 指向其中任一即视为被占用。
// cc-switch 监听 15721（见 AGENTS.md §3 / 03-adr / agent-proxy-switch）。
const OCCUPANT_PORTS = (process.env.PROXY_OCCUPANT_PORTS || '15721')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// multi-proxy 自己的端口（codex 18790 / claude 18791 / manager 18792 / hermes 18793 /
// cursor 18794 / opencode 18798 / generic 18799 / 统一入口 18880）。
// base_url 指向自家端口 = 正确接入，绝不是冲突。即便 PROXY_OCCUPANT_PORTS 被误配成
// 含自家端口，这里也强制排除——宁可漏报，不可误报自家服务。
const SELF_PORTS = ['18790', '18791', '18792', '18793', '18794', '18798', '18799', '18880'];

// 各 agent 配置文件路径（每次调用时解析 os.homedir()，避免模块加载时固化 HOME）
function codexCfgPath() { return path.join(os.homedir(), '.codex', 'config.toml'); }
function hermesCfgPath() { return path.join(os.homedir(), '.hermes', 'config.yaml'); }
// claude：Claude Code 的持久化 env 落点（本机实证：~/.claude/settings.json 存在；
// ~/.claude.json 不存在）。settings.local.json 为同级覆盖层。
function claudeCfgPaths() {
  const d = path.join(os.homedir(), '.claude');
  return [path.join(d, 'settings.json'), path.join(d, 'settings.local.json')];
}
// opencode：全局 ~/.config/opencode/opencode.jsonc（FUNCTIONS.md §3.6），全局同名 .json，
// 以及项目目录 ./opencode.json(c)（本机实证：~/Documents/AI项目/freellmapi/opencode.json 存在，
// 用的是旧版 provider.<id>.options.baseURL 字段）。
function opencodeCfgPaths() {
  const d = path.join(os.homedir(), '.config', 'opencode');
  return [
    path.join(d, 'opencode.jsonc'),
    path.join(d, 'opencode.json'),
    path.join(process.cwd(), 'opencode.jsonc'),
    path.join(process.cwd(), 'opencode.json'),
  ];
}

// 从 URL 中取端口（支持 http://host:port/...）
function portOf(url) {
  if (!url) return null;
  const m = String(url).match(/:\/\/[^:/]+:(\d+)/);
  return m ? m[1] : null;
}

/**
 * 端口是否属于「其他代理工具」。自家端口（SELF_PORTS）永远不算——
 * 指向 multi-proxy 自己 = 正确接入，不是冲突。
 */
function isOccupantPort(port, occupants = OCCUPANT_PORTS) {
  if (!port) return false;
  if (SELF_PORTS.includes(String(port))) return false;
  return occupants.map(String).includes(String(port));
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
      return line.replace(/^  base_url:[ \t]*/, '').replace(/^"|"$ /g, '').trim() || null;
    }
  }
  return null;
}

// claude：settings.json 的 env.ANTHROPIC_BASE_URL（解析失败直接抛，由 detectOccupancy 兜成 unknown）
function readClaudeUrl() {
  for (const p of claudeCfgPaths()) {
    if (!fs.existsSync(p)) continue;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const url = cfg && cfg.env && cfg.env.ANTHROPIC_BASE_URL;
    if (url) return String(url);
  }
  return null;
}

// opencode：v1 `provider.<id>.options.baseURL` 与 v2 `providers.<id>.settings.baseURL`
// 都以 baseURL 结尾，正则直接取键值，天然兼容 .jsonc 的注释。
function readOpencodeUrl() {
  const urls = [];
  for (const p of opencodeCfgPaths()) {
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    for (const m of txt.matchAll(/(?:baseURL|base_url)["']?\s*[:=]\s*["']([^"']+)["']/g)) {
      urls.push(m[1]);
    }
  }
  if (urls.length === 0) return null;
  // 可配多个 provider：任一个指向占用端口即视为被占用，优先把命中者交出去，
  // 否则返回第一个（作为 baseUrl 旁证）。
  return urls.find(u => isOccupantPort(portOf(u))) || urls[0];
}

// 各 agent 的 base_url 配置真源。read 为 null = 本机没有可解析的稳定落点，
// 只能返回 unknown（不假装能检测，避免误报）。
const SOURCES = {
  codex: { paths: () => [codexCfgPath()], read: readCodexUrl },
  hermes: { paths: () => [hermesCfgPath()], read: readHermesUrl },
  claude: { paths: claudeCfgPaths, read: readClaudeUrl },
  opencode: { paths: opencodeCfgPaths, read: readOpencodeUrl },
  // cursor 的 base_url 在 GUI 里（半自动），无稳定配置文件可解析；
  // 其「被占用」由调用方结合端口旁证判断，此处返回 unknown（不误报）。
  cursor: { paths: () => [], read: null, why: 'base_url 在 GUI 里，无稳定配置文件可解析' },
  // generic 是 Cline / Aider / OpenHands 三客户端共用一个网关，三家配置各写各的
  // （VS Code settings / .aider.conf.yml / config.toml），没有统一落点可解析。
  generic: { paths: () => [], read: null, why: 'Cline/Aider/OpenHands 三家配置各自分散，无统一落点' },
  dsh: { paths: () => [], read: null, why: '未实证到稳定的 base_url 配置文件落点' },
};

/**
 * 检测单个 agent 是否被其他工具占用。
 * @param {string} agent codex | hermes | claude | opencode | cursor | generic | dsh
 * @returns {{ occupied: boolean, status: 'occupied'|'free'|'unknown',
 *             by?: string, baseUrl?: string|null, reason?: string }}
 */
function detectOccupancy(agent) {
  const src = SOURCES[agent];
  if (!src) return { occupied: false, status: 'unknown', reason: 'unknown-agent' };
  if (!src.read) {
    return { occupied: false, status: 'unknown', reason: src.why || 'no-config-source' };
  }
  if (!src.paths().some(p => fs.existsSync(p))) {
    return { occupied: false, status: 'unknown', reason: 'config-not-found' };
  }
  let url = null;
  try {
    url = src.read();
  } catch {
    return { occupied: false, status: 'unknown', reason: 'config-unreadable' };
  }
  const port = portOf(url);
  if (port && isOccupantPort(port)) {
    return { occupied: true, status: 'occupied', by: `port:${port}`, baseUrl: url };
  }
  return { occupied: false, status: 'free', baseUrl: url || null };
}

/**
 * 批量检测。返回 { codex, hermes, claude, opencode, cursor, generic, dsh } 各自占用情况。
 * 每项含 status：occupied / free / unknown（unknown 表示检测不了，不等于安全）。
 */
function detectAll() {
  const out = {};
  for (const agent of Object.keys(SOURCES)) {
    out[agent] = detectOccupancy(agent);
  }
  return out;
}

module.exports = {
  OCCUPANT_PORTS,
  SELF_PORTS,
  isOccupantPort,
  detectOccupancy,
  detectAll,
  portOf,
};
