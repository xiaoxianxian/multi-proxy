// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
const BB = require('../../../l2/budget-buckets/budget-buckets.js');

// G3 per-agent / per-project 预算分桶（l2/budget-buckets/budget-buckets.js）
// 复用 CostWatchdog：每桶独立累计/判级/到限暂停；未知 caller 落 default 兜底桶。
const entry = (agentId, cost) => ({
    agentId,
    actualTier: 'large',
    actualCost: cost,
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
});

describe('budget-buckets G3 预算分桶 (l2/budget-buckets/budget-buckets.js)', () => {
  test('默认只建 default 桶、hardCap=0 零行为变更（不拦）', () => {
    const bb = BB.createBudgetBuckets();
    expect(bb.state().bucketCount).toBe(1);
    expect(bb.shouldBlock(entry('any', 0))).toBe(false);
    expect(bb.gateOpen()).toBe(false);
  });

  test('单 agent 超限只拦该桶，不拖垮全局（隔离性）', () => {
    const bb = BB.createBudgetBuckets({
      config: { default: { hardCap: 0 }, buckets: { claude: { hardCap: 0.2 }, codex: { hardCap: 1.0 } } },
    });
    let claudeBlocked = false;
    for (let i = 1; i <= 4; i++) {
      const r = bb.record(entry('claude', 0.096), { now: i * 1000 });
      if (r.block) claudeBlocked = true;
    }
    // Claude 第 3 笔(0.288)越过 0.2 → 该桶 block
    expect(claudeBlocked).toBe(true);
    // Codex 桶独立累计，未被 Claude 拖垮
    const codexState = bb.getBucket('codex').state();
    expect(codexState.cumulative).toBe(0);
    expect(codexState.block).toBe(false);
    // 聚合：Claude 桶 blocked → 聚合 level=blocked
    const agg = bb.state({ now: 9999 }).aggregate;
    expect(agg.level).toBe('blocked');
  });

  test('未知 caller 落入 default 兜底桶（fail-safe 不报错）', () => {
    const bb = BB.createBudgetBuckets({
      config: { default: { hardCap: 0 }, buckets: { claude: { hardCap: 0.2 } } },
    });
    const r = bb.record(entry('mystery-agent', 0.096), { now: 1000 });
    expect(r.bucketId).toBe('default');
    expect(r.block).toBe(false);
  });

  test('shouldBlock 只按 caller 所在桶判拦', () => {
    const bb = BB.createBudgetBuckets({
      config: { default: { hardCap: 0 }, buckets: { claude: { hardCap: 0.2 } } },
    });
    bb.record(entry('claude', 0.096), { now: 1000 });
    bb.record(entry('claude', 0.096), { now: 2000 });
    bb.record(entry('claude', 0.096), { now: 3000 }); // 0.288 >= 0.2
    expect(bb.shouldBlock(entry('claude', 0), { now: 3000 })).toBe(true);
    expect(bb.shouldBlock(entry('default', 0), { now: 3000 })).toBe(false);
  });

  test('桶级配置各自生效（告警阈值比例也隔离）', () => {
    const bb = BB.createBudgetBuckets({
      config: {
        default: { hardCap: 0 },
        buckets: {
          claude: { hardCap: 0.2, alertRatios: [0.8] },
          codex:  { hardCap: 0.2, alertRatios: [] },
        },
      },
    });
    const r = bb.record(entry('claude', 0.096 * 2), { now: 1000 }); // 0.192 = 96% of 0.2 → 越 0.8 阈值
    const claudeAlerts = r.thresholdAlerts.length;
    const codex = bb.record(entry('codex', 0.096 * 2), { now: 1000 });
    expect(claudeAlerts).toBe(1);            // claude 桶配了 0.8 告警
    expect(codex.thresholdAlerts.length).toBe(0); // codex 桶空 ratios 不告警
  });
});
