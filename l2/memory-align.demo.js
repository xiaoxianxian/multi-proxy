// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 memory-align demo（D1「记忆对齐接内核」方案 A 验收 demo）。
// 照 memory-merge.demo.js 风格：check(name, fn) → PASS/FAIL + 汇总，全过则 exit(0)。
//
// 验收 §7.5 四要件中的前 3 项（第 4 项「门控关零回归」由 run-demos/l2-bootstrap 门控测覆盖）：
//   ① pull 增量对齐：mtime 前进 → 产出 absorbed，登记进水位；mtime 不回退 → 0 新吸收。
// ② push pending：reader 侧登记 pending entries。
// ③ shadow 默认：wrote=false（只算不写盘，backing 默认内存）；off 直接跳过；on 落盘。
//     + 非侵入：newMemoryAlignStorage(dir) 只写注入 dir，绝不写 ~/.workbuddy / ~/.hermes。
//     + 注册面隔离：registerAlignment 进对齐 storage，不污染 AgentRegistry 的 agent profile list。

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { createMemoryAlign, createMemoryBacking } = require('./memory-align.js');
const ar = require('./agent-registry.js');
const { asDoc, SPEC_VERSION } = require('./memory-merge.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
    try {
        const ok = fn();
        if (ok === true || ok === undefined || ok === null) {
            pass++;
            console.log(`  PASS  ${name}`);
         } else {
            fail++;
            console.log(`  FAIL  ${name} → ${(ok && ok.message) || ok}`);
         }
     } catch (e) {
        fail++;
        console.log(`  FAIL  ${name} → 抛异常: ${e.message}`);
     }
}

// 规范 entry 工厂：specVersion / id / key / value / tags 五件套，过 memory-merge.entryValid。
function ce(id, type, key, value, tags) {
    return { id, type, key, value, tags: tags || [], specVersion: SPEC_VERSION };
}

console.log('=== L2 memory-align demo（D1 方案 A 验收） ===');

console.log('   -- pull 增量对齐 --');
check('mtime 前进 → 产出 absorbed + 水位记账', () => {
    const targetDoc = asDoc({
        specVersion: SPEC_VERSION,
        entries: [
             ce('e1', 'lesson', 'k1', '教训1', ['根因']),
             ce('e2', 'preference', 'k2', '偏好2', ['用户']),
             ce('e3', 'note', 'k3', '噪声'), // 不在白名单（lesson/preference/error-pattern/template/trigger）
         ],
     });
    const log = { log() {}, push_shadow() {} };
    const align = createMemoryAlign({ target: 'workbuddy', mode: 'shadow', logger: log });
    const r = align.pull(targetDoc, 1000);
    if (!r) return { message: 'pull 返 null' };
    if (r.absorbed.length !== 2) return { message: `absorbed=${r.absorbed.length} 预期 2（note 不在白名单）` };
    if (r.absorbed.some((a) => a.type === 'note')) return { message: 'note 类型泄漏' };
    const wm = align.readWatermark();
    if (wm.absorbed.length !== 2) return { message: `水位 absorbed=${wm.absorbed.length}` };
    if (wm._mtimeSeen !== 1000) return { message: `_mtimeSeen=${wm._mtimeSeen}` };
    return true;
});

check('mtime 不回退 → 0 新吸收（不重复）', () => {
    const targetDoc = asDoc({
        specVersion: SPEC_VERSION,
        entries: [ce('e1', 'lesson', 'k1', '教训1', ['根因'])],
     });
    const align = createMemoryAlign({ target: 'workbuddy', mode: 'shadow' });
    align.pull(targetDoc, 1000);
    const r2 = align.pull(targetDoc, 900);
    if (r2.isNew) return { message: 'mtime 回退仍 isNew' };
    if (align.readWatermark().absorbed.length !== 1) {
        return { message: `重复吸收, watermark.absorbed=${align.readWatermark().absorbed.length}` };
     }
    return true;
});

