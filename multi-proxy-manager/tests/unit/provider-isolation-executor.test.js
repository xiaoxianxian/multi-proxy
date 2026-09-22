/**
 * M2 执行层 — provider-isolation-executor 单元测试。
 *
 * 与 alert.test.js 同构：门控/可插拔/非侵入铁律一致，但角色相反——
 *  alert.js 消费健康/错误信号「判级成告警」；本模块消费 provider-health.listIsolated()
 *  「判级后（门控下）标记隔离」。覆盖：
 *   - 门控关（默认）= observe：只 plan + 收集内存标记，零 executor 调用、零 fs。
 *   - 门控开 + 注入 executor → 真执行（原子写临时 sidecar；flippedEnabled=false 永不动 providers.json）。
 *   - 门控开 + 无活跃 executor → 退化「仅 plan」（非侵入，零 fs）。
 *   - executor 抛错 = best-effort 不崩（其它 executor / 主流程照常）。
 *   - 幂等（重复 emit 稳定键不变 → 不重写盘）。
 *   - cooldown（同 providerId 窗口内只执行一次，防隔离风暴）。
 *   - rollback / heal（窗口到期自动解除 + 重写 sidecar）。
 *   - flip providers.json = opt-in 注入缝（默认 ctx.flipEnabled=null 永不触发；注入才真 flip）。
 *   - 真实桥接：消费 provider-health.listIsolated() + correlateCrossProxy()（observe 不写盘）。
 *
 * 非侵入铁律：全部真执行测试走 createIsolationExecutor({ file: tmp }) 工厂 + 临时 sidecar 路径，
 *  绝不触生产 ~/.multi-proxy-manager/provider-isolation.json；单例测试经 setMarkersFile(tmp) + reset 隔离。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../../lib/provider-isolation-executor');
const ph = require('../../lib/provider-health');

let t = 0;             // 测试固定时钟推进量
let tmp = null;        // 临时 sidecar 路径

beforeEach(() => {
  t = 1_000_000;
  tmp = path.join(os.tmpdir(), `pie-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  // 确保临时路径起始不存在
  try { fs.unlinkSync(tmp); } catch { /* 不存在则跳过 */ }
});

afterEach(() => {
  // 绝不泄漏门控 + 清理临时文件
  delete process.env.PROXY_HEALTH_ISOLATE;
  try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
});

// listIsolated() 单条产出形如：{ providerId, status, consecutiveFailures, unhealthySince, unhealthyUntil, lastSource }
const rec = (id = 'agnes', extra = {}) => Object.assign({
  providerId: id,
  status: 'unhealthy',
  consecutiveFailures: 3,
  unhealthySince: t,
  unhealthyUntil: t + 5 * 60 * 1000,
  lastSource: 'codex',
}, extra);

const makeSvc = (cfg) => P.createIsolationExecutor({ file: tmp, config: cfg });
const wideRec = (id='agnes', extra={}) => Object.assign(rec(id, extra), { unhealthyUntil: 1_000_000 + 10 * 60 * 1000 });

// ---------- 门控 / observe ----------
describe('门控 · observe 默认（PROXY_HEALTH_ISOLATE 默认关）', () => {
  test('默认 observe：isolationEnabled=false / observeOnly=true', () => {
    delete process.env.PROXY_HEALTH_ISOLATE;
    expect(P.isolationEnabled()).toBe(false);
    expect(P.observeOnly()).toBe(true);
  });

  test('门控关 → 即使 persist:true 也只观察、不执行、不写盘（非侵入）', () => {
    delete process.env.PROXY_HEALTH_ISOLATE;
    const svc = makeSvc();
    // 内置 writeMarkers 可注册为活跃（演示“有钥匙也拦得住”），但门控关仍不写盘
    svc.registerExecutor('writeMarkers');
    const r = svc.emit(rec(), { now: t + 10, persist: true });
    expect(r.isolate).toBe(true);
    expect(r.observe).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.executed).toBe(false);
    expect(r.reason).toBe('observe');
    expect(svc.count()).toBe(1);                 // 建议进内存标记供观测/回滚
    expect(fs.existsSync(tmp)).toBe(false);       // 绝不落盘
  });

  test('plan() 纯判定：unhealthy-in-window → isolate；不触 executor/不写盘', () => {
    const p = P.plan(rec(), t + 10);
    expect(p.isolate).toBe(true);
    expect(p.reason).toBe('consecutive-failures'); // 无 correlation → single-proxy
    expect(p.verdict).toBe('single-proxy');
    expect(p.consecutiveFailures).toBe(3);
  });
});

