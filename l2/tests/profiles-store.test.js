// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * l2/profiles-store.js 单元测试（node:test，零第三方依赖）。
 *
 * 覆盖（对照源码注释里的红线）：
 *   1. 门控关 = save/switchTo 全 no-op（零行为变更）。
 *   2. save → load 往返；首个 profile 自动成为 active；list 排序。
 *   3. switchTo：原子切换（from/to/active 更新）、不存在的 profile → not-found。
 *   4. 写前外部改动检测：本进程写过之后盘上被外部改过 → external-change，
 *      不静默覆盖；load() 读过一次后（记住新哈希）后续写放行。
 *   5. commit 自检钩子失败 → verify-failed + 回滚（原本没有文件则删掉，不留半条）。
 *   6. 第二次保存产生 .bak-<ts> 命名备份。
 *
 * 跑法：node --test tests/profiles-store.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProfilesStore } = require('../profiles-store');

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-profiles-'));
  const file = path.join(dir, 'profiles.json');
  return { dir, file, store: createProfilesStore({ file, ...opts }) };
}

test('门控关 = save/switchTo 全 no-op，文件不落地', () => {
  const { file, store } = tmpStore({ enabled: false });
  assert.equal(store.isEnabled(), false);
  const s = store.save('work', { providers: [] });
  assert.deepEqual(s, { written: false, reason: 'gate-closed' });
  const sw = store.switchTo('work');
  assert.deepEqual(sw, { switched: false, reason: 'gate-closed' });
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.load(), null);
  assert.deepEqual(store.list(), { names: [], active: null, externalModified: false });
});

test('save → load 往返；首个 profile 自动成为 active', () => {
  const { store } = tmpStore({ enabled: true });
  const r = store.save('work', { providers: ['openai'], settings: { temp: 1 } });
  assert.equal(r.written, true);
  assert.equal(r.backedUp, false, '首次保存前无文件，不产 .bak');
  assert.ok(typeof r.hash === 'string' && r.hash.length === 64);
  assert.equal(store.active(), 'work', '首个 profile 自动成为当前');

  const back = store.load();
  assert.equal(back.name, 'work');
  assert.deepEqual(back.snapshot, { providers: ['openai'], settings: { temp: 1 } });
  assert.equal(back.active, true);

  const byName = store.load('work');
  assert.equal(byName.name, 'work');
  assert.equal(store.load('nope'), null, '不存在的名字 → null');
});

test('save 多个 profile：list 排序，active 不被后来者抢走', () => {
  const { store } = tmpStore({ enabled: true });
  store.save('zeta', { v: 1 });
  store.save('alpha', { v: 2 });
  assert.deepEqual(store.list().names, ['alpha', 'zeta']);
  assert.equal(store.active(), 'zeta', 'active 仍是首个，不被第二个顶掉');
  // 更新已有 profile：快照被替换，active 不变
  const r = store.save('zeta', { v: 99 });
  assert.equal(r.written, true);
  assert.equal(r.backedUp, true, '第二次保存前有文件，产 .bak-<ts>');
  assert.deepEqual(store.load('zeta').snapshot, { v: 99 });
  assert.equal(store.active(), 'zeta');
});

test('switchTo: 原子切换，from/to 正确；not-found 不改盘', () => {
  const { file, store } = tmpStore({ enabled: true });
  store.save('a', { v: 1 });
  store.save('b', { v: 2 });
  const before = fs.readFileSync(file, 'utf8');

  const sw = store.switchTo('b');
  assert.equal(sw.switched, true);
  assert.equal(sw.from, 'a');
  assert.equal(sw.to, 'b');
  assert.equal(store.active(), 'b');
  assert.equal(store.load().active, true);
  assert.equal(store.load('a').active, false);
  assert.ok(fs.readFileSync(file, 'utf8') !== before, '盘上确实被原子替换');

  const miss = store.switchTo('ghost');
  assert.equal(miss.switched, false);
  assert.equal(miss.reason, 'not-found');
  assert.equal(store.active(), 'b', '失败切换不动 active');
});

