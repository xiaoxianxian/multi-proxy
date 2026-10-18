#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
'use strict';
/**
 * stale-map-check.js — 变更驱动的文档过期提醒（试水版）
 *
 * 干什么：拿 git 变更文件列表，反查一份 Markdown 地图/文档里提到的路径，
 *         标出「哪些行可能已过期」，并核对头部声明的 HEAD 是否已落后。
 *
 * 为什么：maintain-repo-wiki 的 changed_files.py 那一层（见
 *         agent-infra/evidence/外部对照-maintain-repo-wiki-2026-10-19.md）。
 *         本项目的 Audit/Confirm 门禁、可回归闸门、版本化 SSOT 都有等价物，
 *         唯独「代码改了要更新哪些记忆/文档」这一环是空的。
 *
 * 用法：
 *   node scripts/stale-map-check.js <map.md>              # 默认 HEAD~1..HEAD
 *   node scripts/stale-map-check.js <map.md> HEAD~3 HEAD
 *   node scripts/stale-map-check.js <map.md> --worktree   # 未提交改动
 *
 * 命中分级（防误报的关键）：
 *   STRONG — 变更文件路径以文档中的路径 token 开头（同目录/同文件），高置信
 *   WEAK   — 只匹配到 basename（例：`proxy.js` 在 7 个代理目录都有），低置信，需人工看
 */

const { execSync } = require('child_process');
const fs = require('fs');

const MAP = process.argv[2] || 'docs/00-codebase-map.md';
const ARGS = process.argv.slice(3);

function git(args) {
  return execSync(`git -c core.quotepath=false ${args}`, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function getChanged() {
  if (ARGS[0] === '--worktree') {
    return git('status --porcelain').split('\n')
      .filter(Boolean)
      .map(l => l.slice(3).trim().replace(/^"|"$/g, ''));
  }
  const base = ARGS[0] || 'HEAD~1';
  const head = ARGS[1] || 'HEAD';
  return git(`diff --name-only ${base} ${head}`).split('\n').filter(Boolean);
}

function currentHead() {
  return git('rev-parse --short HEAD').trim();
}

/** 表格首列的目录（支持多级）：| multi-proxy-manager/ | 或 | l2/adapters/ | */
function rowDir(line) {
  const m = line.match(/^\|\s*([A-Za-z0-9_.\-\/]+\/)\s*\|/);
  if (!m) return null;
  return m[1] === '根目录/' ? '' : m[1]; // 「根目录/」= 仓库根，无前缀
}

/** 从一行文本里抽出「看起来像路径」的 token（相对的行目录会在此解析） */
function extractTokens(line) {
  const dir = rowDir(line);
  const out = [];
  const push = (raw) => {
    let t = raw.trim().replace(/^\.\//, '').replace(/\*$/, ''); // systemd/*.service -> systemd/
    if (!t) return;
    const isDir = t.endsWith('/');
    const globalish = !isDir && t.includes('/'); // tools/update-check.js 这类写全的，按全局
    if (!globalish && dir !== null && !t.startsWith(dir)) t = dir + t;
    out.push(t);
  };
  // 反引号里的路径： `README.md` `l2/adapters/` `systemd/*.service`
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim();
    if (/[\/.]/.test(t) && !/\s{2,}/.test(t)) push(t);
  }
  // 表格首列目录本身也算一个 token
  if (dir !== null && dir) out.push(dir);
  return out;
}

// ---------- 主流程 ----------
if (!fs.existsSync(MAP)) {
  console.error(`[x] 找不到 ${MAP}`);
  process.exit(1);
}

const changed = getChanged();
const head = currentHead();
const lines = fs.readFileSync(MAP, 'utf-8').split('\n');

console.log(`地图：${MAP}`);
console.log(`当前 HEAD：${head}`);
console.log(`变更文件：${changed.length} 个`);
console.log('');

// 1) 头部声明的基线 HEAD 是否已落后
//    兼容两种写法：「HEAD `b234dcc`」与「main = `b234dcc`」
const declared = (fs.readFileSync(MAP, 'utf-8')
  .match(/(?:HEAD|main)\s*[=:]?\s*`?([0-9a-f]{7,})`?/i) || [])[1];
if (declared && declared !== head) {
  console.log(`⚠️  地图声称「最后验证 HEAD \`${declared}\`」，当前已到 ${head}`);
  try {
    const behind = git(`rev-list --count ${declared}..HEAD`).trim();
    console.log(`    → 落后 ${behind} 个提交，地图里的状态/数字声明未经复核`);
  } catch (e) {
    console.log(`    → 无法计算落后提交数（${declared} 可能不在本仓库历史里）`);
  }
} else if (declared) {
  console.log(`✅ 地图声明的 HEAD \`${declared}\` 与当前一致`);
} else {
  console.log('·  地图未声明验证时的 HEAD，无法判断基线新鲜度');
}
console.log('');

// 2) 逐行匹配
let strong = 0, weak = 0;
const hits = [];
lines.forEach((line, idx) => {
  const tokens = extractTokens(line);
  if (!tokens.length) return;
  const s = [], w = [];
  for (const t of tokens) {
    for (const f of changed) {
      if (!t) continue;
      if (f.startsWith(t) || t.startsWith(f)) { if (!s.includes(f)) s.push(f); }
      // 弱匹配只对「纯文件名 token」生效：作者写清了目录的（claude-proxy/proxy.js）
      // 就不该被别的目录同名文件（dsh-proxy/proxy.js）触发，否则 `proxy.js` 会淹没人
      else if (!t.includes('/') && t === f.split('/').pop()) { if (!w.includes(f)) w.push(f); }
    }
  }
  if (!s.length && !w.length) return;
  strong += s.length ? 1 : 0;
  weak += !s.length && w.length ? 1 : 0;
  // 该行含数量声明（「41 个模块文件」「（25 模块）」）→ 命中时必须重新实跑计数
  const hasCount = /\d+\s*个|（\s*\d+/.test(line);
  hits.push({ line: idx + 1, text: line.trim().slice(0, 70), s, w, hasCount });
});

if (!hits.length) {
  console.log('✅ 本次变更未触及地图提到的任何路径，无需复核。');
} else {
  console.log(`🔴 可能过期的行：${hits.length} 行（强命中 ${strong} / 弱命中 ${weak}）`);
  console.log('');
  for (const h of hits) {
    const tag = h.s.length ? 'STRONG' : 'WEAK  ';
    const list = h.s.length ? h.s : h.w;
    const files = list.slice(0, 4).join(', ');
    const more = list.length > 4 ? ` (+${list.length - 4})` : '';
    const cnt = h.hasCount && h.s.length ? '  ⚠️ 本行含数量声明，需重新实跑' : '';
    console.log(`  [${tag}] L${h.line}: ${h.text}${cnt}`);
    console.log(`           ← ${files}${more}`);
  }
}
console.log('');
console.log('注：WEAK 只按文件名匹配（如 `proxy.js` 多目录同名），需人工确认是否真是同一处。');