// ---------- 门控开 + 真执行 ----------
describe('门控开 + 注入 executor → 真执行（原子 sidecar，绝不 flip providers.json）', () => {
  test('registerExecutor(writeMarkers) + 门控开 → 写入临时 sidecar，flippedEnabled=false', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    const r = svc.emit(rec(), { now: t + 10 });
    expect(r.isolate).toBe(true);
    expect(r.executed).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.reason).toBeUndefined();              // 非 observe/degraded/cooldown 路径
    expect(fs.existsSync(tmp)).toBe(true);
    const doc = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    expect(doc.specVersion).toBe(P.SPEC_VERSION);
    expect(doc.entries.agnes).toBeDefined();
    expect(doc.entries.agnes.flippedEnabled).toBe(false); // 高后果动作默认关：永不动 providers.json
    expect(doc.entries.agnes.reason).toBe('consecutive-failures');
    expect(r.marker.viaExecutor).toContain('writeMarkers');
  });

  test('network-wide verdict 带入标记 sources', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    const r = svc.emit(rec('ds', {
      correlation: { verdict: 'network-wide', sources: ['codex', 'hermes', 'cursor'], count: 3 },
      lastSource: 'cursor',
    }), { now: t + 10 });
    expect(r.applied).toBe(true);
    const doc = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    expect(doc.entries.ds.verdict).toBe('network-wide');
    expect(doc.entries.ds.sources).toEqual(['codex', 'hermes', 'cursor']);
  });

  test('幂等：同稳定键重复 emit → 不重写盘（mtime 不变 / applied=false）', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    svc.emit(rec(), { now: t + 10 });
    const m0 = fs.statSync(tmp).mtimeMs;
    // 超过 cooldown 但仍同稳定键（reason/verdict/sources 不变）→ 第二次写盘是 no-change
    const r2 = svc.emit(rec(), { now: t + 10 + 6 * 60 * 1000 });
    expect(r2.applied).toBe(false);
    expect(fs.statSync(tmp).mtimeMs).toBe(m0);
  });

  test('run 批量：多条建议各自落盘 + summary 计数', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    const summ = svc.run([rec('agnes'), rec('ds', { lastSource: 'hermes' })], { now: t + 10 });
    expect(summ.processed).toBe(2);
    expect(summ.isolated).toBe(2);
    expect(summ.applied).toBe(2);
    expect(summ.degraded).toBe(0);
    expect(svc.count()).toBe(2);
    const doc = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    expect(Object.keys(doc.entries).sort()).toEqual(['agnes', 'ds']);
  });
});

// ---------- 门控开 + 退化 ----------
describe('门控开 + 无活跃 executor → 退化“仅 plan”（非侵入，零 fs）', () => {
  test('未注册 executor → applied=false / degraded / 不写盘', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();              // active executors = []
    expect(svc.getActiveExecutors()).toEqual([]);
    const r = svc.emit(rec(), { now: t + 10, persist: true });
    expect(r.isolate).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.executed).toBe(false);
    expect(r.reason).toBe('degraded-no-executor');
    expect(fs.existsSync(tmp)).toBe(false);
  });
});

// ---------- best-effort ----------
describe('executor 抛错 = best-effort（不崩、不影响其它 executor / 主流程）', () => {
  test('一个 executor 抛 → 记录失败但仍派发其它，emit 不向外抛', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('boom', () => { throw new Error('kaboom'); });
    svc.registerExecutor('writeMarkers');  // 仍要写
    let threw = false;
    let r;
    try {
      r = svc.emit(rec(), { now: t + 10 });
    } catch (e) { threw = true; }
    expect(threw).toBe(false);
    expect(r.applied).toBe(true);                       // writeMarkers 仍落盘
    const boom = r.executorResults.find((x) => x.executor === 'boom');
    expect(boom).toBeDefined();
    expect(boom.ok).toBe(false);
    expect(boom.error).toMatch(/kaboom/);
    expect(fs.existsSync(tmp)).toBe(true);
  });
});

