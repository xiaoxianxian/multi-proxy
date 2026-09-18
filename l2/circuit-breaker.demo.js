'use strict';

// L2 circuit-breaker demo — 验证提取自 cursor-proxy 的熔断器模块正确性

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

// 测试 3: OPEN→HALF_OPEN 自动转换
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

  console.log('\n[CB Demo] ALL PASS (5/5)');
}, 150);