console.log('   -- push pending --');
check('push 登记 reader 侧 pending（白名单过滤）', () => {
    const align = createMemoryAlign({ reader: 'hermes', target: 'workbuddy', mode: 'shadow' });
    const r = align.push([
         ce('p1', 'lesson', 'foo', 'v1', ['a']),
         ce('p2', 'preference', 'bar', 'v2'),
         ce('p3', 'note', 'noise', '噪声'), // 类型不在白名单，应被过滤
     ]);
    if (r.pushed !== 2) return { message: `pushed=${r.pushed} 预期 2（note 被过滤）` };
    if (!align.readWatermark().pending.find((p) => p.id === 'p1')) return { message: 'pending 缺 p1' };
    return true;
});

console.log('   -- 三态：shadow / off / on --');
check('shadow 默认：记账但 wrote=false（不落盘）', () => {
    const backing = createMemoryBacking();
    const align = createMemoryAlign({ mode: 'shadow', storage: backing });
    const r = align.push([ce('p1', 'lesson', 'k', 'v')]);
    assert.strictEqual(r.wrote, false, 'shadow 应 wrote=false');
    assert.strictEqual(backing.size(), 1, 'shadow 应对内存 backing 记账（1 条）');
    assert.strictEqual(align.status().pendingCount, 1, 'status 可见 1 条');
    return true;
});

check('off：直接跳过', () => {
    const backing = createMemoryBacking();
    const align = createMemoryAlign({ mode: 'off', storage: backing });
    const r = align.push([ce('p1', 'lesson', 'k', 'v')]);
    assert.strictEqual(r.skipped, true, 'off 应 skipped');
    assert.strictEqual(r.pushed, 0, 'off 应 0 条');
    assert.strictEqual(backing.size(), 0, 'off 不应记账');
    return true;
});

check('on：写 backing（落盘模式语义）', () => {
    const backing = createMemoryBacking();
    const align = createMemoryAlign({ mode: 'on', storage: backing });
    const r = align.push([ce('p1', 'lesson', 'k', 'v')]);
    assert.strictEqual(r.wrote, true, 'on 应 wrote=true');
    assert.strictEqual(backing.size(), 1, 'on 应落 1 条');
    return true;
});

console.log('   -- 非侵入 + 注册面隔离 --');
check('newMemoryAlignStorage(dir) 只写注入 dir，0 碰 home', () => {
    const dir = path.join(os.tmpdir(), 'align-test-' + Date.now());
    const store = ar.newMemoryAlignStorage(dir);
    store.set('hermes', 'workbuddy', { reader: 'hermes', target: 'workbuddy' });
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    if (!files.some((f) => /-to-/.test(f))) return { message: '注入 dir 无对齐文件' };
    for (const home of [os.homedir() + '/.workbuddy', os.homedir() + '/.hermes']) {
        if (fs.existsSync(home) && fs.statSync(home).isFile()) return { message: `误写 home: ${home}` };
     }
     try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return true;
});

check('registerAlignment 不污染 AgentRegistry profile 列表', () => {
    const reg = new ar.AgentRegistry({ storage: ar.newMemoryStorage() });
    reg.registerAlignment('hermes', 'workbuddy', { last_sync: '2026-10-06' });
    reg.registerAlignment('hermes', 'workbuddy', { absorbed: [{ id: 'x' }] });
    if (reg.listAlignments().length !== 1) return { message: `listAlignments=${reg.listAlignments().length} 预期 1（覆盖更新）` };
    if (reg.count() !== 0) return { message: `count(profile)=${reg.count()} 预期 0` };
    return true;
});

console.log(`\n=== 汇总: PASS=${pass} / FAIL=${fail} ===`);
if (fail > 0) {
    console.error('memory-align demo → 有 FAIL，非全绿');
} else {
    console.log('memory-align demo → ALL GREEN');
}
process.exit(fail === 0 ? 0 : 1);
