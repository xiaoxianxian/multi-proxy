#!/usr/bin/env node
// agent-conflict-check 持续轮询守护
//
// 复用 conflict-check.js 的扫描器，周期性检测 agent base_url 占用冲突，并把结果落盘到日志。
// 与「检测不依赖整套系统活着」的哲学一致：本脚本零依赖，可单独常驻。
//
// 用法：
//   node poll.js                       # 每 30s 轮询一次，日志写到 ~/.multi-proxy-manager/conflict-poll.log
//   node poll.js --interval=10          # 每 10s
//   node poll.js --once                # 只跑一次（CI/手动触发）
//   node poll.js --log=/tmp/conflict.log
//   node poll.js --notify              # 检测到冲突时用系统通知（macOS osascript / 其它平台 stdout）
//
// 退出码：--once 模式下 0=无冲突，1=有冲突；守护模式常驻不退出（Ctrl-C 停止）。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectAll, occupantPorts } = require('./conflict-check.js');

const argv = process.argv.slice(2);
function arg(name, def) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
}

const interval = parseInt(arg('interval', '30'), 10) || 30;
const once = argv.includes('--once');
const notify = argv.includes('--notify');
const logPath = arg('log', path.join(os.homedir(), '.multi-proxy-manager', 'conflict-poll.log'));
const logDir = path.dirname(logPath);

function notifySystem(msg) {
  if (process.platform === 'darwin') {
    try { require('child_process').execSync(`osascript -e 'display notification "${msg}" with title "agent-conflict-check"'`); } catch { /* best-effort */ }
  }
  process.stdout.write(`[notify] ${msg}\n`);
}

function runOnce() {
  let results;
  try {
    results = detectAll();
  } catch (e) {
    const line = `${new Date().toISOString()} ERROR ${e && e.message || e}\n`;
    try { fs.appendFileSync(logPath, line); } catch { /* ignore */ }
    return { conflicts: [], error: e };
  }
  const conflicts = results.filter((r) => r.occupied);
  const ts = new Date().toISOString();
  const summary = `${ts} ports=[${occupantPorts().join(',')}] checked=${results.length} conflicts=${conflicts.length}`;
  const detail = conflicts.length
    ? conflicts.map((c) => `  ${c.agent} base_url=${c.baseUrl} by=${c.by}`).join('\n')
    : '';
  try {
    fs.appendFileSync(logPath, summary + (detail ? '\n' + detail : '') + '\n');
  } catch { /* best-effort */ }
  if (conflicts.length && notify) {
    notifySystem(`检测到 ${conflicts.length} 处代理冲突：${conflicts.map((c) => c.agent).join(', ')}`);
  }
  return { conflicts };
}

if (once) {
  const { conflicts } = runOnce();
  process.exit(conflicts.length ? 1 : 0);
} else {
  if (!fs.existsSync(logDir)) { try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ } }
  process.stdout.write(`agent-conflict-check 守护启动：每 ${interval}s 轮询，日志 → ${logPath}\n`);
  runOnce();
  const timer = setInterval(runOnce, interval * 1000);
  process.on('SIGINT', () => { clearInterval(timer); process.stdout.write('\n守护停止。\n'); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
}
