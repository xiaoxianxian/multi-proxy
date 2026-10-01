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
// ⚠️ estTokens 是**估算口径**（CJK 字数×1.04 + 非 CJK 字符×0.255，复用 token-policy.estimateTokens），
//    不是真实 tokenizer、不是 provider usage。对外引用必须标「估算」。
//    2026-10-01 用 129 份真实 SKILL.md 对齐 o200k 校准过；换 Qwen 分词口径可设 TOKEN_CJK_RATIO=0.96。
//   null = 没量过（例如 cursor 的平铺 md 没有单体 SKILL.md），**绝不填 0**——
//    0 会被下游读成「这条 skill 不花钱」。

const fs = require('fs');
const path = require('path');
const SH = require('../l2/skill-hosts.js');
// diff 口径的真源在浏览器/Node 双用模块里，页面（skills.html「基线」按钮）与 CLI 共用同一份，
// 防止两边各自实现导致同一个条目在 CLI 算「没变」、在页面算「新增」。
const LD = require('../multi-proxy-manager/public/skill-ledger-diff.js');

function parseArgs(argv) {
    const args = { hosts: [], out: null, json: false, top: 15, diff: null };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--host') { args.hosts.push(argv[++i]); }
        else if (a === '--out') { args.out = argv[++i]; }
        else if (a === '--json') { args.json = true; }
        else if (a === '--top') { args.top = parseInt(argv[++i], 10) || 15; }
        else if (a === '--diff') { args.diff = argv[++i]; }
        else if (a === '--help' || a === '-h') { args.help = true; }
    }
    return args;
}

// keyOf / diffLedger 直接复用双用模块，本文件不再各写一份（见上方 LD 注释）。
const keyOf = LD.keyOf;
const diffLedger = LD.diffLedger;

function loadLedger(file) {
    let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
    if (!raw || !Array.isArray(raw.entries)) { return null; }        // 不是账本文件就别硬猜
    return raw;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        process.stdout.write(
            '用法: node tools/skill-ledger.js [--host <id>] [--out <file>] [--diff <baseline.json>] [--json] [--top N]\n' +
            '只读扫描各 agent 目录，出一份「skill 上下文资产账本」（含每条 estTokens 估算）。\n' +
            `--out 才落盘，默认只打 stdout；--host 可重复选宿主。\n` +
            `--diff <基线文件> 与基线比：新增/消失/token 变化 + 总量增减。基线就是 --out 落的那份 json。\n` +
            '例：node tools/skill-ledger.js --out ~/.multi-proxy/skill-ledger.json\n' +
            '    node tools/skill-ledger.js --diff ~/.multi-proxy/skill-ledger.json --out ~/.multi-proxy/skill-ledger.json\n'
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

    let diff = null;
    if (args.diff) {
        const base = loadLedger(args.diff);
        if (!base) {
            process.stderr.write(`[skill-ledger] --diff 失败：${args.diff} 读不了或不是账本文件（需要 entries 数组）\n`);
            return 1;
        }
        diff = diffLedger(ledger, base);
    }

    if (args.json) {
        process.stdout.write(JSON.stringify(diff ? { ledger, diff } : ledger, null, 2) + '\n');
        return 0;
    }

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
    if (diff) {
        process.stdout.write(
            `\n=== 与基线对照（基线生成于 ${diff.baselineAt || '未知'}）===\n` +
            `总量 ${diff.tokensFrom} → ${diff.tokensTo}（${diff.tokensDelta >= 0 ? '+' : ''}${diff.tokensDelta}，估算口径）\n`
        );
        const line = (label, arr, fmt) => {
            process.stdout.write(`${label} ${arr.length} 条\n`);
            for (const x of arr.slice(0, args.top)) { process.stdout.write('  ' + fmt(x) + '\n'); }
            if (arr.length > args.top) { process.stdout.write(`  …还有 ${arr.length - args.top} 条\n`); }
        };
        if (diff.addedCount) { line('新增：', diff.added, (x) => `${String(x.estTokens ?? 0).padStart(6)} tok  ${x.key}`); }
        if (diff.removedCount) { line('消失：', diff.removed, (x) => `${String(x.estTokens ?? 0).padStart(6)} tok  ${x.key}`); }
        if (diff.changedCount) {
            line('token 变动（按增减降序）：', diff.changed.sort((a, b) => b.delta - a.delta),
                (x) => `${String(x.from).padStart(6)} → ${String(x.to).padStart(6)}  (${x.delta >= 0 ? '+' : ''}${x.delta}, ×${x.ratio})  ${x.key}`);
        }
        if (!diff.addedCount && !diff.removedCount && !diff.changedCount) { process.stdout.write('  （与基线完全一致：没有新增/消失/变动）\n'); }
        process.stdout.write(`\n可用 --out 把这次的账本存成下一次的基线。\n`);
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
// 导出给 demo 用（纯函数，不碰盘）：parseArgs / diffLedger / keyOf
module.exports = { parseArgs, diffLedger, keyOf };
