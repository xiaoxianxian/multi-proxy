'use strict';

// tools/floor-ingest.js 的 normalize 单测：宿主原始事件 → floor-feed 记录。
// 用 60 号文档里的**真事件样本**当输入，保证归一化器对真数据有效。

const { normalize } = require('../../../tools/floor-ingest');

describe('floor-ingest · normalize', () => {
  test('真样本 Status → {kind:agent, tokens}', () => {
    const rec = normalize({ hook_event_name: 'Status', agent_id: 'qwen-worker', context_window: { total_input_tokens: 11890, context_window_size: 200000 } });
    expect(rec).toMatchObject({ kind: 'agent', agentId: 'qwen-worker', event: 'Status', tokens: 11890 });
  });

  test('真样本 CostSample → {kind:agent, model/input/output/cacheRead}', () => {
    const rec = normalize({ hook_event_name: 'CostSample', agent_id: 'qwen-worker', session_id: 'proxy-qwen-worker-x', model: 'deepseek-flash', input: 11890, output: 121, cache_read: 0, cache_creation: 0 });
    expect(rec).toMatchObject({ kind: 'agent', agentId: 'qwen-worker', event: 'CostSample', model: 'deepseek-flash', input: 11890, output: 121, cacheRead: 0 });
  });

  test('真样本 Stop → {kind:agent, event:Stop}', () => {
    const rec = normalize({ hook_event_name: 'Stop', agent_id: 'qwen-worker', session_id: 'proxy-qwen-worker-x' });
    expect(rec).toMatchObject({ kind: 'agent', agentId: 'qwen-worker', event: 'Stop' });
  });

  test('已归一化记录（kind 明确）→ 透传并补 ts', () => {
    const rec = normalize({ kind: 'hook', hook: 'onHistory', policy: 'p1' });
    expect(rec.kind).toBe('hook');
    expect(Number.isFinite(rec.ts)).toBe(true);
  });

  test('不认识的行 → null（丢弃，不编造）', () => {
    expect(normalize(null)).toBeNull();
    expect(normalize('nope')).toBeNull();
    expect(normalize({})).toBeNull();
    expect(normalize({ hook_event_name: 'PreToolUse', agent_id: 'a' })).toBeNull();  // 三类之外
    expect(normalize({ hook_event_name: 'Status' })).toBeNull();                     // 缺 agent_id
  });

  test('缺字段保留 null（不填 0）', () => {
    const rec = normalize({ hook_event_name: 'CostSample', agent_id: 'a' });
    expect(rec.model).toBeNull();
    expect(rec.input).toBeNull();
    expect(rec.output).toBeNull();
    expect(rec.cacheRead).toBeNull();
  });
});
