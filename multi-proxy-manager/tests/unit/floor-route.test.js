// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// routes/floor.js 路由级测试：桩掉 cost-track / provider-health / floor-feed，
// 证明「非空数据真能过 HTTP 回环」+ latency/recentHook/agents 三条新数据链都通。

jest.mock('../../lib/cost-track', () => ({ getAll: jest.fn(), enabled: jest.fn() }));
jest.mock('../../lib/provider-health', () => ({ listIsolated: jest.fn(), getProviderHealth: jest.fn() }));
jest.mock('../../../l2/floor-feed', () => ({ readLastHook: jest.fn(), readAgents: jest.fn() }));

const request = require('supertest');
const express = require('express');
const costTrack = require('../../lib/cost-track');
const providerHealth = require('../../lib/provider-health');
const floorFeed = require('../../../l2/floor-feed');
const floor = require('../../routes/floor');

function mkApp() {
  const a = express();
  a.use('/api/floor', floor);
  return a;
}

describe('routes/floor（只读聚合）', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    floorFeed.readLastHook.mockReturnValue(null);
    floorFeed.readAgents.mockReturnValue([]);
  });

  test('聚合 cost + health + feed → cells/recentHook/agents 正确', async () => {
    costTrack.enabled.mockReturnValue(true);
    costTrack.getAll.mockReturnValue({
      // thinkingTokens 25：Anthropic 线才有这个字段，带上了 ⇒ 不该进 unavailable
      agnes: { totalTokens: 1500, thinkingTokens: 25, cost: 0.003, requestCount: 3, latencyP50: 812.5 },
    });
    providerHealth.listIsolated.mockReturnValue([{ providerId: 'deepseek' }]);
    providerHealth.getProviderHealth.mockImplementation((id) =>
      id === 'deepseek'
        ? { providerId: 'deepseek', status: 'unhealthy', consecutiveFailures: 5, lastProbeAt: 1000 }
        : null
    );
    floorFeed.readLastHook.mockReturnValue({ kind: 'hook', ts: 9, hook: 'onRequestAssemble', policy: 'tools-lazyload' });
    floorFeed.readAgents.mockReturnValue([{ agentId: 'qwen-worker', tokens: 11890, model: 'deepseek-flash' }]);

    const res = await request(mkApp()).get('/api/floor').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.costTrackEnabled).toBe(true);
    expect(res.body.cells.map((c) => c.id).sort()).toEqual(['agnes', 'deepseek']);

    const agnes = res.body.cells.find((c) => c.id === 'agnes');
    expect(agnes.status).toBe('active');
    expect(agnes.totalTokens).toBe(1500);
    expect(agnes.latencyMs).toBe(812.5);            // 真实 p50 透传
    expect(agnes.thinkingTokens).toBe(25);          // 推理 token 纯可观测透传（不计费口径）

    const ds = res.body.cells.find((c) => c.id === 'deepseek');
    expect(ds.status).toBe('isolated');
    expect(ds.failures).toBe(5);

    expect(res.body.recentHook.policy).toBe('tools-lazyload');
    expect(res.body.agents[0].agentId).toBe('qwen-worker');
    expect(res.body.unavailable).toEqual([]);        // 有 latency 有 hook，不缺
  });

  test('全空 → cells:[]、recentHook:null、agents:[]、unavailable 列出两项', async () => {
    costTrack.enabled.mockReturnValue(false);
    costTrack.getAll.mockReturnValue({});
    providerHealth.listIsolated.mockReturnValue([]);

    const res = await request(mkApp()).get('/api/floor').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cells).toEqual([]);
    expect(res.body.recentHook).toBeNull();
    expect(res.body.agents).toEqual([]);
    // cells 为空时不判定 latencyMs（没有格子），只报 recentHook
    expect(res.body.unavailable).toEqual(['recentHook']);
  });

  test('依赖抛错 → 500 且只回 message（不泄堆栈）', async () => {
    costTrack.getAll.mockImplementation(() => { throw new Error('boom'); });
    const res = await request(mkApp()).get('/api/floor').expect(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('boom');
  });

  test('feed 读取抛错 → 非致命，仍 200（recentHook/agents 退化为空）', async () => {
    costTrack.enabled.mockReturnValue(true);
    costTrack.getAll.mockReturnValue({});
    providerHealth.listIsolated.mockReturnValue([]);
    floorFeed.readLastHook.mockImplementation(() => { throw new Error('feed boom'); });
    floorFeed.readAgents.mockImplementation(() => { throw new Error('feed boom'); });

    const res = await request(mkApp()).get('/api/floor').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.recentHook).toBeNull();
    expect(res.body.agents).toEqual([]);
  });
});
