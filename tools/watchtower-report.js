#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of of the multi-proxy project.

'use strict';

// watchtower-report —— 「上周花了多少 / 省了多少」终端直出（Watchtower v1 CLI）
//
// 为什么要有 CLI（2026-10-16）：manager 的 `GET /api/cost/watchtower` 要登录态
// （界面 JWT 或机器 token）。本脚本走**本机账本文件**直读，不需要 manager 在跑、
// 不需要登录——crond 里挂一行就能每周出一次报。
//
// 用法：
//   node tools/watchtower-report.js                  # 最近 7 天，读默认账本
//   node tools/watchtower-report.js --days 30        # 最近 30 天
//   node tools/watchtower-report.js --currency USD   # 印币种（不印就是不知道，不猜）
//   node tools/watchtower-report.js --json           # 出 JSON 给上游消费
//   node tools/watchtower-report.js --ledger /path/to/cost-ledger.jsonl
//
// 数据源：`~/.multi-proxy-manager/cost-ledger.jsonl`（lib/cost-track.js 的持久账本）。
// 价表：从 manager 进程内取不到（CLI 是独立进程），所以**「已省金额」需要另外喂价表**：
//   --pricing /path/to/pricing.json   # { modelName: { input, output, cacheHit } }
// 不喂 → saved.byRouting = null，输出印「—」。绝不因为没价表就把「省了多少」印成 0。
//
// 🔴 本脚本只读，不写任何文件。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const costTrack = require(path.join(ROOT, 'multi-proxy-manager/lib/cost-track'));
const watchtower = require(path.join(ROOT, 'l2/watchtower-report'));

function parseArgs(argv) {
    const out = { days: undefined, currency: null, json: false, ledger: null, pricing: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--days') { out.days = parseInt(argv[++i], 10); }
        else if (a === '--currency') { out.currency = argv[++i]; }
        else if (a === '--json') { out.json = true; }
        else if (a === '--ledger') { out.ledger = argv[++i]; }
        else if (a === '--pricing') { out.pricing = argv[++i]; }
        else if (a === '--help' || a === '-h') { out.help = true; }
        else { console.error('未知参数：' + a); process.exit(2); }
    }
    return out;
}

const HELP = [
    'watchtower-report —— 上周花了多少 / 省了多少（只读）',
    '',
    '  node tools/watchtower-report.js [--days N] [--currency CNY|USD]',
    '                                  [--ledger <path>] [--pricing <path>] [--json]',
    '',
    '  --days N      回看天数（默认 7）',
    '  --currency    币种；不传则输出不印货币符号（不知道就不印，不猜）',
    '  --ledger      账本路径（默认 ~/.multi-proxy-manager/cost-ledger.jsonl）',
    '  --pricing     价表 JSON（{ model: { input, output, cacheHit } }，每百万 tokens）',
    '                不传则「已省金额」为 null，输出印「—」',
    '  --json        出 JSON 而非纯文本',
    ''
].join('\n');

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(HELP); return; }
    if (args.days !== undefined && !(args.days > 0)) {
        console.error('--days 需要正整数');
        process.exit(2);
    }

    const entries = costTrack.readLedgerEntries(args.ledger || undefined);

    let pricing = null;
    if (args.pricing) {
        try {
            pricing = JSON.parse(fs.readFileSync(args.pricing, 'utf8'));
        } catch (e) {
            // 价表读不出来 ≠ 价表是空的。空价表会把「省了多少」算成 0，那是假数据。
            console.error('价表读取失败，按未配置处理（已省金额将为 null）：' + e.message);
            pricing = null;
        }
    }

    const report = watchtower.buildWatchtowerReport({
        entries: entries,
        pricing: pricing,
        days: args.days,
        currency: args.currency,
        // 时区（2026-10-16）：与 route 同源，都从 PROXY_COST_TZ 读。
        // CLI 直读本机账本，本地部署默认就是北京时间。
        tz: process.env.PROXY_COST_TZ || undefined,
        now: new Date().toISOString()
    });

    if (args.json) {
        // 空表时给人话提示：JSON 消费方可能是脚本，但人一定会看到这份输出。
        // CLI 是独立进程，读不到 manager 的 env，所以**不断言**「你门控没开」——
        // 只把两种可能和自查命令说清，让读者自己一步定位。
        if (report.spend.entryCount === 0) {
            report.emptyHint = '本窗口没有账本记录。空表不等于没花钱：'
                + '① 未开启记账（manager 需 PROXY_COST_TRACK=1 并重启）；'
                + '② 流量没经过 multi-proxy 或代理连不上 manager（上报失败会打一次 [cost] 警告）。'
                + '自查：ls -la ~/.multi-proxy-manager/cost-ledger.jsonl';
        }
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(watchtower.renderText(report));
        if (report.spend.entryCount === 0) {
            console.log('');
            console.log('本窗口没有账本记录。空表不等于没花钱，两种可能：');
            console.log('  1. 未开启记账 —— manager 进程需设 PROXY_COST_TRACK=1（或 true/on）并重启；');
            console.log('  2. 流量没经过 multi-proxy，或代理连不上 manager（上报失败会打一次 [cost] 警告）。');
            console.log('自查：ls -la ~/.multi-proxy-manager/cost-ledger.jsonl');
        }
    }

    // 退出码：0 = 正常出报（含「算不出」）；2 = 用法错；1 = 账本完全读不到。
    // 不把「没数据」当失败——没数据本身就是周报要告诉你的事。
    if (report.spend.entryCount === 0) process.exitCode = 0;
}

main();
