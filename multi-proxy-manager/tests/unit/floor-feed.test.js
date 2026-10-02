'use strict';

// l2/floor-feed.js 单测：append / readAll / readLastHook / readAgents。
// 用临时文件，不碰真实 ~/.multi-proxy/floor-feed.jsonl。

const fs = require('fs');
const os = require('os');
const path = require('path');
const feed = require('../../../l2/floor-feed');

const tmp = path.join(os.tmpdir(), `floor-feed-test-${process.pid}.jsonl`);

beforeEach(() => {
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  feed.setFeedFile(tmp);
});
afterAll(() => {
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
});

describe('l2/floor-feed', () => {
  test('append → readAll 读回；坏行跳过不抛', () => {
    feed.append({ kind: 'hook', ts: 1, hook: 'onRequestAssemble', policy: 'tools-lazyload' });
    fs.appendFileSync(tmp, '{这不是JSON}\n');   // 手动塞坏行
    feed.append({ kind: 'agent', ts: 2, agentId: 'a1', event: 'Stop' });

    const all = feed.readAll();
    expect(all.length).toBe(2);
    expect(all[0].policy).toBe('tools-lazyload');
    expect(all[1].agentId).toBe('a1');
  });

  test('readLastHook 取最后一条 hook；无 hook → null（不编造）', () => {
    feed.append({ kind: 'agent', ts: 1, agentId: 'a1', event: 'Stop' });
    expect(feed.readLastHook()).toBeNull();

    feed.append({ kind: 'hook', ts: 2, hook: 'onHistory', policy: 'p1' });
    feed.append({ kind: 'hook', ts: 3, hook: 'onToolOutput', policy: 'p2' });
    const last = feed.readLastHook();
    expect(last.hook).toBe('onToolOutput');
    expect(last.policy).toBe('p2');
  });

  test('readAgents 按 agentId 聚合最新视图（Status tokens + CostSample 明细）', () => {
    const t = Date.now();
    feed.append({ kind: 'agent', ts: t, agentId: 'qwen-worker', event: 'Status', tokens: 11890 });
    feed.append({ kind: 'agent', ts: t + 1, agentId: 'qwen-worker', event: 'CostSample', model: 'deepseek-flash', input: 11890, output: 121, cacheRead: 0 });
    feed.append({ kind: 'agent', ts: t + 2, agentId: 'qwen-worker', event: 'Stop' });
    feed.append({ kind: 'agent', ts: t + 3, agentId: 'other', event: 'Status', tokens: 5 });

    const agents = feed.readAgents();
    expect(agents.length).toBe(2);
    const qw = agents.find((a) => a.agentId === 'qwen-worker');
    expect(qw.tokens).toBe(11890);
    expect(qw.model).toBe('deepseek-flash');
    expect(qw.input).toBe(11890);
    expect(qw.output).toBe(121);
    expect(qw.cacheRead).toBe(0);
    expect(qw.lastEvent).toBe('Stop');
    // 最近活跃的排最前
    expect(agents[0].agentId).toBe('other');
  });

  test('readAgents 缺字段保留 null（不填 0）', () => {
    feed.append({ kind: 'agent', ts: 1, agentId: 'bare', event: 'Stop' });
    const a = feed.readAgents()[0];
    expect(a.model).toBeNull();
    expect(a.tokens).toBeNull();
    expect(a.input).toBeNull();
    expect(a.output).toBeNull();
    expect(a.cacheRead).toBeNull();
  });

  test('文件不存在时 readAll/readLastHook/readAgents 安全返回空（不抛）', () => {
    feed.setFeedFile(path.join(os.tmpdir(), `floor-feed-nope-${process.pid}.jsonl`));
    expect(feed.readAll()).toEqual([]);
    expect(feed.readLastHook()).toBeNull();
    expect(feed.readAgents()).toEqual([]);
  });
});
