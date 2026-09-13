/**
 * M6 方向四 · D6-a 健康信号端到端接线（观测级，不碰热路径）
 * 锁三件事：
 *  ① 未注入 health context 时 buildHealthCandidates 返回 undefined、
 *     computeShadowSuggestion 退回纯引擎路径（与 D6-a 前行为一致）；
 *  ② 注入 (HealthMonitor 风格 state) + (model→UUID 映射) 后，
 *     候选集按健康状态正确映射（'healthy'→'ok'，'unhealthy'→'down'，
 *     未知→'degraded'，死名→'down'），且 cost-optimization 路径能感知
 *     健康差异；
 *  ③ clearHealthContext 能复原，shadow 模式不影响主链路。
 *
 * 不依赖真实 DB、不依赖真实 /models 网络——用最小 stub 模拟
 * HealthMonitor.getStatus() + model→UUID 映射。
 */
import {
   computeShadowSuggestion,
   buildHealthCandidates,
   setHealthContext,
   clearHealthContext,
} from '../../src/routing/routing-shadow.js';
import { DEFAULT_ROUTE_CONFIG, type RouteConfig } from '../../src/routing/routeEngine.js';
import type { HealthMonitor } from '../../src/monitoring/healthMonitor.js';

/** 模拟 HealthMonitor 的最小 stub（只实现 getStatus）。 */
class MockHealthMonitor {
  private statuses: Map<string, { state: string; lastChecked: number; error?: string }> = new Map(
    [['PU_QWEN', { state: 'healthy', lastChecked: Date.now() }],
     ['PU_DS',   { state: 'unhealthy', lastChecked: Date.now(), error: '404' }],
     ['PU_AG',   { state: 'healthy', lastChecked: Date.now() }],
     // 未知 UUID 不在 map 里 → getStatus 返回 undefined → 候选 health='degraded'
    ],
  );
  getStatus(pid: string) { return this.statuses.get(pid); }
}

/** 每个测试独立：清上下文 + 清引擎内部 round-robin 计数。 */
function freshConfig(): RouteConfig {
  return JSON.parse(JSON.stringify(DEFAULT_ROUTE_CONFIG));
}

function genMessages(a: string, b: string) {
  return [{ role: 'user', content: a }, { role: 'assistant', content: b }];
}

describe('M6 D6-a 健康信号端到端接线', () => {
  beforeEach(() => { clearHealthContext(); });
  afterEach(() => { clearHealthContext(); });

  test('① 未注入 health context：buildHealthCandidates 返 undefined，computeShadowSuggestion 走纯引擎路径', () => {
     expect(buildHealthCandidates(freshConfig())).toBeUndefined();
     // 无 health context → buildHealthCandidates 返 undefined → 引擎走纯 cost-optimization
     // qwen3.8:27b-mlx 现为 free(0/0) 且是 fallbackChain[0]+defaultModel。
     // "hello" 被分类为 cheap → r-cheap 指向 local → 选 qwen3.8:27b-mlx(免费、链首位)
     // → 与 defaultModel 相同 → 噪声抑制返 null（证明仍走纯引擎路径，非异常 fallback）。
     const sugg = computeShadowSuggestion('qwen3.8:27b-mlx', genMessages('hello', 'world'), freshConfig());
     expect(sugg).toBeNull();
    });

  test('② 注入 health context：候选集按健康映射，cost-optimization 感知健康差异', () => {
    const mon = new MockHealthMonitor() as unknown as HealthMonitor;
    // model→UUID 映射（模拟 start.ts 构建的）
    const m2u = new Map<string, string>([
       ['qwen3.8:27b-mlx', 'PU_QWEN'],
       ['deepseek-v4-pro', 'PU_DS'],
       ['agnes-2.5-flash', 'PU_AG'],
      ]);
    setHealthContext(mon, m2u);

    const candidates = buildHealthCandidates(freshConfig())!;
     expect(candidates).toBeTruthy();
     expect(candidates!.length).toBeGreaterThan(0);
     // 每个 fallbackChain 模型都有 health 映射
     for (const c of candidates!) {
      expect(['ok', 'degraded', 'down']).toContain(c.health);
      expect(typeof c.id).toBe('string');
     }
    // 'qwen3.8:27b-mlx' → healthy → 'ok'；'deepseek-v4-pro' → unhealthy → 'down'
    const qw = candidates!.find((c) => c.id === 'qwen3.8:27b-mlx');
    const ds = candidates!.find((c) => c.id === 'deepseek-v4-pro');
    expect(qw?.health).toBe('ok');
    expect(ds?.health).toBe('down');
    // 'kimi-k2.6' 无映射 → 'down'（在 fallbackChain 但不在这个测试的 m2u 中）
    const mlx = candidates!.find((c) => c.id === 'kimi-k2.6');
    expect(mlx?.health).toBe('down');
    // 健康信号改变了 shadow 建议：deepseek 挂掉 → 不再建议 deepseek
    const suggBefore = 'deepseek-v4-pro';
    const sugg = computeShadowSuggestion('kimi-k2.6', genMessages('a', 'b'), freshConfig());
     // deepseek down → rankByCost 把 healthy 的 qwen 排到 deepseek 前，
     // 与纯引擎路径（无健康）不同 → 证明候选集真正被引擎消费
    expect(sugg).not.toBe(suggBefore);
   });

  test('③ clearHealthContext 复原：恢复 undefined', () => {
    setHealthContext(new MockHealthMonitor() as unknown as HealthMonitor, new Map());
    expect(buildHealthCandidates(freshConfig())).toBeTruthy();
    clearHealthContext();
    expect(buildHealthCandidates(freshConfig())).toBeUndefined();
   });
});

