// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).

'use strict';

// l2 SentinelGuard 验收测试（nanoMuse Sentinel 借鉴，2026-10-15）。
//
// 验证点：
//   1. 默认关（零行为变更）：shouldProceed 永远 allow。
//   2. 开 + 无记忆 → 拦截（needs-confirmation），并触发 notify。
//   3. record(always, allow) → 后续一律放行。
//   4. record(once, allow) → 仅本次放行，第二次仍拦。
//   5. record(session, deny) → 拦截。
//   6. 与 circuit-breaker 挂点集成：注入 sentinelGuard 后 allowRequest 多一道确认闸门；
//      不注入（null）时行为逐字不变（向后兼容铁律）。
//
// 跑法：node tests/l2-sentinel-guard.test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const { SentinelGuard, PERM_LEVELS } = require(path.join(__dirname, '..', 'l2', 'sentinel-guard.js'));
const { CircuitBreaker } = require(path.join(__dirname, '..', 'l2', 'circuit-breaker.js'));

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push([true, name]); console.log(`  PASS    ${name}`); })
    .catch((e) => { results.push([false, name]); console.log(`  FAIL    ${name}\n         ${e.message}`); });
}

async function main() {
  console.log('[sentinel-guard] node 直跑（无 jest 依赖）');

  await check('1. 默认关：shouldProceed 永远 allow（零行为变更）', () => {
    const g = new SentinelGuard();
    assert.equal(g.enabled, false);
    const r = g.shouldProceed('delete', 'ctx-x');
    assert.equal(r.allow, true);
    assert.equal(r.reason, 'sentinel-off');
  });

  await check('2. 开 + 无记忆 → 拦截，并触发 notify', () => {
    let notified = null;
    const g = new SentinelGuard({ enabled: true, notify: (info) => { notified = info; } });
    const r = g.shouldProceed('delete', 'ctx-x');
    assert.equal(r.allow, false, '无记忆应拦');
    assert.equal(r.reason, 'needs-confirmation');
    assert.ok(notified && notified.action === 'delete' && notified.target === 'ctx-x', '应触发 notify');
  });

  await check('3. record(always, allow) → 后续一律放行', () => {
    const g = new SentinelGuard({ enabled: true });
    const r0 = g.shouldProceed('pay', 'order-1');
    assert.equal(r0.allow, false);
    g.record('pay', 'order-1', PERM_LEVELS.ALWAYS, 'allow');
    const r1 = g.shouldProceed('pay', 'order-1');
    const r2 = g.shouldProceed('pay', 'order-1');
    assert.equal(r1.allow, true);
    assert.equal(r2.allow, true, 'always 应持续放行');
  });

  await check('4. record(once, allow) → 仅本次放行，第二次仍拦', () => {
    const g = new SentinelGuard({ enabled: true });
    g.record('delete', 'ctx-y', PERM_LEVELS.ONCE, 'allow');
    const r1 = g.shouldProceed('delete', 'ctx-y');
    assert.equal(r1.allow, true, 'once 首次应放行');
    assert.equal(r1.memory, PERM_LEVELS.ONCE);
    const r2 = g.shouldProceed('delete', 'ctx-y');
    assert.equal(r2.allow, false, 'once 用后即焚，第二次应拦');
  });

  await check('5. record(session, deny) → 拦截', () => {
    const g = new SentinelGuard({ enabled: true });
    g.record('send', 'mail-9', PERM_LEVELS.SESSION, 'deny');
    const r = g.shouldProceed('send', 'mail-9');
    assert.equal(r.allow, false);
    assert.equal(r.reason, 'session-deny');
  });

  await check('6a. circuit-breaker 注入 sentinelGuard → allowRequest 多一道闸门', () => {
    const g = new SentinelGuard({ enabled: true });
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 1000 });
    cb.sentinelGuard = g;
    // 无记忆 → 应拦（needs-confirmation 透传为不放行）
    assert.equal(cb.allowRequest('p-a'), false, '注入后无记忆应不放行');
    // 给 handoff 动作记 always allow
    g.record('handoff', 'p-a', PERM_LEVELS.ALWAYS, 'allow');
    assert.equal(cb.allowRequest('p-a'), true, '记 allow 后应放行');
  });

  await check('6b. circuit-breaker 不注入 sentinelGuard → 行为逐字不变', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 1000 });
    assert.equal(cb.sentinelGuard, null);
    assert.equal(cb.allowRequest('p-b'), true, '未注入应直接放行（向后兼容）');
  });

  const bad = results.filter(([ok]) => !ok).length;
  console.log(`\n[结果] ${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
