#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).

// P0-2 → P0-1 离线消费端：把 routing_feedback 聚合跑成「能力画像草稿」，供人工校准
// DEFAULT_CAPABILITY_PROFILES。对应路由能力矩阵 §2.3「evidence 列回填」挂账点。
//
// 用法（先 build，node 跑 .js）：
//   PROXY_ROUTING_FEEDBACK=1 npx tsx scripts/derive-capability-evidence.ts   # 开发期直跑 .ts
//   node scripts/derive-capability-evidence.js                                 # build 后
//
// 输入：--days N（默认 7，即 P0-2 跑一周）
// 输出：stdout 打印每格证据 + 画像草稿 JSON；**只读，不改任何 profile**（校准归人工拍板）。
'use strict';

// .js 版（build 后）：require 已编译产物。tsx 版同逻辑在 .ts 变体里。
const { aggregateFeedback } = require('../src/routing/routeFeedback.js');
const { deriveCapabilityEvidence, toProfileDraft } = require('../src/routing/capability-derive.js');

function parseDays(argv) {
  const i = argv.indexOf('--days');
  const v = i >= 0 ? Number(argv[i + 1]) : 7;
  return Number.isFinite(v) && v > 0 ? v : 7;
}

function main() {
  const days = parseDays(process.argv.slice(2));
  const rows = aggregateFeedback(days);
  if (rows.length === 0) {
    console.log(`[derive-capability] 近 ${days} 天无 routing_feedback 记录。`);
    console.log('  → 先开 PROXY_ROUTING_FEEDBACK=1 跑真实流量，攒够样本再回跑本脚本。');
    console.log('  → 此刻任何 profile 校准都是拍脑袋，与路由能力矩阵「evidence 不编」纪律冲突，故不产出草稿。');
    process.exit(0);
  }
  const evidence = deriveCapabilityEvidence(rows, undefined, new Date().toISOString().slice(0, 10));
  const draft = toProfileDraft(evidence);
  console.log(`[derive-capability] 近 ${days} 天，${rows.length} 格，转发样本见各行 forwarded。`);
  console.log('\n=== 逐格证据 ===');
  for (const e of evidence) {
    const lvl = e.suggestedLevel == null ? '样本不足(null)' : `建议档位 ${e.suggestedLevel}`;
    console.log(`  ${e.model} × ${e.taskType.padEnd(10)} ${lvl}  转发${e.forwarded}  延迟${e.medianLatencyMs ?? '-'}ms  重试${e.retryRate == null ? '-' : (e.retryRate * 100).toFixed(0) + '%'}`);
    console.log(`      判据: ${e.rationale}  (source=${e.source}, date=${e.date})`);
  }
  console.log('\n=== 画像草稿（model → taskType → 档位；null=样本不足，待实测）===');
  console.log(JSON.stringify(draft, null, 2));
  console.log('\n🔴 本草稿仅供人工对照。是否把数值改进 DEFAULT_CAPABILITY_PROFILES 归维护者拍板（能力档位有语义，不自动回写——对齐「宁可留个明处的缺口」纪律）。');
}

main();