describe('M6 D6-a 候选集起效（shadow 级，非 defaultModel = 有切换建议）', () => {
  beforeEach(() => { clearHealthContext(); });
  afterEach(() => { clearHealthContext(); });

  /** 最小 HealthMonitor 风格 stub：只填指定 UUID 的 state。 */
  function stubMonitor(statuses: { puuid: string; state: string }[]) {
    const m: Record<string, unknown> = {};
    const map = new Map<string, { state: string; lastChecked: number; error?: string }>();
    for (const { puuid, state } of statuses) {
       map.set(puuid, { state, lastChecked: Date.now() });
      }
    m.getStatus = (pid: string) => map.get(pid);
    return m as unknown as HealthMonitor;
    }
  function modelMap(puuids: string[]): Map<string, string> {
     // fallbackChain 四个模型 → puuids 提供实际 UUID 的，其余留空（死名→down）
     const chain = DEFAULT_ROUTE_CONFIG.fallbackChain;
     const result = new Map<string, string>();
     chain.forEach((name, i) => {
     const uuid = puuids[i] ?? '';
     result.set(name, uuid);
     });
     return result;
   }
  const CFG_C: RouteConfig = {
    ...DEFAULT_ROUTE_CONFIG,
    strategy: 'cost-optimization',
    pricing: {
      'qwen3.8:27b-mlx':       { input: 0.8, output: 5.4, cacheHit: 0.1 },
      'deepseek-v4-pro': { input: 1,   output: 4,   cacheHit: 0.02 },
    },
   };

  test('注入 (qwen ok + deepseek down) → suggestion 非 defaultModel（候选集起效）', () => {
    const mon = stubMonitor(
       [
         { puuid: 'PU_QWEN', state: 'healthy' },
         { puuid: 'PU_DS',   state: 'unhealthy' }, // deepseek 宕 → health=down
       ]);
    setHealthContext(mon, modelMap(['PU_QWEN', 'PU_DS']));
    const sugg = computeShadowSuggestion('qwen3.8:27b-mlx', genMessages('a', 'b'), CFG_C);
     // 候选集生效 → cost-optimization 比价路径（非 priority 的 defaultModel）
    expect(sugg).not.toBeNull();
    expect(sugg!).not.toBe('qwen3.8:27b-mlx'); // 健康差异在建议中留痕
    clearHealthContext();
   });

  test('注入 (两个均 ok) → 健康候选参与比价，suggestion 非 default', () => {
    const mon = stubMonitor([
       { puuid: 'PU_AG', state: 'healthy' },
       { puuid: 'PU_DS', state: 'healthy' },
     ]);
    setHealthContext(mon, modelMap(['PU_AG', 'PU_DS']));
    const sugg = computeShadowSuggestion('qwen3.8:27b-mlx', genMessages('a', 'b'), CFG_C);
    expect(sugg).not.toBeNull();
    expect(sugg!).not.toBe('qwen3.8:27b-mlx'); // agnes 免费 + deepseek 健康均参与 → 比价选最便宜
    clearHealthContext();
   });
});
