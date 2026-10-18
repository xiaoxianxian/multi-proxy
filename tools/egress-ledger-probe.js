// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// tools/egress-ledger-probe.js —— 用真实语料给 l2/egress-ledger.js 出数（只读探针）
//
// 为什么要有这个探针：账本本身是被动的（等人喂数据）。要证明它"能用、能出数、边界在哪"，
// 必须拿**真东西**跑一遍，而不是只在单测里造理想数据。本探针跑两件事：
//
//   ① 真实语料：读 logs/bridge-corpus-*.jsonl（multi-proxy 自己记的请求体），
//      算出真实的每行出站字节、按 agentType 拆账。
//   ② ZCode 对照行：把 ZCode 事件（2026-09-18）的真实参数喂进同一套判据，
//      看三条判据会不会命中——这是**判据本身的效度验证**，不是性能演示。
//
// 诚实交代（跑完你会看到 ratio 全是 null，这不是 bug）：
//   这批语料只有**请求体**，没有 usage 回包，也没有 destHost 字段。所以
//   tokensMissing=true、ratio=null —— 账本照实记"算不出"，不填 0 充数。这正是本模块
//   的核心纪律。⇒ 要让 ratio 出数，热路径必须补两个字段：上游 host + usage.totalTokens。
//
// 只读：不写任何文件、不改任何状态。require.main 守卫 ⇒ 可复跑、可 require。
//
// 跑法：node tools/egress-ledger-probe.js [corpus.jsonl ...]

const fs = require('node:fs');
const path = require('node:path');
const E = require('../l2/egress-ledger.js');

const DEFAULT_CORPUS = [
    'logs/bridge-corpus-2026-10-01.jsonl',
    'logs/bridge-corpus-2026-10-02.jsonl',
];

// ZCode 事件的真实参数（一手：ferstar 2026-09-18 逆向分析，见 l2/egress-ledger.js 头注释）
const ZCODE_SNAPSHOT_BYTES = 313070842;   // 313,070,842 = 磁盘上那份 .enc
const ZCODE_WORKSPACE_BYTES = 345549173;  // 345,549,173 = 压缩前工作区
const ZCODE_FILE_COUNT = 42411;

/**
 * 纯函数：一行 jsonl → 账本条目。
 * client ← agentType（语料有）；destHost ← 语料没有，诚实置 null；
 * bytes ← body 的 UTF-8 真实字节；tokens ← 请求体里本质是拿不到的。
 */
function rowToEntry(row) {
    const o = (row && typeof row === 'object') ? row : {};
    return {
        ts: Number.isFinite(o.ts) ? o.ts : null,
        client: o.agentType || null,
        destHost: null,
        bytes: (o.body != null) ? Buffer.byteLength(JSON.stringify(o.body), 'utf8') : null,
        tokens: null,
        proxy: `${o.api || 'unknown'}:${o.path || ''}`,
    };
}

/** 读一个 jsonl → 条目数组。读不动返回 null（照实说，不静默吞掉）。 */
function readCorpus(file) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return text.trim().split('\n')
            .filter((l) => l.length > 0)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
    } catch (e) {
        return null;
    }
}

