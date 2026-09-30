import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  isRoutingFeedbackEnabled,
  recordShadowFeedback,
  recordRuntimeUpdate,
  aggregateFeedback,
} from '../../src/routing/routeFeedback.js';
import { db } from '../../src/db/database.js';

// M6 P0-2 路由反馈闭环（门控 PROXY_ROUTING_FEEDBACK，默认关）
// 关键不变式：门控关 → record 整段跳过零写入；开 → 落库 + 转发后补元数据 + 聚合查询。
// 热路径不变式由本测试保证：默认配置下 record 是 no-op。

const SAMPLE = { taskType: 'code_generation', model: 'model-a', suggestion: 'model-b', defaultModel: 'model-a' };

describe('routing-feedback / P0-2 record + aggregate', () => {
  beforeEach(() => {
    delete process.env.PROXY_ROUTING_FEEDBACK;
    db.prepare('DELETE FROM routing_feedback').run();
   });

  it('默认关：recordShadowFeedback 返回 -1，不写库（热路径零行为变更）', () => {
    const rowid = recordShadowFeedback(SAMPLE);
    expect(rowid).toBe(-1);
    expect(aggregateFeedback(7)).toEqual([]);
  });

  it('门控开：落库 + 转发后补 latency/retried + 聚合', () => {
    process.env.PROXY_ROUTING_FEEDBACK = '1';
    const rowid = recordShadowFeedback(SAMPLE);
    // 转发后补元数据
    recordRuntimeUpdate(rowid, { latencyMs: 50, outputTokens: 1200, retried: false });

    // 第二笔：重试场景
    const rowid2 = recordShadowFeedback({ taskType: 'code_generation', model: 'model-a', suggestion: 'model-b', defaultModel: 'model-a' });
    recordRuntimeUpdate(rowid2, { latencyMs: 100, outputTokens: 300, retried: true });

    const groups = aggregateFeedback(7) as any[];
    // 两条同 taskType × model → 一组：平均 latency 75，重试率 0.5，转发数 2
    const g = groups.find((x) => x.task_type === 'code_generation' && x.model === 'model-a');
    expect(g).toBeTruthy();
    expect(g.n).toBe(2);
    expect(g.forwarded).toBe(2);
    expect(Math.abs(Number(g.avg_latency_ms) - 75)).toBeLessThan(0.001);
    expect(Math.abs(Number(g.retry_rate) - 0.5)).toBeLessThan(0.001);
  });
});

describe('routing-feedback / P0-2 门控判定', () => {
  beforeEach(() => {
    delete process.env.PROXY_ROUTING_FEEDBACK;
    db.prepare('DELETE FROM routing_feedback').run();
    });
  it('门控关：默认/0/false 均 false', () => {
    delete process.env.PROXY_ROUTING_FEEDBACK;
    expect(isRoutingFeedbackEnabled()).toBe(false);
    for (const v of ['0', 'false', 'off']) {
      process.env.PROXY_ROUTING_FEEDBACK = v;
      expect(isRoutingFeedbackEnabled()).toBe(false);
    }
  });
  it('门控开：1/true/on → true', () => {
    for (const v of ['1', 'true', 'on']) {
      process.env.PROXY_ROUTING_FEEDBACK = v;
      expect(isRoutingFeedbackEnabled()).toBe(true);
    }
  });
  it('门控关时 recordRuntimeUpdate / aggregate 同样 no-op', () => {
    delete process.env.PROXY_ROUTING_FEEDBACK;
    recordRuntimeUpdate(1, { latencyMs: 50 });
    expect(aggregateFeedback(7)).toEqual([]);
  });
});
