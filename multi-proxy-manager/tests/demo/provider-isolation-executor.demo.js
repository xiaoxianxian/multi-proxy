'use strict';
// M2 执行层 · Provider 故障隔离「执行态」demo（node tests/demo/provider-isolation-executor.demo.js）
//
// 全内存 + 临时 sidecar，非侵入、零生产污染：
//   - 真执行写的是临时 provider-isolation sidecar（绝不碰生产 ~/.multi-proxy-manager/providers.json）。
//   - 绝不 flip providers.json enabled（高后果动作；误禁用会重排全局路由）——flip 是另一条 opt-in 注入缝，
//     默认 ctx.flipEnabled=null → 永不触发。见 docs/02-product/m2-execution-signoff.md。
//
// 桥接契约（与 routes/provider-health.js 一致）：消费方把
//   provider-health.listIsolated() 产出逐条 enrich correlation = correlateCrossProxy(id) 后喂给
//   executor.run(list, { now })。本 demo 同时演示 (a) 手搓 list（快、确定）与 (b) 真实 listIsolated()
//   桥接（忠实），两条都非侵入（provider-health 永不写 providers.json / 路由；sidecar 落临时路径）。
//
// 执行态三级（非侵入铁律，与 mcp-server PROXY_ADAPTER_REAL 退化同构）：
//   门控关（默认）            → 恒 observe：plan + 收集内存标记，executor 零调用、零 fs。
//   门控开 + 无活跃 executor  → 退化「仅 plan」：记录「本可隔离」，applied=false，零 fs。
//   门控开 + 活跃 executor     → 真执行：跑 active executor（内置 writeMarkers 原子写 sidecar 为默认真动作），
//                                best-effort（单个抛不崩），默认仍翻转 disabled=false。
const P = require('../../lib/provider-isolation-executor');
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}      -- ${e.message}`); }
};
// 临时 sidecar 路径（绝不碰生产）：每个真执行场景独立文件，跑完清理。
const tmpFile = (tag) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm2-isolation-demo-')), `provider-isolation-${tag}.json`);
// listIsolated() 单条产出形如：{ providerId, status, consecutiveFailures, unhealthySince, unhealthyUntil, lastSource }
const rec = (id, t, now, extra = {}) => Object.assign({
  providerId: id, status: 'unhealthy', consecutiveFailures: 3,
  unhealthySince: t, unhealthyUntil: t + 5 * 60 * 1000, lastSource: 'codex',
}, extra);

// 模拟「消费方」把 listIsolated() 产出逐条 enrich correlation（与 routes/provider-health.js 同形）
function withCorrelation(list, correlate /* (id) => {verdict,sources,count} */) {
  return list.map((r) => Object.assign({}, r, { correlation: correlate(r.providerId) }));
}

let gateSaved = process.env.PROXY_HEALTH_ISOLATE;
const setGate = (v) => {
  if (v == null) { delete process.env.PROXY_HEALTH_ISOLATE; } else { process.env.PROXY_HEALTH_ISOLATE = v; }
};

try {
  // ---- 场景 1：门控关（默认）→ produce advice + observe，零执行 / 零 fs ----
  check('门控关（默认）→ listIsolated 产出建议但不执行（observe，零 fs）', () => {
    setGate(null);                       // 默认关
    assert.strictEqual(P.isolationEnabled(), false, '默认 observe');
    assert.strictEqual(P.observeOnly(), true, '默认 observe');
    const f = tmpFile('observe');
    const svc = P.createIsolationExecutor({ file: f });       // 内置 writeMarkers 可用但不活跃
    assert.deepStrictEqual(svc.getActiveExecutors(), [], '默认无活跃 executor（两把钥匙之一：未注册）');
    const list = withCorrelation([rec('agnes', 1_000_000, 1_000_000)], (id) => ({ verdict: 'single-proxy', sources: ['codex'], count: 1 }));
    const summ = svc.run(list, { now: 1_000_010, persist: true });
    assert.strictEqual(summ.isolated, 1, '建议隔离数=1');
    assert.strictEqual(summ.applied, 0, '执行(写盘)=0');
    assert.strictEqual(summ.observed, 1, 'observe 计数=1');
    assert.strictEqual(svc.count(), 1, '建议进内存标记表（供观测/回滚）');
    assert.strictEqual(fs.existsSync(f), false, '门控关：即使 persist:true 也不落盘（非侵入）');
  });

  // ---- 场景 2：门控开 + 注入 executor → 真执行（原子写临时 sidecar），但绝不 flip providers.json ----
  check('门控开 + 注入 writeMarkers → 真执行（写临时 sidecar；flippedEnabled=false 永不动 providers.json）', () => {
    setGate('1');
    const f = tmpFile('exec');
    const svc = P.createIsolationExecutor({ file: f });
    svc.registerExecutor('writeMarkers');                  // 激活内置 exec：原子写 sidecar（默认 disabled 标记）
    const list = withCorrelation(
      [rec('agnes', 1_000_000, 1_000_000), rec('ds', 1_000_000, 1_000_000, { lastSource: 'hermes' })],
      (id) => ({ verdict: id === 'ds' ? 'network-wide' : 'single-proxy',
                 sources: id === 'ds' ? ['codex', 'hermes', 'cursor'] : ['hermes'],
                 count: id === 'ds' ? 3 : 1 }));
    const summ = svc.run(list, { now: 1_000_010 });
    assert.strictEqual(summ.applied, 2, '两个建议都执行落盘');
    assert.strictEqual(summ.degraded, 0, '有活跃 executor，不退化');
    assert.strictEqual(fs.existsSync(f), true, 'sidecar 已写临时路径');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(doc.specVersion, '1.0.0', 'sidecar 带 specVersion');
    assert.ok(doc.entries.agnes && doc.entries.ds, '两条 entries 上写');
    assert.strictEqual(doc.entries.agnes.flippedEnabled, false, 'never flip providers.json enabled（高后果动作默认关）');
    assert.strictEqual(doc.entries.ds.verdict, 'network-wide', '跨 proxy 全网故障语义带进标记');
    // 幂等：同一建议二次 emit 不重写盘
    const m0 = fs.statSync(f).mtimeMs;
    svc.run(list, { now: 1_000_020 });
    assert.strictEqual(fs.statSync(f).mtimeMs, m0, '幂等：重复建议不重写盘（mtime 不变）');
    try { fs.unlinkSync(f); } catch {}
  });

  // ---- 场景 3：门控开但无活跃 executor → 退化「仅 plan」（非侵入，零 fs）----
  check('门控开 + 无活跃 executor → 退化仅 plan（applied=false / degraded，零 fs）', () => {
    setGate('1');
    const f = tmpFile('degraded');
    const svc = P.createIsolationExecutor({ file: f });   // 不 registerExecutor → active=[]
    const summ = svc.run([rec('agnes', 1_000_000, 1_000_000)], { now: 1_000_010, persist: true });
    assert.strictEqual(summ.applied, 0, '无活跃 executor → 不执行');
    assert.strictEqual(summ.degraded, 1, '退化计数=1');
    assert.strictEqual(fs.existsSync(f), false, '退化仅 plan：不触 fs（非侵入）');
   });

  // ---- 场景 4：单个 executor 抛错 → best-effort 不崩，其它 executor / 主流程照常 ----
  check('executor 抛错 → best-effort 不崩（其它活跃 executor 照写）', () => {
    setGate('1');
    const f = tmpFile('boom');
    const svc = P.createIsolationExecutor({ file: f });
    svc.registerExecutor('boom', () => { throw new Error('kaboom'); }); // 故意抛
    svc.registerExecutor('writeMarkers');                                  // 仍要写
    const list = [rec('agnes', 1_000_000, 1_000_000)];
    let threw = false;
    try { const r = svc.emit(list[0], { now: 1_000_010 });
      assert.strictEqual(r.applied, true, 'writeMarkers 仍执行成功');
      const boom = r.executorResults.find((x) => x.executor === 'boom');
      assert.strictEqual(boom.ok, false, 'boom 标记失败');
      assert.ok(/kaboom/.test(boom.error), 'boom error 被记录');
    } catch (e) { threw = true; }
    assert.strictEqual(threw, false, 'emit 不向外抛（best-effort）');
    assert.strictEqual(fs.existsSync(f), true, 'writeMarkers 已落盘 sidecar');
    try { fs.unlinkSync(f); } catch {}
  });

  // ---- 场景 5：cooldown 防隔离风暴（同 providerId 窗口内只执行一次）----
  check('cooldown：同 providerId 窗口内第二次 dedup（不重写盘 / 不重派）', () => {
    setGate('1');
    const f = tmpFile('cooldown');
    const svc = P.createIsolationExecutor({ file: f });
    svc.registerExecutor('writeMarkers');
    const list = [rec('agnes', 1_000_000, 1_000_000)];
    const e1 = svc.emit(list[0], { now: 1_000_010 });
    const e2 = svc.emit(list[0], { now: 1_000_030 });                  // 窗口内
    assert.strictEqual(e1.applied, true, '首次执行');
    assert.strictEqual(e2.deduped, true, '冷却期内去重');
    assert.strictEqual(e2.applied, false, '冷却期不重写盘');
    try { fs.unlinkSync(f); } catch {}
  });

  // ---- 场景 6：回滚 / 自愈（窗口到期自动解除，重写 sidecar 反映解除）----
  check('rollback / heal：窗口到期自动解除隔离并重写 sidecar', () => {
   setGate('1');
   const f = tmpFile('heal');
   const svc = P.createIsolationExecutor({ file: f });
   svc.registerExecutor('writeMarkers');
   const list = [rec('agnes', 1_000_000, 1_000_000)];    // unhealthyUntil = 1_000_000 + 5min = 1_300_000
   svc.emit(list[0], { now: 1_000_010 });
   assert.strictEqual(svc.count(), 1, '隔离生效');
   const h = svc.heal({ now: 1_300_001 });                // 窗口已过（1_300_000）
    assert.strictEqual(h.healed, 1, 'heal 解除 1 条');
    assert.strictEqual(svc.count(), 0, '标记清空');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(doc.entries.agnes, undefined, 'sidecar 已不含 agnes');
    try { fs.unlinkSync(f); } catch {}
  });

  // ---- 场景 7：真实桥接——消费 provider-health.listIsolated()（非侵入：其永不写 providers.json/路由）----
  check('真实桥接：provider-health.listIsolated() + correlateCrossProxy → executor.run（observe 不写盘）', () => {
    setGate(null);                                   // observe
    delete require.cache[require.resolve('../../lib/provider-health')];
    const ph = require('../../lib/provider-health');
    const phFile = tmpFile('ph-source');
    ph.setHealthFile(phFile);
    ph.resetProviderHealth();
    ph.setClock(() => 1_000_010);
    ph.setHealthConfig({ failureThreshold: 3, isolateDelayMs: 5 * 60 * 1000, crossProxyThreshold: 2, crossProxyWindowMs: 5 * 60 * 1000 });
    // agnes：3 次连续失败（single-proxy）；ds：两个 source 失败（network-wide）
    for (let i = 0; i < 3; i++) ph.recordProbe('agnes', false, { now: 1_000_010 + i, source: 'codex', persist: true });
    ph.recordProbe('ds', false, { now: 1_000_010, source: 'codex', persist: true });
    ph.recordProbe('ds', false, { now: 1_000_011, source: 'hermes', persist: true });   // 2 source → network-wide
    ph.recordProbe('ds', false, { now: 1_000_012, source: 'codex', persist: true });
    // 消费方 enrich（与 routes/provider-health.js 同形）
    const svc = P.createIsolationExecutor({ file: tmpFile('bridge') });
    const enriched = ph.listIsolated().map((r) => Object.assign({}, r, { correlation: ph.correlateCrossProxy(r.providerId) }));
    const summ = svc.run(enriched, { now: 1_000_020, persist: true });
    assert.ok(summ.isolated >= 2, 'listIsolated 产出 ≥2 条建议');
    assert.strictEqual(summ.applied, 0, 'observe：建议产出但不执行');
    assert.strictEqual(P.count(), 0, '单例未被 demo 触达');
    try { fs.unlinkSync(phFile); } catch {}
    delete require.cache[require.resolve('../../lib/provider-health')];
  });

  // ---- 场景 8：高后果 flip 是 opt-in 注入缝——默认 ctx.flipEnabled=null 永不触发 ----
  check('flip providers.json = opt-in 注入缝（默认 ctx.flipEnabled=null → 永不 flip）', () => {
   setGate('1');
   const svc = P.createIsolationExecutor({ file: tmpFile('flip-default') });
   let flipped = 0;
    // 模拟「翻 enabled」executor：只在 ctx.flipEnabled 存在时才动作（默认 null → 不动）
   svc.registerExecutor('maybeFlip', (plan, ctx) => {
     if (typeof ctx.flipEnabled === 'function') { flipped++; ctx.flipEnabled(plan.providerId, false); }
     return { via: 'maybeFlip', applied: false, flipped: !!ctx.flipEnabled };
    });
    // 默认：无注入 flipEnabled → 高后果动作不触发
   svc.emit(rec('agnes', 1_000_000, 1_000_000), { now: 1_000_010 }); // 无 context → flipEnabled=null
   assert.strictEqual(flipped, 0, '默认不注入 flipEnabled → 永不 flip（高后果动作默认关）');

    // opt-in：换 provider（避开 cooldown）+ 显式注入 ctx.flipEnabled（需 sign-off 才启用真 flip）→ 真调
   let flippedOptin = 0;
   svc.emit(rec('ds', 2_000_000, 2_000_000), {
     now: 2_000_010, context: { flipEnabled: (id, v) => { flippedOptin++; } },
    });
   assert.ok(flippedOptin >= 1, 'opt-in 注入 flipEnabled → maybeFlip 真调用');
  });
} finally {
  // 始终恢复门控，绝不泄漏 PROXY_HEALTH_ISOLATE=1 给后续测试
  setGate(gateSaved);
  delete require.cache[require.resolve('../../lib/provider-health')];
}

console.log(`\n[M2 执行层 demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