test('bad-name：空名字/非字符串 → written:false', () => {
  const { store } = tmpStore({ enabled: true });
  assert.equal(store.save('', {}).reason, 'bad-name');
  assert.equal(store.save(null, {}).reason, 'bad-name');
  assert.equal(store.save(42, {}).reason, 'bad-name');
});

test('写前外部改动检测：盘上被外部改过 → external-change，不静默覆盖', () => {
  const { file, store } = tmpStore({ enabled: true });
  store.save('a', { v: 1 });
  const ours = fs.readFileSync(file, 'utf8');

  // 模拟别的进程/人改了文件
  fs.writeFileSync(file, JSON.stringify({ ts: 1, active: 'a', profiles: { a: { v: 'external' } } }, null, 2));

  const blocked = store.save('a', { v: 2 });
  assert.equal(blocked.written, false);
  assert.equal(blocked.reason, 'external-change');
  assert.ok(typeof blocked.hash === 'string' && blocked.hash.length === 64);
  assert.equal(fs.readFileSync(file, 'utf8').includes('external'), true, '外部版本原样保留，没被盖');

  const sw = store.switchTo('a');
  assert.equal(sw.switched, false);
  assert.equal(sw.reason, 'external-change');

  // load() 读过一次 = 记住新哈希 → 后续写放行（报过一次后不反复挡）
  const seen = store.load();
  assert.equal(seen.externalModified, true);
  const after = store.save('a', { v: 3 });
  assert.equal(after.written, true);
  assert.deepEqual(store.load('a').snapshot, { v: 3 });
  assert.ok(ours !== fs.readFileSync(file, 'utf8'));
});

test('verifyWrite 钩子失败 → verify-failed + 回滚（原本没有就删掉，不留半条）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-profiles-'));
  const file = path.join(dir, 'profiles.json');
  const store = createProfilesStore({
    file,
    enabled: true,
    verifyWrite: () => false, // 落盘后自检永远不通过
  });
  const r = store.save('a', { v: 1 });
  assert.equal(r.written, false);
  assert.equal(r.reason, 'verify-failed');
  assert.equal(r.rolledBack, true);
  assert.equal(fs.existsSync(file), false, '原本没有文件 → 回滚成没有');
  assert.equal(store.load(), null);

  // 先真的写一个，再让自检失败：回滚应还原旧内容
  const okStore = createProfilesStore({ file, enabled: true });
  okStore.save('a', { v: 1 });
  const good = fs.readFileSync(file, 'utf8');
  const badStore = createProfilesStore({ file, enabled: true, verifyWrite: () => false });
  const r2 = badStore.save('a', { v: 2 });
  assert.equal(r2.written, false);
  assert.equal(r2.reason, 'verify-failed');
  assert.equal(fs.readFileSync(file, 'utf8'), good, '旧内容被 .bak 还原');
});

test('文件损坏（JSON 坏 / 无 profiles 字段）→ 视作没有，不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-profiles-'));
  const file = path.join(dir, 'profiles.json');
  const store = createProfilesStore({ file, enabled: true });
  fs.writeFileSync(file, '{broken json');
  assert.equal(store.load(), null);
  assert.deepEqual(store.list(), { names: [], active: null, externalModified: false });
  assert.equal(store.active(), null);
  // 损坏文件不挡写入：readDoc 视作没有 → save 正常落地
  const r = store.save('a', { v: 1 });
  assert.equal(r.written, true);
});

test('lastKnownHash：写前未知（新进程），读/写之后记住', () => {
  const { store } = tmpStore({ enabled: true });
  assert.equal(store.lastKnownHash(), null, '新进程不误报外部改动');
  store.save('a', { v: 1 });
  const h = store.lastKnownHash();
  assert.ok(h && h.length === 64);
  assert.equal(store.lastKnownHash(), h, '重复读稳定');
});
