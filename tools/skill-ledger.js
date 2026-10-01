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

// 账本之间做 diff。基线就是 `--out` 落的那份 json（ledger 原样），读回来即可。
// 条目主键 = host[/category]/name —— 跟明细表显示的路径一致，别另造一套 key 否则两边对不上。
function keyOf(e) {
    return [e.host, e.category || '', e.name].filter(Boolean).join('/');
}

function diffLedger(cur, base) {
    const bMap = new Map((base.entries || []).map((e) => [keyOf(e), e]));
    const cMap = new Map((cur.entries || []).map((e) => [keyOf(e), e]));
    const added = [], removed = [], changed = [];
    for (const [k, e] of cMap) {
        const b = bMap.get(k);
        if (!b) { added.push({ key: k, host: e.host, name: e.name, estTokens: e.estTokens }); continue; }
        if (b.estTokens !== e.estTokens) {
            changed.push({ key: k, host: e.host, name: e.name, from: b.estTokens, to: e.estTokens,
                delta: e.estTokens - b.estTokens, ratio: b.estTokens ? +(e.estTokens / b.estTokens).toFixed(3) : null });
        }
    }
    for (const [k, e] of bMap) { if (!cMap.has(k)) { removed.push({ key: k, host: e.host, name: e.name, estTokens: e.estTokens }); } }
    const sum = (a, f) => a.reduce((n, x) => n + (f ? f(x) : 0), 0);
    const bt = (base.totals && base.totals.tokens) || 0;
    const ct = (cur.totals && cur.totals.tokens) || 0;
    return {
        baselineAt: base.generatedAt || null,
        added, removed, changed,
        addedCount: added.length, removedCount: removed.length, changedCount: changed.length,
        addedTokens: sum(added, (x) => x.estTokens || 0),
        removedTokens: -sum(removed, (x) => x.estTokens || 0),
        tokensDelta: ct - bt,
        tokensFrom: bt, tokensTo: ct,
    };
}

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
