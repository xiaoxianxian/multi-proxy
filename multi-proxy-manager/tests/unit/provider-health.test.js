/**
 * M2 方向二：provider-health 单元测试。
 * recordProbe 连续失败→unhealthy、成功→恢复、隔离窗口判定、2b 跨 proxy 聚合、
 * 持久化 round-trip、隔离门控（observe 默认）均不触碰 providers.json / 路由。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// 每个 describe 前重定向到独立临时文件，避免互相污染
let ph;
let tmpFile;
let now;

beforeEach(() => {
  const f = path.join(os.tmpdir(), 'm2-ph-test.json');
  try { fs.unlinkSync(f); } catch { /* 不存在则跳过 */ }
  tmpFile = f;
  now = 1_000_000; // 固定时钟起点
  ph = require('../../lib/provider-health');
  ph.resetProviderHealth();
  ph.setHealthFile(tmpFile);
  ph.setClock(() => now);
  ph.setHealthConfig({
    failureThreshold: 3,
    isolateDelayMs: 5 * 60 * 1000,
    crossProxyThreshold: 2,
    crossProxyWindowMs: 5 * 60 * 1000,
   });
  delete require.cache[require.resolve('../../lib/provider-health')];
});

describe('recordProbe — 连续失败标记 unhealthy', () => {
  test('连续 3 次失败 → status=unhealthy + unhealthyUntil 设置', () => {
    ph.recordProbe('agnes', false, { now, source: 'codex' });
    expect(ph.getProviderHealth('agnes').status).toBe('healthy');
    ph.recordProbe('agnes', false, { now: now + 1000, source: 'codex' });
    expect(ph.getProviderHealth('agnes').status).toBe('healthy');
    const rec = ph.recordProbe('agnes', false, { now: now + 2000, source: 'codex' });
    expect(rec.status).toBe('unhealthy');
    expect(rec.unhealthyUntil).toBe(now + 2000 + 5 * 60 * 1000);
    expect(rec.consecutiveFailures).toBe(3);
  });

  test('阈值内一次成功清空连续失败计数（不累计）', () => {
    ph.recordProbe('agnes', false, { now, source: 'codex' });
    ph.recordProbe('agnes', false, { now: now + 1000, source: 'codex' });
    ph.recordProbe('agnes', true, { now: now + 2000, source: 'codex' });
    const h = ph.getProviderHealth('agnes');
    expect(h.status).toBe('healthy');
    expect(h.consecutiveFailures).toBe(0);
    expect(h.unhealthyUntil).toBeNull();
    // 再失败 2 次仍不到阈值
    ph.recordProbe('agnes', false, { now: now + 3000, source: 'codex' });
    ph.recordProbe('agnes', false, { now: now + 4000, source: 'codex' });
    expect(ph.getProviderHealth('agnes').status).toBe('healthy');
  });

  test('空 providerId 拒绝', () => {
    expect(ph.recordProbe('', false, { now })).toBeNull();
    expect(ph.getProviderHealth('')).toBeNull();
  });
});

describe('isIsolated / shouldIsolateNow — 窗口判定', () => {
  let rec;
  beforeEach(() => {
    for (let i = 0; i < 3; i++) ph.recordProbe('ds', false, { now: now + i * 1000, source: 'codex' });
    rec = ph.getProviderHealth('ds');
    expect(rec.status).toBe('unhealthy');
  });

  test('窗口内 → 建议隔离', () => {
    expect(ph.isIsolated(rec, now + 3000)).toBe(true);
    expect(ph.shouldIsolateNow('ds', now + 3000)).toBe(true);
  });

  test('超过 unhealthyUntil → 不再建议（重新试探）', () => {
    expect(ph.isIsolated(rec, now + 6 * 60 * 1000)).toBe(false);
    expect(ph.shouldIsolateNow('ds', now + 6 * 60 * 1000)).toBe(false);
   });

  test('成功解除 unhealthy → 不再隔离', () => {
    ph.recordProbe('ds', true, { now: now + 10_000, source: 'codex' });
    expect(ph.shouldIsolateNow('ds', now + 10_000)).toBe(false);
  });
});

