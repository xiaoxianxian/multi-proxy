#!/usr/bin/env node
'use strict';
// skill-ledger · 把散在各 agent 目录里的 skill 汇成一份「上下文资产账本」
//
// 来源：2026-10-01 SkillSwitch 对照（docs/10-initiatives/48）。它只管「装不装」，
// 不管「装了之后上下文多贵」。本工具补的正是后半句：每条 skill 值多少 token。
//
// 只读：扫 ~/.hermes/skills、~/.workbuddy/skills …… 只读，不写任何 agent 目录。
// 落盘**默认不做**——显式传 --out 才写文件（避免好人撞上意外副作用）。
//
// 用法：
//   node tools/skill-ledger.js                        # 全量扫描，打到 stdout
//   node tools/skill-ledger.js --host hermes --host workbuddy
//   node tools/skill-ledger.js --out ~/.multi-proxy/skill-ledger.json
//   node tools/skill-ledger.js --json                 # 纯 JSON（给别的脚本吃）
//
// ⚠️ estTokens 是**估算口径**（长度/3，复用 token-policy.estimateTokens），
//    不是真实 tokenizer、不是 provider usage。对外引用必须标「估算」。
//   null = 没量过（例如 cursor 的平铺 md 没有单体 SKILL.md），**绝不填 0**——
//    0 会被下游读成「这条 skill 不花钱」。

const fs = require('fs');
const path = require('path');
const SH = require('../l2/skill-hosts.js');

function parseArgs(argv) {
    const args = { hosts: [], out: null, json: false, top: 15 };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--host') { args.hosts.push(argv[++i]); }
        else if (a === '--out') { args.out = argv[++i]; }
        else if (a === '--json') { args.json = true; }
        else if (a === '--top') { args.top = parseInt(argv[++i], 10) || 15; }
        else if (a === '--help' || a === '-h') { args.help = true; }
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(
            '用法: node tools/skill-ledger.js [--host <id>] [--out <file>] [--json] [--top N]\n' +
            '只读扫描各 agent 目录，出一份「skill 上下文资产账本」（含每条 estTokens 估算）。\n' +
            `--out 才落盘，默认只打 stdout；--host 可重复选宿主。\n`
        );
        return 0;
    }

    let ledger;
    try {
        ledger = SH.scanLedger({ ...(args.hosts.length ? { hosts: args.hosts } : {}) });
    } catch (e) {
        process.stderr.write(`skill-ledger: 扫描失败: ${e.message}\n`);
        return 1;
    }

    if (args.out) {
        const dir = path.dirname(path.resolve(args.out));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.out, JSON.stringify(ledger, null, 2), 'utf8');
        process.stderr.write(`[skill-ledger] 已落盘 ${args.out}\n`);
    }

    if (args.json) { process.stdout.write(JSON.stringify(ledger, null, 2) + '\n'); return 0; }

    const t = ledger.totals;
    process.stdout.write(`\n=== Skill 上下文资产账本（${ledger.generatedAt}）===\n\n`);
    process.stdout.write('宿主              已装  标准  嵌套  平铺  禁用   SkillSwitch    token(估)\n');
    for (const h of ledger.hosts) {
        process.stdout.write(
            `${h.host.padEnd(18)}${String(h.total).padStart(4)}${String(h.standard).padStart(6)}` +
            `${String(h.nested).padStart(6)}${String(h.looseMd).padStart(6)}${String(h.disabled).padStart(6)}` +
            `   ${(h.skillSwitch ? '是' : '否').padStart(2)}         ${String(h.tokens).padStart(8)}\n`
        );
    }
    process.stdout.write(
        `\n合计 ${t.entries} 条：已量 ${t.measured}，跳过(无单体入口) ${t.skipped}，` +
        `共占约 ${t.tokens} tokens（估算口径）\n\n`
    );

    const top = ledger.entries
        .filter((e) => e.estTokens != null)
        .sort((a, b) => b.estTokens - a.estTokens)
        .slice(0, args.top);
    process.stdout.write(`最贵的 ${top.length} 条（估算）：\n`);
    for (const e of top) {
        const cat = e.category ? `${e.category}/` : '';
        process.stdout.write(
            `  ${String(e.estTokens).padStart(6)} tok  ${e.host}/${cat}${e.name}` +
            `${e.disabled ? '  [已禁用]' : ''}\n`
        );
    }
    const ss = ledger.hosts.filter((h) => !h.skillSwitch && h.exists);
    if (ss.length) {
        process.stdout.write(
            `\n不在 SkillSwitch 五件套里、但本机确有安装的宿主：${ss.map((h) => h.host).join(', ')}\n`
        );
    }
    process.stdout.write('');
    return 0;
}

if (require.main === module) { process.exit(main()); }
module.exports = { parseArgs };
