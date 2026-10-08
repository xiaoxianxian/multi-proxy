// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 health-store demo — 验证 P0-2 provider 健康态持久化（跨重启不丢 + 写前备份 + 合并防无限累积）

const { createHealthStore } = require('./health-store.js');
const os = require('os');
const path = require('path');
const fs = require('fs');

console.log('[HS Demo] Starting...');

const tmpFile = path.join(os.tmpdir(), `health-store-demo-${process.pid}.json`);

   // T1 门控关（默认）：save 直接 no-op，不写文件
const hs1 = createHealthStore({ file: tmpFile, enabled: false });
const r1 = hs1.save({ a: { state: 'CLOSED', failureCount: 0 } });
console.assert(r1.written === false && r1.reason === 'gate-closed', 'T1: gate-off → save no-op');
console.assert(!fs.existsSync(tmpFile), 'T1: gate-off → no file created');
console.log('  T1 PASS: gate-off → save no-op, no file');

   // T2 门控开 + 写前备份：旧文件存在时写 .bak，atomic write 后 load 读回
fs.writeFileSync(tmpFile, JSON.stringify({ ts: 1, snapshot: { old: { state: 'OPEN' } } }));
const hs2 = createHealthStore({ file: tmpFile, enabled: true });
const r2 = hs2.save({ a: { state: 'CLOSED', failureCount: 0 } }, { backup: true });
console.assert(r2.written === true && r2.backedUp === true, 'T2: gate-on + backup → written+backedUp');
const bak = fs.readdirSync(path.dirname(tmpFile)).find((f) => f.startsWith('health-store-demo') && f.includes('.bak-'));
console.assert(!!bak, 'T2: .bak-<ts> backup file created');
const loaded = hs2.load();
console.assert(loaded && loaded.snapshot.a && loaded.snapshot.a.state === 'CLOSED', 'T2: load() round-trips new snapshot');
console.log('  T2 PASS: atomic write + .bak backup + load round-trip');

   // T3 load 容错：文件损坏/缺失 → 返 null，不崩
fs.writeFileSync(tmpFile, '{ not valid json ');
console.assert(hs2.load() === null, 'T3: corrupt file → load() null (容错)');
fs.unlinkSync(tmpFile);
console.assert(hs2.load() === null, 'T3: missing file → load() null');
console.log('  T3 PASS: corrupt/missing → load() null, no throw');

   // T4 merge：fresh 覆盖 prev，prev 独有保留
const merged = hs2.merge(
     { p1: { state: 'OPEN' }, p2: { state: 'CLOSED' } }, // prev
     { p2: { state: 'HALF_OPEN', lastChecked: 99 }, p3: { state: 'CLOSED' } } // fresh
    );
console.assert(merged.p2.state === 'HALF_OPEN', 'T4: fresh overrides prev (p2)');
console.assert(merged.p1.state === 'OPEN', 'T4: prev-only preserved (p1)');
console.assert(merged.p3 && Object.keys(merged).length === 3, 'T4: fresh-only added (p3), total 3');
console.log('  T4 PASS: merge — fresh overrides, prev-only preserved, fresh-only added');

   // T5 merge(prev=null)：无旧快照时 = fresh
const mergedEmpty = hs2.merge(null, { p1: { state: 'OPEN' } });
console.assert(mergedEmpty.p1 && Object.keys(mergedEmpty).length === 1, 'T5: merge(null, fresh) = fresh');
console.log('  T5 PASS: merge(null prev) = fresh only');

   // T6 门控关时 save 的 .bak 也不写（no-op 彻底零副作用）
const hs6 = createHealthStore({ file: tmpFile + '-6', enabled: false });
fs.writeFileSync(tmpFile + '-6', JSON.stringify({ ts: 1, snapshot: {} }));
const r6 = hs6.save({ x: { state: 'OPEN' } }, { backup: true });
console.assert(r6.written === false && r6.reason === 'gate-closed', 'T6: gate-off → no-op even with backup=true');
console.log('  T6 PASS: gate-off → save fully no-op (no write, no backup)');

   // 清理
for (const f of [tmpFile, tmpFile + '-6']) { try { fs.unlinkSync(f); } catch { /* noop */ } }
console.assert(!fs.existsSync(tmpFile), 'T-cleanup: demo files removed');
console.log('  T-cleanup PASS: demo temp files removed');

console.log('\n[HS Demo] ALL PASS (6/6, P0-2)');
