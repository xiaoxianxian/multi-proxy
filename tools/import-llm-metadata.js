#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== tools/import-llm-metadata.js（P5-D）====================
// 把 basellm/llm-metadata 的 dist/api/all.json 导入本站价表
// （~/.multi-proxy-manager/pricing.json）。
//
// 用法：
//   node tools/import-llm-metadata.js <all.json 路径> [--dry-run] [--currency CNY] [--date YYYY-MM-DD]
//
// 设计纪律（与 P2/P4 一脉相承）：
//   · **add-only**：pricing.json 里已有的 id 一律不动，导入只补新条目。用户手填表永远赢。
//   · **先备份再写**：写入前把原表复制成 pricing.json.bak-<日期>（无 git 的项目里，
//     备份是唯一回滚路径；agent 纪律「动手前先 cp」的脚本版）。
//   · **语义反转**：llm-metadata 的 base=闲时价、windows=peak；本站反之。转换逻辑与
//     单测在 multi-proxy-manager/lib/model-catalog.js，本脚本只做 IO 与展示。
//   · **不联网**：all.json 由用户自己下载（gh api / curl raw），脚本不主动请求网络 ——
//     导入是一次性显式动作，不是后台常驻。
//   · **dry-run 默认展示 skipped 理由**：导了多少、跳过了什么、为什么，全部可见。

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  importLlmMetadataCatalog,
} = require('../multi-proxy-manager/lib/model-catalog');

const HOME = process.env.HOME || os.homedir();
const PRICING_FILE = path.join(HOME, '.multi-proxy-manager', 'pricing.json');
const DEFAULT_SOURCE_URL = 'https://github.com/basellm/llm-metadata（dist/api/all.json）';

function parseArgs(argv) {
  const args = { dryRun: false, currency: 'CNY', date: new Date().toISOString().slice(0, 10), file: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--currency') args.currency = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (!args.file) args.file = a;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('用法: node tools/import-llm-metadata.js <all.json 路径> [--dry-run] [--currency CNY] [--date YYYY-MM-DD]');
    process.exit(2);
  }
  if (!fs.existsSync(args.file)) {
    console.error(`文件不存在: ${args.file}`);
    process.exit(2);
  }

  let allJson;
  try {
    allJson = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } catch (e) {
    console.error(`all.json 解析失败: ${e.message}`);
    process.exit(2);
  }

  // 现表（没有就从空数组开始；pricing.json 允许是带 _readme 占位项的数组）
  let table = [];
  if (fs.existsSync(PRICING_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
      if (Array.isArray(parsed)) table = parsed;
    } catch (e) {
      console.error(`现表解析失败（终止，不覆盖坏文件）: ${e.message}`);
      process.exit(2);
    }
  }
  const existingIds = new Set(
    table.filter((e) => e && typeof e.id === 'string' && !e._placeholder && !e._readme).map((e) => e.id)
  );

  const { entries, skipped } = importLlmMetadataCatalog(allJson, {
    existingIds,
    preferCurrency: args.currency,
    retrievedAt: args.date,
    sourceUrl: DEFAULT_SOURCE_URL,
  });

  console.log(`\n=== llm-metadata 导入${args.dryRun ? '（dry-run，不写盘）' : ''} ===`);
  console.log(`价表: ${PRICING_FILE}`);
  console.log(`现有条目: ${existingIds.size}；待导入: ${entries.length}；跳过: ${skipped.length}\n`);

  for (const e of entries) {
    const sched = e.offPeakPricing ? ` + off-peak[${e.offPeakPricing.windows.map((w) => w.hoursUtc.join('/')).join(' ; ')}]` : '';
    console.log(`  + ${e.id}: ¥${e.pricing.input}/¥${e.pricing.output}${e.pricing.cacheHit != null ? `/cache ¥${e.pricing.cacheHit}` : ''}${sched}`);
  }
  const skipById = new Map();
  for (const s of skipped) {
    if (!skipById.has(s.id)) skipById.set(s.id, s.reason);
    else skipById.set(s.id, skipById.get(s.id) + '；' + s.reason);
  }
  if (skipById.size > 0) {
    console.log('\n--- 跳过（附理由）---');
    for (const [id, reason] of skipById) console.log(`  - ${id}: ${reason}`);
  }

  if (args.dryRun || entries.length === 0) {
    if (!args.dryRun && entries.length === 0) console.log('\n没有可导入的新条目，未改动价表。');
    return;
  }

  // 备份 → 追加 → 原子写
  const backup = `${PRICING_FILE}.bak-${args.date}`;
  try {
    fs.copyFileSync(PRICING_FILE, backup);
    console.log(`\n已备份: ${backup}`);
  } catch (e) {
    if (fs.existsSync(PRICING_FILE)) {
      console.error(`备份失败，终止（不写）: ${e.message}`);
      process.exit(1);
    }
  }
  const merged = table.concat(entries);
  const tmp = `${PRICING_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, PRICING_FILE);
  console.log(`已写入 ${entries.length} 条 → ${PRICING_FILE}（共 ${merged.length} 项）`);
  console.log('提示：cost-track 在网关**重启后**读取新价表；运行中改价表不热加载。');
}

main();