// ---------- cooldown 防隔离风暴 ----------
describe('cooldown（同 providerId 窗口内只执行一次）', () => {
  test('窗口内第二次 → deduped=true / applied=false / 不重写盘', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    const e1 = svc.emit(rec(), { now: t + 10 });
    const e2 = svc.emit(rec(), { now: t + 30 });   // 窗口内
    expect(e1.applied).toBe(true);
    expect(e1.deduped).toBe(false);
    expect(e2.deduped).toBe(true);
    expect(e2.applied).toBe(false);
    expect(e2.reason).toBe('cooldown');
  });

  test('超过 cooldown → 重新执行（窗口内仍 unhealthy，内容变化 → 写盘）', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc({ cooldownMs: 300000 });
    svc.registerExecutor('writeMarkers');
     // 窗口必须仍开放（unhealthyUntil >> now），否则 plan 会 window-expired 直接不隔离
     // 第二次 emit 用不同 consecutiveFailures（5 > 3）以产生不同 stableKey → commit 实际写盘
    svc.emit(rec('agnes', { unhealthyUntil: 1_000_000 + 10 * 60 * 1000, consecutiveFailures: 3 }), { now: 1_000_010 });
    const again = svc.emit(rec('agnes', { unhealthyUntil: 1_000_000 + 10 * 60 * 1000, consecutiveFailures: 5 }), { now: 1_000_010 + 300001 });
    expect(again.deduped).toBe(false);
    expect(again.applied).toBe(true);
    expect(again.executed).toBe(true);
    });
});

// ---------- 回滚 / 自愈 ----------
describe('rollback / heal（解除隔离）', () => {
  test('rollback 清内存标记 + 重写 sidecar 移除该 provider', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    svc.emit(rec(), { now: t + 10 });
    expect(svc.count()).toBe(1);
    const rb = svc.rollback('agnes', { now: t + 20 });
    expect(rb.removed).toBe(true);
    expect(svc.count()).toBe(0);
    const doc = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    expect(doc.entries.agnes).toBeUndefined();
  });

  test('heal：窗口已到期 → 自动解除并重写 sidecar', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    svc.emit(rec(), { now: t + 10 });   // unhealthyUntil = t + 5min
    const h = svc.heal({ now: t + 5 * 60 * 1000 + 1 });
    expect(h.healed).toBe(1);
    expect(svc.count()).toBe(0);
  });

  test('observe 模式 rollback/heal 只清内存、不重写盘', () => {
    delete process.env.PROXY_HEALTH_ISOLATE;
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    svc.emit(rec(), { now: t + 10 });
    const rb = svc.rollback('agnes', { now: t + 20 });
    expect(rb.removed).toBe(true);
    expect(rb.written).toBeNull();      // observe 不写盘
  });
});

// ---------- plan 纯判定 ----------
describe('plan() 纯判定路径', () => {
  test('healthy → 不隔离（reason=healthy）', () => {
    expect(P.plan(Object.assign(rec(), { status: 'healthy', unhealthyUntil: t + 999 }), t).isolate).toBe(false);
    expect(P.plan(Object.assign(rec(), { status: 'healthy', unhealthyUntil: t + 999 }), t).reason).toBe('healthy');
  });

  test('window-expired → 不隔离', () => {
    const p = P.plan(Object.assign(rec(), { unhealthyUntil: t - 1 }), t);
    expect(p.isolate).toBe(false);
    expect(p.reason).toBe('window-expired');
  });

  test('无 record → no-record', () => {
    expect(P.plan(null, t).reason).toBe('no-record');
  });
});

// ---------- flip providers.json：opt-in 注入缝 ----------
describe('flip providers.json = opt-in 注入缝（默认 ctx.flipEnabled=null 永不触发）', () => {
  test('默认不注入 → 高后果动作不执行（flipped=0）', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    let flipped = 0;
    svc.registerExecutor('maybeFlip', (plan, ctx) => {
      if (typeof ctx.flipEnabled === 'function') { flipped++; ctx.flipEnabled(plan.providerId, false); }
      return { via: 'maybeFlip', applied: false, flipped: !!ctx.flipEnabled };
    });
    svc.emit(rec(), { now: t + 10 });      // 无 context → flipEnabled=null
    expect(flipped).toBe(0);
  });

  test('opt-in 注入 ctx.flipEnabled → executor 真调用高后果缝', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc({ cooldownMs: 300000 });
    let flipCallCount = 0;
    // executor 仅当注入缝存在时才调用它（opt-in 语义）——证明「默认不 flip」是调用方决定的
    svc.registerExecutor('maybeFlip', (p, ctx) => {
      let invoked = false;
      if (ctx && typeof ctx.flipEnabled === 'function') { ctx.flipEnabled(p.providerId, false); invoked = true; }
      return { via: 'maybeFlip', applied: false, flip: invoked };
     });
    // 默认不注入 → 不 flip
    svc.emit(rec('ds', { unhealthyUntil: 1_000_000 + 10 * 60 * 1000 }), { now: 1_000_010 });
    // opt-in 注入 → executor 真调用 flipEnabled
    svc.emit(rec('ds', { unhealthyUntil: 1_000_000 + 10 * 60 * 1000 }), {
      now: 1_000_010 + 300001,
      context: { flipEnabled: () => { flipCallCount++; } },
     });
    expect(flipCallCount).toBe(1);   // 仅 opt-in 时高后果缝被调用
   });
});

