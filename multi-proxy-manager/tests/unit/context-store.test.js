// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// context-store 测试（口径 §5：存储与聚合）
// 纪律：只存计数；畸形不 throw；聚合口径（均值/峰值/覆盖率/事件 tally）被钉死。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ContextStore } = require('../../lib/context-store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-store-'));
}

function entry(o) {
  return Object.assign({
    agent: 'dsh-proxy',
    reqId: 'r1',
    model: 'm1',
    requestModel: 'm1',
    clientKey: 'dsh',
    frame: {
      estimate: { byCategory: { system: 100, tools: 200, user: 300, inject: 0, skill: 0, assistant: 50, tool: 350 }, total: 1000, toolCount: 2 },
      actual: null,
      source: 'estimate',
      warnings: ['no-provider-actuals: x'],
    },
    events: [],
    ts: Date.now(),
  }, o || {});
}

describe('context-store · 收单与聚合', () => {
  test('畸形上报丢并不 throw（计数可见）', () => {
    const s = new ContextStore({ dir: tmpDir() });
    expect(s.report(null).ok).toBe(false);
    expect(s.report({ agent: 'x' }).ok).toBe(false);
    expect(s.report(entry()).ok).toBe(true);
    expect(s.stats().dropped).toBe(2);
  });

  test('summary 口径：七类均值 / 峰值 / 实测覆盖率 / 事件 tally / perAgent', () => {
    const s = new ContextStore({ dir: tmpDir() });
    s.report(entry({ ts: Date.now() }));
    s.report(entry({
      ts: Date.now(),
      reqId: 'r2',
      source: 'actual',
      frame: {
        estimate: { byCategory: { system: 200, tools: 0, user: 300, inject: 0, skill: 0, assistant: 0, tool: 0 }, total: 500, toolCount: 0 },
        actual: { byCategory: { system: 200, tools: 0, user: 300, inject: 0, skill: 0, assistant: 0, tool: 0 }, total: 500, cached: 100 },
        source: 'actual',
        warnings: [],
      },
      events: [{ kind: 'compaction-candidate', inferred: true }],
    }));
    const sum = s.summary({ windowMs: 60000 });
    expect(sum.requests).toBe(2);
    expect(sum.peak).toBe(1000);
    expect(sum.byCategory.system).toBe(150); // (100+200)/2
    expect(sum.byCategory.user).toBe(300);
    expect(sum.actualCoverage).toBe(0.5);
    expect(sum.events['compaction-candidate']).toBe(1);
    expect(sum.perAgent['dsh-proxy']).toBe(2);
    expect(sum.warnings['no-provider-actuals']).toBe(1);
  });

  test('窗口过滤：只算窗口内的', () => {
    const s = new ContextStore({ dir: tmpDir() });
    s.report(entry({ ts: Date.now() - 3600000 })); // 1 小时前
    s.report(entry({ ts: Date.now() }));
    expect(s.summary({ windowMs: 60000 }).requests).toBe(1);
  });

  test('落盘 jsonl 一行一请求，读回只有计数无正文', () => {
    const dir = tmpDir();
    const s = new ContextStore({ dir });
    s.report(entry());
    const line = fs.readFileSync(path.join(dir, 'context-ledger.jsonl'), 'utf8').trim();
    const row = JSON.parse(line);
    expect(row.total).toBe(1000);
    expect(row.byCategory.system).toBe(100);
    expect(row).not.toHaveProperty('content');
    expect(row).not.toHaveProperty('messages');
    expect(row).not.toHaveProperty('prompt');
  });

  test('环上限：超出按 FIFO 淘汰', () => {
    const s = new ContextStore({ dir: tmpDir(), ringMax: 3 });
    for (let i = 0; i < 5; i++) s.report(entry({ reqId: 'r' + i }));
    expect(s.recent(10)).toHaveLength(3);
    expect(s.recent(10)[0].reqId).toBe('r2');
  });
});