describe('listIsolated — dashboard 数据源（纯观察，不执行）', () => {
  test('仅返回仍在窗口内的 unhealthy provider', () => {
    for (let i = 0; i < 3; i++) ph.recordProbe('agnes', false, { now: now + i * 1000 });
    for (let i = 0; i < 3; i++) ph.recordProbe('ds', false, { now: now + i * 1000 });
    ph.recordProbe('agnes', true, { now: now + 999_999 }); // agnes 恢复
    const isolated = ph.listIsolated(now);
    const ids = isolated.map((x) => x.providerId);
    expect(ids).toContain('ds');
    expect(ids).not.toContain('agnes');
  });
});

describe('correlateCrossProxy (2b) — 跨 proxy 聚合', () => {
  test('单 source 失败 → single-proxy', () => {
    ph.recordProbe('agnes', false, { now, source: 'codex' });
    ph.recordProbe('agnes', false, { now: now + 1000, source: 'codex' });
    const r = ph.correlateCrossProxy('agnes', now + 2000);
    expect(r.verdict).toBe('single-proxy');
    expect(r.count).toBe(1);
    expect(r.sources).toEqual(['codex']);
  });

  test('两个不同 source 窗口内失败 → network-wide', () => {
    ph.recordProbe('agnes', false, { now, source: 'codex' });
    ph.recordProbe('agnes', false, { now: now + 1000, source: 'hermes' });
    const r = ph.correlateCrossProxy('agnes', now + 2000);
    expect(r.verdict).toBe('network-wide');
    expect(r.count).toBe(2);
    expect(r.sources).toEqual(expect.arrayContaining(['codex', 'hermes']));
  });

  test('窗口外失败不计入聚合', () => {
    ph.recordProbe('agnes', false, { now, source: 'codex' });
    // 5min 后另一个 source
    ph.recordProbe('agnes', false, { now: now + 10 * 60 * 1000, source: 'hermes' });
    const r = ph.correlateCrossProxy('agnes', now + 10 * 60 * 1000);
    expect(r.verdict).toBe('single-proxy');
    expect(r.count).toBe(1);
  });

  test('未知 provider → single-proxy 空集', () => {
    const r = ph.correlateCrossProxy('nope', now + 100000);
    expect(r.verdict).toBe('single-proxy');
    expect(r.count).toBe(0);
    expect(r.sources).toEqual([]);
  });
});

describe('持久化 round-trip + 隔离门控', () => {
  test('save/load 恢复 record 与 recentFailures', () => {
    ph.recordProbe('agnes', false, { now, source: 'codex' });
    ph.recordProbe('agnes', false, { now: now + 1000, source: 'codex' });
    ph.recordProbe('agnes', false, { now: now + 2000, source: 'hermes' }); // network-wide
    // 重新加载模块到同一个文件
    delete require.cache[require.resolve('../../lib/provider-health')];
    const ph2 = require('../../lib/provider-health');
    ph2.setHealthFile(tmpFile);
    ph2.loadProviderHealth();
    const rec = ph2.getProviderHealth('agnes');
    expect(rec.status).toBe('unhealthy');
    expect(rec.consecutiveFailures).toBe(3);
    const r = ph2.correlateCrossProxy('agnes', now + 3000);
    expect(r.verdict).toBe('network-wide');
  });

  test('PROXY_HEALTH_ISOLATE 默认关闭 = observe 模式', () => {
    process.env.PROXY_HEALTH_ISOLATE = '';
    delete process.env.PROXY_HEALTH_ISOLATE;
    expect(ph.isolateEnabled()).toBe(false);
    process.env.PROXY_HEALTH_ISOLATE = '1';
    expect(ph.isolateEnabled()).toBe(true);
    delete process.env.PROXY_HEALTH_ISOLATE;
  });
});