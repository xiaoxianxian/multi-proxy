'use strict';

// floor-view.js 纯函数单测：状态判定 / null 不折算 0 / 排序 / 透传。
// 重点守住「拿不到数据必须是 null，不是 0」这条诚实口径。

const { buildFloorCells, numOrNull, STATUS } = require('../../public/floor-view.js');

describe('floor-view · buildFloorCells', () => {
  test('状态判定优先级：isolated > degraded(unhealthy) > healthy > active(有流量无记录) > unknown', () => {
    const out = buildFloorCells({
      cost: { a: { totalTokens: 10, cost: 1, requestCount: 1 } },
      health: {
        b: { status: 'unhealthy', consecutiveFailures: 3 },
        c: { status: 'unhealthy', consecutiveFailures: 5, isolated: true },
        d: { status: 'healthy', consecutiveSuccesses: 2 },
      },
      providers: ['e'],
    });
    const m = {};
    out.cells.forEach((c) => { m[c.id] = c.status; });
    expect(m).toEqual({ a: 'active', b: 'degraded', c: 'isolated', d: 'healthy', e: 'unknown' });
  });

  test('latencyMs 取自 cost.latencyP50；无样本 → null（不是 0）', () => {
    const out = buildFloorCells({
      cost: {
        has: { totalTokens: 1, cost: 0, requestCount: 1, latencyP50: 812.5 },
        none: { totalTokens: 1, cost: 0, requestCount: 1, latencyP50: null },
      },
      health: {},
    });
    expect(out.cells.find((c) => c.id === 'has').latencyMs).toBe(812.5);
    expect(out.cells.find((c) => c.id === 'none').latencyMs).toBeNull();
  });

  test('recentHook / agents 透传；无则 null / []', () => {
    const hook = { kind: 'hook', ts: 1, hook: 'onRequestAssemble', policy: 'tools-lazyload' };
    const agents = [{ agentId: 'qwen-worker', tokens: 100, model: 'deepseek-flash' }];
    const out = buildFloorCells({ cost: {}, health: {}, recentHook: hook, agents });
    expect(out.recentHook).toEqual(hook);
    expect(out.agents).toEqual(agents);

    const bare = buildFloorCells({ cost: {}, health: {} });
    expect(bare.recentHook).toBeNull();
    expect(bare.agents).toEqual([]);
  });

  test('unavailable 只在「整批都没值」时列出；有值就不列', () => {
    const allNull = buildFloorCells({
      cost: { x: { totalTokens: 1, cost: 0, requestCount: 1, latencyP50: null, thinkingTokens: null } },
      health: {},
    });
    expect(allNull.unavailable).toEqual(['latencyMs', 'thinkingTokens', 'recentHook']);

    const haveBoth = buildFloorCells({
      cost: { x: { totalTokens: 1, cost: 0, requestCount: 1, latencyP50: 42, thinkingTokens: 23 } },
      health: {},
      recentHook: { kind: 'hook', hook: 'onHistory', policy: 'p' },
    });
    expect(haveBoth.unavailable).toEqual([]);
  });

  test('thinkingTokens：取自 cost.thinkingTokens；上游不给（OpenAI 线）→ null，绝不折算 0', () => {
    const out = buildFloorCells({
      cost: {
        hasAnthropic: { totalTokens: 27, thinkingTokens: 23, cost: 0, requestCount: 1 }, // Kimi 真上游形态
        explicitNull: { totalTokens: 30, thinkingTokens: null, cost: 0, requestCount: 1 },
        openaiLine:   { totalTokens: 50, cost: 0, requestCount: 1 },                      // 字段整条缺失
      },
      health: {},
    });
    const by = {};
    out.cells.forEach((c) => { by[c.id] = c.thinkingTokens; });
    expect(by).toEqual({ hasAnthropic: 23, explicitNull: null, openaiLine: null });
    // 有一个格有值 ⇒ thinkingTokens 不算「整批无源」（latencyMs / recentHook 本就无源，另算）
    expect(out.unavailable).toEqual(['latencyMs', 'recentHook']);
  });

  test('thinkingTokens：整批都没有时进 unavailable，让页面画「—」并标原因', () => {
    const out = buildFloorCells({ cost: { oai: { totalTokens: 50, cost: 0, requestCount: 1 } }, health: {} });
    expect(out.unavailable).toContain('thinkingTokens');
  });

  test('排序：问题格在前（isolated < degraded < active < healthy < unknown），同档按 id', () => {
    const out = buildFloorCells({
      cost: { z_active: { totalTokens: 1, cost: 0, requestCount: 1 } },
      health: {
        m_iso: { status: 'unhealthy', isolated: true, consecutiveFailures: 9 },
        a_deg: { status: 'unhealthy', consecutiveFailures: 2 },
        b_ok: { status: 'healthy' },
      },
      providers: ['c_unknown'],
    });
    expect(out.cells.map((c) => c.id)).toEqual(['m_iso', 'a_deg', 'z_active', 'b_ok', 'c_unknown']);
  });

  test('缺字段一律 null（不是 0）', () => {
    const out = buildFloorCells({ providers: ['only-id'] });
    const cell = out.cells[0];
    expect(cell.totalTokens).toBeNull();
    expect(cell.cost).toBeNull();
    expect(cell.requestCount).toBeNull();
    expect(cell.failures).toBeNull();
    expect(cell.latencyMs).toBeNull();
  });

  test('STATUS 表覆盖全部状态且带色值', () => {
    ['isolated', 'degraded', 'active', 'healthy', 'unknown'].forEach((k) => {
      expect(STATUS[k]).toBeTruthy();
      expect(STATUS[k].color).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  test('numOrNull：数字通过、非数字/NaN/Infinity/null → null', () => {
    expect(numOrNull(0)).toBe(0);
    expect(numOrNull(12.5)).toBe(12.5);
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull('5')).toBeNull();
    expect(numOrNull(NaN)).toBeNull();
    expect(numOrNull(Infinity)).toBeNull();
  });
});
