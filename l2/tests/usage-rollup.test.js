// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * l2/usage-rollup.js 单元测试（node:test，零第三方依赖）。
 *
 * 覆盖：
 *   1. dayOf：epoch ms / ISO 串两种 ts 形态；坏 ts → null（不猜日期）。
 *   2. summarize：同 (date, provider, model) 累加；requestCount 按条计；
 *      非有限数按 0；缺 ts 不入卷；proxy/model 缺省 <unknown>。
 *   3. mergeRows：同 key 六个 SUM_FIELDS 相加；旧卷独有 key 保留；不改入参。
 *   4. readNew：只解析完整行（末段半行留下轮）；cursor 按字节推进；
 *      坏行/空行跳过；文件缺失 → 空 + cursor 不变。
 *   5. createUsageRollup：门控关 = rollup/save 全 no-op；门控开 + 临时文件
 *      → 增量卷（append 后再 rollup 只扫新行）、跨重启 load 续跑。
 *
 * 跑法：node --test tests/usage-rollup.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dayOf, summarize, mergeRows, createUsageRollup } = require('../usage-rollup');

test('dayOf: epoch ms 与 ISO 串都归到 UTC 日期键', () => {
  // 2026-10-08T10:00:08.780Z
  const ms = Date.parse('2026-10-08T10:00:08.780Z');
  assert.equal(dayOf(ms), '2026-10-08');
  assert.equal(dayOf('2026-10-08T10:00:08.780Z'), '2026-10-08');
  // 同一天的尾时刻仍归同一天
  assert.equal(dayOf(Date.parse('2026-10-08T23:59:59.999Z')), '2026-10-08');
});

test('dayOf: 坏 ts → null，绝不猜日期', () => {
  assert.equal(dayOf('not-a-date'), null);
  assert.equal(dayOf(''), null);
  assert.equal(dayOf(null), null);
  assert.equal(dayOf(undefined), null);
  assert.equal(dayOf(NaN), null);
});

test('summarize: 同 (date, provider, model) 累加，requestCount 按条计', () => {
  const rows = summarize([
    { ts: Date.parse('2026-10-08T10:00:00.000Z'), proxy: 'openai', model: 'gpt-5', prompt: 100, completion: 50, cacheHit: 10, thinking: 0, cost: 0.02 },
    { ts: Date.parse('2026-10-08T11:00:00.000Z'), proxy: 'openai', model: 'gpt-5', prompt: 200, completion: 80, cacheHit: 0, thinking: 5, cost: 0.03 },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0] },
    {
      date: '2026-10-08',
      provider: 'openai',
      model: 'gpt-5',
      requestCount: 2,
      inputTokens: 300,
      outputTokens: 130,
      cacheHitTokens: 10,
      thinkingTokens: 5,
      cost: 0.02 + 0.03,
    }
  );
});

test('summarize: 不同维度各成行；缺 ts 不入卷；非有限数按 0；缺省 <unknown>', () => {
  const rows = summarize([
    { ts: Date.parse('2026-10-08T10:00:00.000Z'), proxy: 'openai', model: 'gpt-5', prompt: 1 },
    { ts: Date.parse('2026-10-09T10:00:00.000Z'), proxy: 'openai', model: 'gpt-5', prompt: 1 },
    { ts: Date.parse('2026-10-08T10:00:00.000Z'), proxy: 'openai', model: 'gpt-5-mini', prompt: 1 },
    { ts: 'bad-ts', proxy: 'openai', model: 'gpt-5', prompt: 999 },
    { ts: Date.parse('2026-10-08T10:00:00.000Z'), proxy: 'openai', model: 'gpt-5', prompt: 'NaN-ish', completion: Infinity, cost: undefined },
    { ts: Date.parse('2026-10-08T10:00:00.000Z'), prompt: 7 },
    null,
    'not-an-object',
  ]);
  assert.equal(rows.length, 4, '四个维度键各成行（坏 ts / null / 非对象被跳过）');
  const unknown = rows.find((r) => r.provider === '<unknown>' && r.model === '<unknown>');
  assert.ok(unknown, 'proxy/model 缺省 <unknown>');
  assert.equal(unknown.requestCount, 1);
  assert.equal(unknown.inputTokens, 7);
  const gpt5 = rows.find((r) => r.model === 'gpt-5');
  assert.equal(gpt5.requestCount, 2);
  assert.equal(gpt5.inputTokens, 1, 'NaN-ish 字符串按 0 计');
  assert.equal(gpt5.outputTokens, 0, 'Infinity 按 0 计');
  assert.equal(gpt5.cost, 0, 'undefined 按 0 计');
});

test('mergeRows: 同 key 六个字段相加，旧卷独有 key 保留，不改入参', () => {
  const prev = [
    { date: '2026-10-07', provider: 'openai', model: 'gpt-5', requestCount: 1, inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, thinkingTokens: 0, cost: 0.01 },
    { date: '2026-10-08', provider: 'openai', model: 'gpt-5', requestCount: 2, inputTokens: 20, outputTokens: 10, cacheHitTokens: 1, thinkingTokens: 2, cost: 0.02 },
  ];
  const prevSnapshot = JSON.parse(JSON.stringify(prev));
  const fresh = [
    { date: '2026-10-08', provider: 'openai', model: 'gpt-5', requestCount: 3, inputTokens: 30, outputTokens: 15, cacheHitTokens: 2, thinkingTokens: 0, cost: 0.03 },
  ];
  const merged = mergeRows(prev, fresh);
  assert.equal(merged.length, 2, '旧卷独有的 10-07 保留');
  const d8 = merged.find((r) => r.date === '2026-10-08');
  assert.equal(d8.requestCount, 5);
  assert.equal(d8.inputTokens, 50);
  assert.equal(d8.outputTokens, 25);
  assert.equal(d8.cacheHitTokens, 3);
  assert.equal(d8.thinkingTokens, 2);
  assert.equal(d8.cost, 0.05);
  assert.deepEqual(prev, prevSnapshot, 'prev 数组不被原地修改');
});

