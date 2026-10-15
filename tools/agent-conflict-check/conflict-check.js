#!/usr/bin/env node
// agent-conflict-check — 独立零依赖冲突检测内核
//
// 这是 multi-proxy-manager/lib/agent-owner.js 的**独立镜像副本**（standalone mirror）。
// 为什么要独立：让「检测 agent base_url 是否被其它代理工具占用」这件事不依赖整套
// multi-proxy 活着——用户只装这个工具（甚至 npx 即用）就能查冲突。
//
// 维护纪律：本文件逻辑必须随 agent-owner.js 同步。agent-owner.js 是 SSOT，本文件是它的
// 可分发副本。两者差异只允许是「本文件去掉 manager 上下文、零依赖化」，不允许逻辑分叉。
//
// 判定方式（与 agent-owner.js 一致）：直接读各 agent 配置文件里的 base_url，而非只看端口。
// 端口监听不代表「正在代理这个 agent」，配置文件里的 base_url 才是流量真正送出去的地方。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 已知「其他代理工具」占用的端口。base_url 指向其中任一即视为被占用。
// cc-switch 监听 15721（见 AGENTS.md §3 / 03-adr / agent-proxy-switch）。
// 可通过环境变量 PROXY_OCCUPANT_PORTS 覆盖（逗号分隔），便于扩展 trae/workbuddy 等。
function occupantPorts() {
  return (process.env.PROXY_OCCUPANT_PORTS || '15721')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

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
      return line.replace(/^  base_url:[ \t]*/, '').replace(/^"|"$ /g, '').trim() || null;
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
 * 检测单个 agent 是否被其他工具占用。
 * @param {string} agent codex | hermes | cursor
 * @returns {{ agent: string, occupied: boolean, by?: string, baseUrl?: string }}
 */
function detectOccupancy(agent) {
  const reader = READERS[agent];
  if (!reader) return { agent, occupied: false };
  let url = null;
  try { url = reader(); } catch { url = null; }
  if (!url) return { agent, occupied: false };
  const port = portOf(url);
  if (port && occupantPorts().includes(port)) {
    return { agent, occupied: true, by: `port:${port}`, baseUrl: url };
  }
  return { agent, occupied: false, baseUrl: url };
}

/**
 * 批量检测。返回数组。
 */
function detectAll() {
  return Object.keys(READERS).map((agent) => detectOccupancy(agent));
}

module.exports = { occupantPorts, detectOccupancy, detectAll, portOf, READERS };
