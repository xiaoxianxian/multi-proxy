// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// context-events 测试（口径 §3：帧差事件推断）
// 纪律：阈值是常量，测试把常量当契约钉死；改口径先改 docs/context-breakdown-口径.md。
const E = require('../../../l2/context-events.js');

const frame = (o) => Object.assign({ total: 10000, model: 'm1', toolNames: ['a', 'b'], ts: 1 }, o || {});

describe('context-events · 帧差推断（inferred 永远为 true）', () => {
  test('首帧无参照物 → 不出事件（不是「没变」，是「不知道」）', () => {
    expect(E.inferEvents(null, frame())).toEqual([]);
  });

  test('平稳增长 → 不出收缩事件', () => {
    const ev = E.inferEvents(frame({ total: 10000 }), frame({ total: 12000 }));
    expect(ev).toEqual([]);
  });

  test('大幅收缩（≥25% 且 ≥2000 tok）→ compaction-candidate', () => {
    const ev = E.inferEvents(frame({ total: 10000 }), frame({ total: 6000 }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'compaction-candidate', inferred: true, basis: 'proxy-frame-diff', droppedTokens: 4000 });
  });

  test('比例够但绝对量不够（小会话抖动）→ 不算', () => {
    // 200 → 100：比例 50% 但缩量 100 < COMPACT_MIN_DROP
    expect(E.inferEvents(frame({ total: 200 }), frame({ total: 100 }))).toEqual([]);
  });

  test('小幅收缩（5%–25% 且 ≥200 tok）→ prune-candidate', () => {
    const ev = E.inferEvents(frame({ total: 10000 }), frame({ total: 8800 }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'prune-candidate', inferred: true, droppedTokens: 1200 });
  });

  test('微小收缩（<5%）→ 噪声不记', () => {
    expect(E.inferEvents(frame({ total: 10000 }), frame({ total: 9900 }))).toEqual([]);
  });

  test('模型切换 → model-switch 带 from/to', () => {
    const ev = E.inferEvents(frame({ model: 'm1' }), frame({ model: 'm2' }));
    expect(ev).toEqual([{ kind: 'model-switch', inferred: true, basis: 'proxy-frame-diff', from: 'm1', to: 'm2' }]);
  });

  test('模型为空 → 不报切换', () => {
    expect(E.inferEvents(frame({ model: null }), frame({ model: 'm2' }))).toEqual([]);
  });

  test('工具集变化 → tools-changed 带 added/removed（排序稳定）', () => {
    const ev = E.inferEvents(frame({ toolNames: ['b', 'a'] }), frame({ toolNames: ['a', 'c'] }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'tools-changed', inferred: true, added: ['c'], removed: ['b'] });
  });

  test('工具集相同 → 无事件', () => {
    expect(E.inferEvents(frame({ toolNames: ['a'] }), frame({ toolNames: ['a'] }))).toEqual([]);
  });

  test('total 非有限数 → 未知不猜，整体不出事件', () => {
    expect(E.inferEvents(frame({ total: NaN }), frame({ total: 100 }))).toEqual([]);
    expect(E.inferEvents(frame({ total: 100 }), frame({ total: undefined }))).toEqual([]);
  });

  test('hostile 输入：curr 非对象 → 空数组不 throw', () => {
    expect(E.inferEvents(frame(), null)).toEqual([]);
    expect(E.inferEvents(frame(), 'x')).toEqual([]);
    expect(E.inferEvents(undefined, frame())).toEqual([]);
  });

  test('多事件可同时成立（收缩 + 换模型）', () => {
    const ev = E.inferEvents(frame({ total: 10000, model: 'm1' }), frame({ total: 5000, model: 'm2' }));
    const kinds = ev.map((e) => e.kind).sort();
    expect(kinds).toEqual(['compaction-candidate', 'model-switch']);
  });
});