// ---------- 真实桥接：消费 provider-health.listIsolated() ----------
describe('真实桥接 · provider-health.listIsolated() + correlateCrossProxy()（observe 不写盘）', () => {
  test('门控关：listIsolated 产出建议但不执行（非侵入）', () => {
    delete process.env.PROXY_HEALTH_ISOLATE;
    const phFile = path.join(os.tmpdir(), `pie-ph-${process.pid}-${Date.now()}.json`);
    ph.setHealthFile(phFile);
    ph.resetProviderHealth();
    ph.setClock(() => t + 10);
    ph.setHealthConfig({
      failureThreshold: 3,
      isolateDelayMs: 5 * 60 * 1000,
      crossProxyThreshold: 2,
      crossProxyWindowMs: 5 * 60 * 1000,
    });
    // agnes：3 连失（single）；ds：2 个 source 失 → network-wide
    for (let i = 0; i < 3; i++) ph.recordProbe('agnes', false, { now: t + 10 + i, source: 'codex', persist: true });
    ph.recordProbe('ds', false, { now: t + 10, source: 'codex', persist: true });
    ph.recordProbe('ds', false, { now: t + 11, source: 'hermes', persist: true }); // 2 source
    ph.recordProbe('ds', false, { now: t + 12, source: 'codex', persist: true });
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    const enriched = ph.listIsolated().map((r) =>
      Object.assign({}, r, { correlation: ph.correlateCrossProxy(r.providerId) }));
    const summ = svc.run(enriched, { now: t + 20, persist: true });
    expect(summ.isolated).toBeGreaterThanOrEqual(2);
    expect(summ.applied).toBe(0);          // observe：建议产出但不执行
    expect(fs.existsSync(tmp)).toBe(false);
    try { fs.unlinkSync(phFile); } catch { /* cleanup */ }
  });
});

// ---------- registerExecutor 参数校验 + 工厂/查询 ----------
describe('registerExecutor / 查询 / 工厂', () => {
  test('registerExecutor(name, fn) 参数校验：name 无效抛 "name required"，fn 非函数抛 "fn must be a function"', () => {
    const svc = makeSvc();
    expect(() => svc.registerExecutor(null)).toThrow(/name required/);
    expect(() => svc.registerExecutor(42, () => {})).toThrow(/name required/);
    expect(() => svc.registerExecutor('x', null)).toThrow(/fn must be a function/);
    expect(() => svc.registerExecutor('x', 42)).toThrow(/fn must be a function/);
    });

  test('registerExecutor(name) + unregister → getActiveExecutors 一致', () => {
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    expect(svc.getActiveExecutors()).toContain('writeMarkers');
    svc.unregisterExecutor('writeMarkers');
    expect(svc.getActiveExecutors()).not.toContain('writeMarkers');
  });

  test('list / count / reset', () => {
    process.env.PROXY_HEALTH_ISOLATE = '1';
    const svc = makeSvc();
    svc.registerExecutor('writeMarkers');
    svc.emit(rec('agnes'), { now: t + 10 });
    expect(svc.count()).toBe(1);
    expect(svc.list().length).toBe(1);
    expect(svc.list({ reason: 'consecutive-failures' }).length).toBe(1);
    svc.reset();
    expect(svc.count()).toBe(0);
    expect(svc.list()).toHaveLength(0);
  });

  test('SPEC_VERSION / ISOLATION_MARKERS_FILE 默认', () => {
    expect(P.SPEC_VERSION).toBe('1.0.0');
    expect(P.ISOLATION_MARKERS_FILE).toBe(
      path.join(os.homedir(), '.multi-proxy-manager', 'provider-isolation.json'));
  });
});
