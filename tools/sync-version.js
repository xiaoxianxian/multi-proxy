#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 版本收口（2026-10-04）
//
// 原先四份 package.json（codex / cursor / manager / desktop）**各写各的 1.0.0**，
// 谁改了谁不改没人知道；/api/version 读的又是仓库根那个压根不存在的 package.json，
// 一路 catch 到硬编码 1.0.0。等于「版本」这个字段在整条链路上都是假的。
//
// 改法：仓库根放一份 VERSION（第 1 行语义化版本，第 2 行日期），它是**唯一版本源**；
// 其余地方都从它派生。以后发版只改 VERSION 一个文件，再跑一次本脚本。
//
//   node tools/sync-version.js          打印当前版本
//   node tools/sync-version.js --check  只核对，不一致非零退出（CI 用）
//   node tools/sync-version.js --write  同步四份 package.json 与 /api/version 读到的值

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const PACKS = ['codex-proxy', 'cursor-proxy', 'multi-proxy-manager', 'desktop'];

/** 读 VERSION：第 1 行版本、第 2 行日期。格式坏了就明确报错，不许静默回落 1.0.0。 */
function readVersion() {
  let raw;
  try {
    raw = fs.readFileSync(VERSION_FILE, 'utf8');
  } catch (e) {
    throw new Error(`读不到版本文件 ${VERSION_FILE}（${e.message}）`);
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const version = lines[0];
  const date = lines[1] || '';
  if (!/^\d+\.\d+\.\d+([-+].*)?$/.test(version || '')) {
    throw new Error(`VERSION 第一行不是语义化版本：${JSON.stringify(version)}`);
  }
  return { version, date };
}

function packPath(name) {
  return path.join(ROOT, name, 'package.json');
}

function readPack(name) {
  const p = packPath(name);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null; // 目录可能不存在（cursor 有时单独克隆），不算错
  }
}

function writePack(name, pkg) {
  fs.writeFileSync(packPath(name), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const { version, date } = readVersion();

  if (args.includes('--check')) {
    const drift = [];
    for (const name of PACKS) {
      const pkg = readPack(name);
      if (!pkg) continue;
      if (pkg.version !== version) drift.push({ pack: name, file: pkg.version, want: version });
    }
    // /api/version 读的版本文件本身也是这条链，一并核对
    const pkgVer = String((readPack('codex-proxy') || {}).version || '');
    if (drift.length === 0 && pkgVer === version) {
      process.stdout.write(`${version}\n`);
      return 0;
    }
    process.stderr.write(`版本不一致（VERSION=${version}）：\n`);
    for (const d of drift) process.stderr.write(`  ${d.pack}: package.json=${d.file}，应为 ${d.want}\n`);
    return 1;
  }

  if (args.includes('--write')) {
    for (const name of PACKS) {
      const pkg = readPack(name);
      if (!pkg) continue;
      if (pkg.version === version) continue;
      pkg.version = version;
      writePack(name, pkg);
      process.stdout.write(`  ${name}: ${pkg.version}\n`);
    }
    process.stdout.write(`已同步到 ${version}${date ? `（${date}）` : ''}\n`);
    return 0;
  }

  process.stdout.write(`${version}${date ? `  ${date}` : ''}\n`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(2);
}
