#!/usr/bin/env node
// agent-conflict-check CLI 入口
//
// 用法：
//   node cli.js                 # 人类可读报告（默认）
//   node cli.js --json          # JSON 输出（供脚本/其它工具消费）
//   node cli.js --quiet         # 只在有冲突时输出，否则静默
//   PROXY_OCCUPANT_PORTS=15721,12345 node cli.js   # 自定义占用端口清单
//
// 退出码：0 = 无冲突；1 = 检测到冲突；2 = 用法/运行错误。
//
// 设计：零依赖（仅 Node 内置 fs/os/path），不要求整套 multi-proxy 安装。
// 检测逻辑镜像 multi-proxy-manager/lib/agent-owner.js（见 conflict-check.js 头部说明）。

'use strict';

const { detectAll, occupantPorts } = require('./conflict-check.js');

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const quiet = argv.includes('--quiet');

  let results;
  try {
    results = detectAll();
  } catch (e) {
    if (!quiet) {
      process.stderr.write(`agent-conflict-check 运行失败：${e && e.message || e}\n`);
    }
    process.exit(2);
  }

  const conflicts = results.filter((r) => r.occupied);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      occupantPorts: occupantPorts(),
      checked: results,
      conflicts,
      hasConflict: conflicts.length > 0,
    }, null, 2) + '\n');
  } else if (quiet) {
    if (conflicts.length) {
      for (const c of conflicts) {
        process.stdout.write(`${c.agent} 被占用：base_url=${c.baseUrl}（占用者 ${c.by}）\n`);
      }
    }
  } else {
    process.stdout.write('=== 代理所有权冲突检测 ===\n');
    process.stdout.write(`占用端口清单：${occupantPorts().join(', ') || '（空）'}\n\n`);
    for (const r of results) {
      if (r.occupied) {
        process.stdout.write(`✗ ${r.agent} 被占用\n    base_url=${r.baseUrl}\n    占用者=${r.by}\n`);
      } else if (r.baseUrl) {
        process.stdout.write(`✓ ${r.agent} 正常（base_url=${r.baseUrl}）\n`);
      } else {
        process.stdout.write(`· ${r.agent} 未配置 base_url（跳过，不误报）\n`);
      }
    }
    process.stdout.write('\n');
    if (conflicts.length) {
      process.stdout.write(`结论：检测到 ${conflicts.length} 处冲突 —— 在 multi-proxy 与占用者之间二选一，确认端口归属后再启动服务。\n`);
    } else {
      process.stdout.write('结论：无冲突。\n');
    }
  }

  process.exit(conflicts.length ? 1 : 0);
}

main();