function run(corpusFiles) {
    const lines = [];
    lines.push('# Egress Ledger Probe（只读 · 真实语料 + ZCode 对照）');
    lines.push('');
    lines.push(`门控 ${E.GATE_ENV} = ${E.gateOpen() ? '开' : '关（默认，符合非侵入铁律）'}`);
    lines.push('');

    lines.push('## 一、真实语料出站账');
    lines.push('');
    lines.push('| 文件 | 行 | 出站字节(bytesFound) | 算不出(bytesMissing) | agentType |');
    lines.push('|---|---|---|---|---|');

    const ledger = E.createEgressLedger();
    let corpusTotal = 0;
    for (const f of corpusFiles) {
        const rows = readCorpus(f);
        if (rows === null) { lines.push(`| ${f} | — | — | — | **读不了** |`); continue; }
        const bytesHit = rows.map(rowToEntry).filter((e) => e.bytes != null);
        for (const e of rows.map(rowToEntry)) ledger.record(e);
        const sum = bytesHit.reduce((a, e) => a + e.bytes, 0);
        corpusTotal += sum;
        const agents = [...new Set(rows.map((r) => r.agentType || '<unknown>'))].join(' / ');
        lines.push(`| ${path.basename(f)} | ${rows.length} | ${sum.toLocaleString()} | ${rows.length - bytesHit.length} | ${agents} |`);
    }
    lines.push('');

    const rep = ledger.report();
    lines.push(`合计：${rep.totalBytes.toLocaleString()} 字节（${rep.bytesFound} 行量到，${rep.bytesMissing} 行没量到）`);
    lines.push('');
    lines.push('按 client 拆账：');
    for (const [k, v] of Object.entries(rep.perClient)) {
        lines.push(`  - ${k}: ${v.count} 行 / ${v.bytes.toLocaleString()} 字节`);
    }
    lines.push('');

    lines.push('## 二、为什么 ratio 全是 null（诚实分支实证）');
    lines.push('');
    const sample = ledger.getRows()[0];
    const c = E.classify(sample || {}, {});
    lines.push(`抽样第一行：tokens=${String(sample ? sample.tokens : null)} bytes=${String(sample ? sample.bytes : null)}`);
    lines.push(`→ classify: tokensMissing=${c.tokensMissing} ratio=${String(c.ratio)} anomalies=[${c.anomalies.join(', ')}]`);
    lines.push('');
    lines.push('**这组语料只有请求体、没有 usage 回包，也没有 destHost 字段** →');
    lines.push('账本照实记"算不出"，不填 0 冒充"没出站/比值正常"。这正是它和假数字的分界线。');
    lines.push('要使 ratio 出数，热路径需补两个字段：**上游 host** + **usage.totalTokens**。');
    lines.push('');

    lines.push('## 三、ZCode 对照：判据效度验证（真实事件参数）');
    lines.push('');
    lines.push(`ZCode 快照：${ZCODE_SNAPSHOT_BYTES.toLocaleString()} 字节 / 源工作区 ${ZCODE_WORKSPACE_BYTES.toLocaleString()} 字节 / ${ZCODE_FILE_COUNT.toLocaleString()} 个文件`);
    lines.push('');

    // 已知 provider 清单里显然没有对象存储域
    const knownHosts = ['api.openai.com', 'api.anthropic.com', 'api.deepseek.com', 'open.bigmodel.cn'];

    const zcodeRow = {
        ts: Date.now(),
        client: 'zcode-desktop',
        destHost: 'zcode-checkpoint.oss-cn-beijing.aliyuncs.com',
        bytes: ZCODE_SNAPSHOT_BYTES,
        tokens: null,          // 快照上传与 LLM 推理无关，本就没有 token
    };
    const z = E.classify(zcodeRow, { knownHosts });
    lines.push(`喂进去：client=zcode-desktop destHost=aliyuncs.com bytes=${ZCODE_SNAPSHOT_BYTES.toLocaleString()} tokens=null`);
    lines.push(`→ anomalies = [${z.anomalies.join(', ')}]`);
    lines.push('');

    const anomalies = z.anomalies;
    lines.push('| 判据 | 命中 | 说明 |');
    lines.push('|---|---|---|');
    lines.push(`| oversize（>50MB） | ${anomalies.includes('oversize') ? '✅' : '❌'} | 313MB 远超单次 LLM 请求体量级 |`);
    lines.push(`| unknown-host | ${anomalies.includes('unknown-host') ? '✅' : '❌'} | 对象存储域不在 provider 清单里 |`);
    lines.push(`| volume-token-ratio | ${anomalies.includes('volume-token-ratio') ? '✅' : '—'} | tokens 缺失 → ratio=null，**按纪律不算**，由上面两条兜 |`);
    lines.push('');
    lines.push('⇒ 结论：**即便 ratio 缺席，ZCode 这条仍有两条判据独立命中。**');
    lines.push('  这就是"体量 + 目的地"两个维度组合起来的价值——不需要认识包里是什么');
    lines.push('  （`.git` 占 86.6% 这件事我们压根不知道），只需要知道"谁往哪儿发了多少"。');
    lines.push('');
    lines.push('## 四、🔴 边界提醒（不许简化掉）');
    lines.push('');
    lines.push('本账本只对**真正过 multi-proxy 这一跳**的流量有效。ZCode 当年是客户端自己');
    lines.push('直连 OSS，压根不经过任何代理 ⇒ 真实的 ZCode 行为，这一层照样看不见。');
    lines.push('它是**观测件**，不是防线。防线在网络层/进程层（见 Portico `27` §2.1）。');
    lines.push('');

    return lines.join('\n');
}

if (require.main === module) {
    const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_CORPUS;
    const abs = files.map((f) => path.isAbsolute(f) ? f : path.join(__dirname, '..', f));
    console.log(run(abs));
}

module.exports = { run, readCorpus, rowToEntry, DEFAULT_CORPUS };
