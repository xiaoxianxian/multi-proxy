'use strict';

// L2 circuit-breaker demo — 验证提取自 cursor-proxy 的熔断器模块正确性
// P0-1 (cc-switch 借鉴 2026-10-08) 追加 T6-T10：错误率滑窗/mRequests 门控/successThreshold/per-provider。

const { CircuitBreaker } = require('./circuit-breaker.js');

console.log('[CB Demo] Starting...');

// 测试 1: 初始状态 CLOSED
const cb1 = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 1000 });
console.assert(cb1.currentState === 'CLOSED', 'T1: initial state should be CLOSED');
console.assert(cb1.allowRequest() === true, 'T1: should allow request when CLOSED');
console.log('  T1 PASS: initial CLOSED, allowRequest=true');

// 测试 2: 连续失败触发熔断
cb1.recordFailure();
cb1.recordFailure();
console.assert(cb1.currentState === 'CLOSED', 'T2: still CLOSED after 2 failures');
cb1.recordFailure();
console.assert(cb1.currentState === 'OPEN', 'T2: should be OPEN after 3 failures');
console.assert(cb1.allowRequest() === false, 'T2: should block request when OPEN');
console.log('  T2 PASS: 3 failures → OPEN, allowRequest=false');

// 测试 3: OPEN→HALF_OPEN 自动转换（异步段）
const cb2 = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 100 });
cb2.recordFailure();
cb2.recordFailure();
console.assert(cb2.currentState === 'OPEN', 'T3: should be OPEN');
// 等待 resetTimeout 到期
setTimeout(() => {
  console.assert(cb2.currentState === 'HALF_OPEN', 'T3: should auto-transition to HALF_OPEN');
  console.log('  T3 PASS: OPEN→HALF_OPEN after timeout');

   // HALF_OPEN 成功 → CLOSED
  cb2.recordSuccess();
  console.assert(cb2.currentState === 'CLOSED', 'T3: should be CLOSED after success in HALF_OPEN');
  console.log('  T3 PASS: HALF_OPEN→CLOSED on success');

   // 重新启动测试：HALF_OPEN 失败 → OPEN
  cb2.recordFailure();
  console.assert(cb2.currentState === 'OPEN', 'T3: should be OPEN after failure in HALF_OPEN');
  console.log('  T3 PASS: HALF_OPEN→OPEN on failure');

   // 测试 4: reset() 手动恢复
  cb2.reset();
  console.assert(cb2.currentState === 'CLOSED', 'T4: reset() should force CLOSED');
  console.log('  T4 PASS: reset() works');

   // 测试 5: getStateSnapshot
  const snap = cb2.getStateSnapshot();
  console.assert(snap.state === 'CLOSED', 'T5: snapshot state');
  console.assert(snap.config.failureThreshold === 2, 'T5: snapshot config');
  console.log('  T5 PASS: getStateSnapshot works');

   // === P0-1 (cc-switch 借鉴 2026-10-08)：错误率滑窗 + minRequests 门控 + successThreshold + per-provider ===
   // T6 向后兼容铁证：全部门控默认关 → 老行为逐字不变
  const cb6 = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 1000 });
  cb6.recordSuccess();
  cb6.recordFailure(); cb6.recordFailure();
  console.assert(cb6.currentState === 'CLOSED', 'T6: 2 fails still CLOSED (errorRate off → old counting only)');
  cb6.recordFailure();
  console.assert(cb6.currentState === 'OPEN', 'T6: 3 fails → OPEN via old failureThreshold (gates off)');
  const snap6 = cb6.getStateSnapshot();
  console.assert(!('errorRate' in snap6), 'T6: default gate-off → no errorRate in snapshot (backward compatible)');
  console.log('  T6 PASS: default(off) gates → old behavior verbatim, no errorRate in snapshot');

   // T7 minRequests 门控：样本不足 → 错误率虽高但不开熔断(防低流量误熔断)
  const cb7 = new CircuitBreaker({ failureThreshold: 5, slidingWindowSize: 5, errorRateThreshold: 0.7, minRequests: 5 });
  cb7.recordFailure(); cb7.recordFailure(); cb7.recordFailure(); cb7.recordFailure();
  console.assert(cb7.currentState === 'CLOSED', 'T7: 4 fails but samples(4)<minRequests(5) → not OPEN');
  cb7.recordFailure(); // 5 样本 → 1.0 > 0.7 → OPEN
  console.assert(cb7.currentState === 'OPEN', 'T7: 5 fails, sample≥min, errorRate>thresh → OPEN');
  console.log('  T7 PASS: minRequests gate — opens only when sample≥minRequests');

   // T8 门控全关(仅 failureThreshold，不设 slidingWindow/errorRate) → 错误率路径永不触发(向后兼容)
  const cb8 = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 1000 });
  cb8.recordFailure(); cb8.recordFailure();
  console.assert(cb8.currentState === 'CLOSED', 'T8: 2 fails, errorRate not configured → still CLOSED');
  console.log('  T8 PASS: errorRate path dormant unless slidingWindowSize+errorRateThreshold both set');

   // T9 per-provider 独立：providerA 熔断不影响 providerB(用 allowRequest 表达 provider 级状态)
   const cb9 = new CircuitBreaker({ failureThreshold: 2, resetTimeout: 10000 });
   cb9.recordFailure('A'); cb9.recordFailure('A');
   console.assert(cb9.allowRequest('A') === false, 'T9: provider A 2 fails → OPEN → blocks');
   console.assert(cb9.allowRequest('B') === true, 'T9: provider B untouched → all');
   const provs = cb9.getProviders();
   console.assert(provs.A && provs.A.state === 'OPEN', 'T9: getProviders lists A OPEN');
   console.log('  T9 PASS: per-provider isolation — A OPEN/blocks, B all');

   // T10 successThreshold 生效：HALF_OPEN 后单次成功不回 CLOSED(threshold=2)
  const cb10 = new CircuitBreaker({ failureThreshold: 1, resetTimeout: 30, slidingWindowSize: 4, errorRateThreshold: 0.6, successThreshold: 2 });
  cb10.recordFailure(); // 1 败 = failureThreshold=1 → OPEN
  console.assert(cb10.currentState === 'OPEN', 'T10: 1 fail → OPEN (failureThreshold=1)');

   // T10 异步段：等 resetTimeout(30ms)进 HALF_OPEN，单次成功不够，需 2 次
  setTimeout(() => {
    console.assert(cb10.currentState === 'HALF_OPEN', 'T10: OPEN→HALF_OPEN after resetTimeout');
    cb10.recordSuccess(); // 第 1 次成功，successThreshold=2 → 仍 HALF_OPEN
    console.assert(cb10.currentState === 'HALF_OPEN', 'T10: 1 success < threshold(2) → still HALF_OPEN');
    cb10.recordSuccess(); // 第 2 次成功 → CLOSED
    console.assert(cb10.currentState === 'CLOSED', 'T10: 2nd success ≥ threshold(2) → CLOSED');
    console.log('  T10 PASS: successThreshold — HALF_OPEN needs N consecutive successes to close');
    console.log('\n[CB Demo] ALL PASS (10/10, incl P0-1)');
  }, 60);

}, 150);
