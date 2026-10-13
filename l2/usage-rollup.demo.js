// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// usage-rollup demo — 验证 P1-1 日级用量卷：聚合正确性 / 增量只算新行 / 原子写+备份 / 门控关 no-op / 向后兼容

const os = require('os');
const fs = require('fs');
const path = require('path');
const { createUsageRollup, gateOpen, summarize, mergeRows } = require('./usage-rollup.js');
const { createRunHistory } = require('./run-history/run-history.js');

let pass = 0;
let fail = 0;
function check(cond, label) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label}`); }
}

const src = path.join(os.tmpdir(), `usage-rollup-src-${process.pid}.jsonl`);
const out = path.join(os.tmpdir(), `usage-rollup-${process.pid}.json`);
const DAY = Date.UTC(2026, 9, 13, 10, 0, 0); // 2026-10-13（UTC）

// 逐条源：走 run-history 的 append（G5 逐条 JSONL），用量字段照 cost-track.js:419-439 的真实字段名。
// 显式给 ts（run-history.js:41 是 { ts: Date.now(), ...event }，event 里的 ts 覆盖默认）——钉死日期，demo 才可复现。
const rh = createRunHistory({ enabled: true, logFile: src });
rh.append({ ts: DAY, type: 'usage', proxy: 'codex', model: 'gpt-5', prompt: 100, completion: 50, cacheHit: 10, thinking: 0, cost: 20 });
rh.append({ ts: DAY, type: 'usage', proxy: 'codex', model: 'gpt-5', prompt: 200, completion: 80, cacheHit: 0, thinking: 5, cost: 50 });
rh.append({ ts: DAY, type: 'usage', proxy: 'agnes', model: 'claude-haiku-4-5', prompt: 10, completion: 5, cacheHit: 0, thinking: 0, cost: 1 });

console.log('[usage-rollup demo] T1 聚合正确性');

// T1 纯函数 summarize：3 条 → 2 卷行，同 key 累加
const rows1 = summarize(rh.query());
check(rows1.length === 2, 'T1: 3 条 → 2 个 (date,provider,model) 卷行');
const codex = rows1.find((r) => r.provider === 'codex');
check(codex.date === '2026-10-13' && codex.model === 'gpt-5', 'T1: date/provider/model 键正确');
check(codex.requestCount === 2, 'T1: requestCount 累加 = 2');
check(codex.inputTokens === 300 && codex.outputTokens === 130, 'T1: inputTokens/outputTokens 累加 = 300/130');
check(codex.cacheHitTokens === 10 && codex.thinkingTokens === 5, 'T1: cacheHit/thinking 累加 = 10/5');
check(codex.cost === 70, 'T1: cost 汇总 = 70');

// T2 增量：第二轮只解析 cursor 之后的新行
console.log('[usage-rollup demo] T2 增量只算新行');
const ur = createUsageRollup({ file: out, sourceFile: src, enabled: true });
const r2 = ur.rollup();
check(r2.written === true && r2.scanned === 3, 'T2: 首轮扫 3 条新行');
check(r2.rows.length === 2 && ur.load().cursor === fs.statSync(src).size, 'T2: 卷落盘，cursor 推进到源末尾');

rh.append({ ts: DAY, type: 'usage', proxy: 'codex', model: 'gpt-5', prompt: 7, completion: 3, cacheHit: 1, thinking: 0, cost: 2 });
rh.append({ ts: DAY, type: 'usage', proxy: 'agnes', model: 'claude-haiku-4-5', prompt: 4, completion: 2, cacheHit: 0, thinking: 0, cost: 1 });
const r2b = ur.rollup();
check(r2b.scanned === 2, 'T2: 第二轮只扫 2 条新行（旧行不重算）');
const codex2 = r2b.rows.find((r) => r.provider === 'codex');
check(codex2.requestCount === 3 && codex2.inputTokens === 307 && codex2.cost === 72, 'T2: 增量叠加进旧卷 = 3 次 / 307 token / 72');

// T3 原子写 + 写前备份 + 读回
console.log('[usage-rollup demo] T3 原子写 + 备份 + load 读回');
const dir = path.dirname(out);
check(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')), 'T3: atomic write 后无 .tmp 残留');
const r3 = ur.rollup({ backup: true });
check(r3.backedUp === true && fs.readdirSync(dir).some((f) => f.startsWith(path.basename(out)) && f.includes('.bak-')), 'T3: 写前备份 .bak-<ts> 生成');
const loaded = ur.load();
check(loaded && loaded.rows.length === 2 && loaded.cursor === fs.statSync(src).size, 'T3: load() 读回 rows + cursor');

// T4 门控关 = 全 no-op
console.log('[usage-rollup demo] T4 门控关 no-op');
delete process.env.PROXY_USAGE_ROLLUP;
check(gateOpen() === false, 'T4: env 未设 → gateOpen() = false（默认关）');
const offFile = out + '-off';
const offSrc = src + '-off';
fs.writeFileSync(offSrc, '{"ts":1}\n');
const urOff = createUsageRollup({ file: offFile, sourceFile: offSrc });
const r4 = urOff.rollup({ backup: true });
check(r4.written === false && r4.reason === 'gate-closed', 'T4: gate-off → rollup 返 gate-closed');
check(!fs.existsSync(offFile), 'T4: gate-off → 不落卷文件（零副作用）');
check(fs.readFileSync(offSrc, 'utf8') === '{"ts":1}\n', 'T4: gate-off → 不读/不写源 JSONL');

// T5 容错 + 向后兼容（坏行 / 空行 / 缺 ts / 缺 cacheHit / ISO ts）
console.log('[usage-rollup demo] T5 容错 + 向后兼容');
const legacy = path.join(os.tmpdir(), `usage-rollup-legacy-${process.pid}.jsonl`);
fs.writeFileSync(legacy, '{ 坏行\n\n{"ts":"2026-10-13T00:00:00.000Z","proxy":"openai","model":"m1","prompt":3,"completion":1,"cost":5}\n{"ts":' + DAY + ',"proxy":"openai","model":"m1","prompt":1,"completion":1,"cacheHit":2,"cost":5}\n');
const legacyRows = summarize(createUsageRollup({ file: out + '-l', sourceFile: legacy, enabled: true }).readNew(0).records);
check(legacyRows.length === 1, 'T5: ISO ts 与 epoch ms 归到同一天 → 1 行');
check(legacyRows[0].cacheHitTokens === 2 && legacyRows[0].cost === 10, 'T5: 缺 cacheHit 的老记录按 0 计（向后兼容）');
const noTs = summarize([{ proxy: 'p', model: 'm', prompt: 9, completion: 9 }]);
check(noTs.length === 0, 'T5: 无 ts 的行不入卷（不猜日期）');
const merged = mergeRows([{ date: '2026-10-12', provider: 'p', model: 'm', requestCount: 1, inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, thinkingTokens: 0, cost: 1 }], rows1);
check(merged.length === 3, 'T5: mergeRows 保留旧卷独有的前一天（跨天不丢）');

// T6 跨实例（重启）续跑：新实例读回 cursor，无新行时扫 0 条
console.log('[usage-rollup demo] T6 跨实例续跑');
const ur2 = createUsageRollup({ file: out, sourceFile: src, enabled: true });
const r6 = ur2.rollup();
check(r6.scanned === 0 && r6.rows.length === 2, 'T6: 重启后 cursor 不回退，无新行 → 扫 0 条、卷不漂');

for (const f of [src, out, offSrc, legacy]) { try { fs.unlinkSync(f); } catch { /* noop */ } }
for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`usage-rollup-${process.pid}`) || f.startsWith(`usage-rollup-src-${process.pid}`) || f.startsWith(`usage-rollup-legacy-${process.pid}`)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* noop */ }
    }
}
console.log(`\n[usage-rollup demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
