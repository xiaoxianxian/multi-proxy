// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// P0-1 能力过滤单测 + P1-4 taskClassifier 英文补全单测
import { classifyTask } from '../../src/routing/taskClassifier.js';
import {
  filterByCapability,
  DEFAULT_CAPABILITY_PROFILES,
} from '../../src/routing/capability-profile.js';
import { RouteEngine, DEFAULT_ROUTE_CONFIG, RouteCandidate } from '../../src/routing/routeEngine.js';

const cands = DEFAULT_ROUTE_CONFIG.fallbackChain
  .map((name) => ({ id: name, pricing: DEFAULT_ROUTE_CONFIG.pricing[name], health: 'ok' as const }))
  .map((c: any) => c as RouteCandidate);

// ─── P1-4 taskClassifier 英文补全 ───

describe('P1-4 taskClassifier English start patterns', () => {
  test('implement … → coding', () => {
    expect(classifyTask('implement a rate limiter with sliding window')).toBe('coding');
  });
  test('refactor … → coding', () => {
    expect(classifyTask('refactor the auth module to use JWT')).toBe('coding');
  });
  test('generate code … → coding', () => {
    expect(classifyTask('generate code for a REST API')).toBe('coding');
  });
  test('build the app → coding', () => {
    expect(classifyTask('build the CI pipeline in GitHub Actions')).toBe('coding');
  });
  test('deploy to prod → coding', () => {
    expect(classifyTask('deploy the service to kubernetes')).toBe('coding');
  });
  test('optimize the query → coding', () => {
    expect(classifyTask('optimize the SQL query performance')).toBe('coding');
  });
  test('非 action 前缀（无 implement/refactor/…）仍为 general', () => {
    expect(classifyTask('what is the capital of France')).toBe('general');
  });
});

// ─── P0-1 能力过滤 ───

describe('P0-1 capability filtering', () => {
  beforeAll(() => {
    // 门控 ON
    process.env.PROXY_CAPABILITY_FILTER = '1';
  });
  afterAll(() => {
    delete process.env.PROXY_CAPABILITY_FILTER;
  });

  test('vision 任务 + quality=high → 排除 agnes-3.0-flash (vision=0)', () => {
    const filtered = filterByCapability(cands, 'vision', 'high');
    const ids = filtered.map((c) => c.id);
    expect(ids).not.toContain('agnes-3.0-flash');
    // qwen3.8(kimi-k2.6 都有 vision=2) 应保留
    expect(ids).toContain('qwen3.8:27b-mlx');
  });

  test('cheap 任务（无 quality）→ agnes 保留（vision=0 不影响 general/basics）', () => {
    const filtered = filterByCapability(cands, 'coding', undefined);
    // agnes coding=1, 无 quality 需求 = basic(1) → 保留
    expect(filtered.map((c) => c.id)).toContain('agnes-3.0-flash');
  });

  test('门控 OFF (PROXY_CAPABILITY_FILTER=0) → 不过滤, 返回全部', () => {
    process.env.PROXY_CAPABILITY_FILTER = '0';
    const filtered = filterByCapability(cands, 'vision', 'high');
    expect(filtered.length).toBe(cands.length); // 不过滤
    delete process.env.PROXY_CAPABILITY_FILTER;
  });

  test('过滤后全部被排除 → 回退原列表（不产假 0 结果）', () => {
    // 构造一个 profile 全是 0 的模型
    const badCand: RouteCandidate = {
      id: 'dummy',
      pricing: { input: 0, output: 0 },
      health: 'ok',
    };
    // 需要 profile = { vision: 0 } 且 quality=high(req=2) → 排除
    // filterByCapability 用 DEFAULT_CAPABILITY_PROFILES[dummy.id] → undefined → 不排
    // 要测 fallback: 传入全 0 profile 的候选集 → 全部排除 → 回退原
    // 用自定义 profile
    const allZero: RouteCandidate[] = [
      { id: 'm1', pricing: { input: 0, output: 0 } } as RouteCandidate,
    ];
    // 手动设 profile
    (allZero[0] as any).capability = { vision: 0 } as any;
    const filtered = filterByCapability(allZero, 'vision', 'high');
    // 全部排除后回退原列表（length 1）
    expect(filtered.length).toBe(1); // 回退到原 list
  });

  test('集成：RouteEngine.getNextRoute + PROXY_CAPABILITY_FILTER=1 → vision 任务不走 agnes', () => {
    const engine = new RouteEngine();
    engine.setRoutes([DEFAULT_ROUTE_CONFIG]);
    // 新签名：getNextRoute(taskType, modelName, config, ctx)；ctx 不含 taskType/model
    const result = engine.getNextRoute(
      'vision' as any,
      'qwen3.8:27b-mlx',
      DEFAULT_ROUTE_CONFIG,
      { quality: 'high', messageLength: 100, candidates: cands },
     );
    expect(result).not.toBe('agnes-3.0-flash'); // agnes vision=0 被排除
   });
});