test('mergeRows: null/空入参不炸', () => {
  assert.deepEqual(mergeRows(null, null), []);
  assert.deepEqual(mergeRows(null, undefined), []);
  const one = [{ date: 'd', provider: 'p', model: 'm', requestCount: 1 }];
  assert.equal(mergeRows(one, null).length, 1);
});

test('readNew: 只解析完整行，末段半行留下轮；cursor 按字节推进', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-rollup-'));
  const file = path.join(dir, 'source.jsonl');
  const line1 = JSON.stringify({ ts: Date.parse('2026-10-08T10:00:00.000Z'), proxy: 'p', model: 'm', prompt: 1 });
  const line2 = JSON.stringify({ ts: Date.parse('2026-10-08T11:00:00.000Z'), proxy: 'p', model: 'm', prompt: 2 });
  fs.writeFileSync(file, `${line1}\n${line2}\n${line1.slice(0, 10)}`); // 末段是半行
  const r1 = createUsageRollup({ file: path.join(dir, 'rollups.json'), sourceFile: file, enabled: true }).readNew(0);
  assert.equal(r1.records.length, 2, '半行不解析');
  assert.equal(r1.cursor, Buffer.byteLength(`${line1}\n${line2}\n`, 'utf8'), 'cursor 只吃到完整行末尾');

  // 补全半行后再读：从旧 cursor 处只出新行
  fs.writeFileSync(file, `${line1}\n${line2}\n${line2}\n`);
  const r2 = createUsageRollup({ file: path.join(dir, 'rollups.json'), sourceFile: file, enabled: true }).readNew(r1.cursor);
  assert.equal(r2.records.length, 1);
  assert.equal(r2.records[0].prompt, 2);
});

test('readNew: 坏行/空行跳过不影响 cursor 推进；文件缺失 → cursor 不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-rollup-'));
  const file = path.join(dir, 'source.jsonl');
  fs.writeFileSync(file, 'not-json\n\n{"ok":true}\n');
  const store = createUsageRollup({ file: path.join(dir, 'rollups.json'), sourceFile: file, enabled: true });
  const r = store.readNew(0);
  assert.equal(r.records.length, 1, '坏行与空行跳过，好行照收');
  assert.equal(r.cursor, Buffer.byteLength('not-json\n\n{"ok":true}\n', 'utf8'));

  const missing = store.readNew(999);
  assert.deepEqual(missing, { records: [], cursor: 999 }, '文件读不到时 cursor 原样返回');
});

test('createUsageRollup: 门控关 = rollup/save 全 no-op（零行为变更）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-rollup-'));
  const src = path.join(dir, 'source.jsonl');
  fs.writeFileSync(src, `${JSON.stringify({ ts: Date.now(), proxy: 'p', model: 'm', prompt: 1 })}\n`);
  const store = createUsageRollup({ file: path.join(dir, 'rollups.json'), sourceFile: src, enabled: false });
  assert.equal(store.isEnabled(), false);
  const r = store.rollup();
  assert.deepEqual(r, { written: false, reason: 'gate-closed' });
  assert.equal(store.save([], 0).written, false, 'save 同样 no-op');
  assert.equal(fs.existsSync(store.file()), false, '门控关不落盘');
});

test('createUsageRollup: 门控开 → 增量卷 + load 跨重启续跑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-rollup-'));
  const src = path.join(dir, 'source.jsonl');
  const rollupFile = path.join(dir, 'rollups.json');
  const rec = (h) => JSON.stringify({ ts: Date.parse(`2026-10-08T${h}:00:00.000Z`), proxy: 'openai', model: 'gpt-5', prompt: 10, completion: 5, cost: 0.01 });
  fs.writeFileSync(src, `${rec(10)}\n${rec(11)}\n`);

  const store = createUsageRollup({ file: rollupFile, sourceFile: src, enabled: true });
  const r1 = store.rollup();
  assert.equal(r1.written, true);
  assert.equal(r1.scanned, 2);
  assert.equal(r1.rows.length, 1);
  assert.equal(r1.rows[0].requestCount, 2);
  assert.equal(r1.rows[0].inputTokens, 20);

  // 追加两行后再卷：只扫新行，旧卷合并
  fs.appendFileSync(src, `${rec(12)}\n${rec(13)}\n`);
  const r2 = store.rollup();
  assert.equal(r2.scanned, 2, 'cursor 之后只有 2 条新行');
  assert.equal(r2.rows[0].requestCount, 4);
  assert.equal(r2.rows[0].inputTokens, 40);

  // 模拟重启：新 store 实例 load 回上次卷，续卷不清零
  const store2 = createUsageRollup({ file: rollupFile, sourceFile: src, enabled: true });
  const loaded = store2.load();
  assert.ok(loaded && Array.isArray(loaded.rows));
  assert.equal(loaded.rows[0].requestCount, 4);
  assert.ok(loaded.cursor > 0, 'cursor 持久化，续跑不重扫');
  fs.appendFileSync(src, `${rec(14)}\n`);
  const r3 = store2.rollup();
  assert.equal(r3.scanned, 1);
  assert.equal(r3.rows[0].requestCount, 5);

  // 落盘形态 = { ts, cursor, rows }
  const onDisk = JSON.parse(fs.readFileSync(rollupFile, 'utf8'));
  assert.ok(typeof onDisk.ts === 'number');
  assert.ok(typeof onDisk.cursor === 'number');
  assert.ok(Array.isArray(onDisk.rows));
});
