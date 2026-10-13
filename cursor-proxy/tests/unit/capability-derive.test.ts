// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// P0-2 → P0-1 最后一环：capability-derive（weave-os/router 对照借鉴，2026-10-13）
// 纯函数判据，单测钉死四条边界：
//   1. 样本不足 → suggestedLevel=null（绝不折算 0 冒充「弱」）
//   2. 中位延迟超上限 → 封顶 good(2)，不许 strong(3)
//   3. 重试率超上限 → 在封顶内再降一级（下限 0）
//   4. 全达标 → strong(3)；toProfileDraft 把 null 格原样保留，不填默认值
import {
  deriveCapabilityEvidence,
  toProfileDraft,
} from '../../src/routing/capability-derive.js';
import type { AggregateFeedbackRow } from '../../src/routing/routeFeedback.js';

const row = (o: Partial<AggregateFeedbackRow>): AggregateFeedbackRow => ({
  task_type: 'coding',
  model: 'm',
  n: 0,
  avg_latency_ms: null,
  retry_rate: null,
  forwarded: 0,
  ...o,
});

describe('capability-derive / P0-2→P0-1 闭环', () => {
  it('1 样本不足：forwarded < minSamples → suggestedLevel=null（留空，不折算 0）', () => {
    const [e] = deriveCapabilityEvidence([row({ n: 3, forwarded: 5 })]);
    expect(e.suggestedLevel).toBeNull();
    expect(e.rationale).toContain('样本不足');
    expect(e.rationale).toContain('[coding]');
  });

  it('2 延迟超上限 → 封顶 good(2)，不许 strong(3)', () => {
    const [e] = deriveCapabilityEvidence([row({ n: 40, forwarded: 40, avg_latency_ms: 9000, retry_rate: 0 })]);
    expect(e.suggestedLevel).toBe(2);
    expect(e.rationale).toContain('封顶 good(2)');
  });

  it('3 重试率超上限 → 在封顶内再降一级（下限 0）', () => {
    // 延迟达标 + 重试率 0.5 > 0.2 → 3 降一级 = 2
    const [e] = deriveCapabilityEvidence([row({ n: 40, forwarded: 40, avg_latency_ms: 1000, retry_rate: 0.5 })]);
    expect(e.suggestedLevel).toBe(2);
    expect(e.rationale).toContain('降一级');
    // 延迟也超限 + 重试超限 → 2 再降一级 = 1
    const [e2] = deriveCapabilityEvidence([row({ n: 40, forwarded: 40, avg_latency_ms: 9000, retry_rate: 0.5 })]);
    expect(e2.suggestedLevel).toBe(1);
  });

  it('4 全达标 → strong(3)', () => {
    const [e] = deriveCapabilityEvidence([row({ n: 40, forwarded: 40, avg_latency_ms: 800, retry_rate: 0.05 })]);
    expect(e.suggestedLevel).toBe(3);
    expect(e.rationale).toContain('strong(3)');
  });

  it('toProfileDraft：null 格原样保留（不填默认值），按 model→taskType 归档', () => {
    const ev = deriveCapabilityEvidence([
      row({ task_type: 'coding', model: 'deepseek-v4-pro', n: 40, forwarded: 40, avg_latency_ms: 700, retry_rate: 0.02 }),
      row({ task_type: 'vision', model: 'agnes-3.0-flash', n: 2, forwarded: 1 }),
    ]);
    const draft = toProfileDraft(ev);
    expect(draft['deepseek-v4-pro']['coding']).toBe(3);
    expect(draft['agnes-3.0-flash']['vision']).toBeNull(); // 样本不足格保留 null，不填 0
  });

  it('source/date 强制带：对齐 pricing.source 纪律（路由能力矩阵 §3 启示 3）', () => {
    const [e] = deriveCapabilityEvidence([row({ n: 40, forwarded: 40 })], undefined, '2026-10-13');
    expect(e.source).toContain('routing_feedback');
    expect(e.date).toBe('2026-10-13');
  });
});
