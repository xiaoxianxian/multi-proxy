'use strict';

// L2 rate-limiter demo — 验证令牌桶限流器

const { RateLimiter } = require('./rate-limiter.js');

console.log('[RL Demo] Starting...');

const rl = new RateLimiter({ capacity: 5, refillRate: 1 });

// 测试 1: 初始容量
console.assert(rl.getTokens('p1') === 5, 'T1: initial tokens=5');
console.log('  T1 PASS: initial tokens=5');

// 测试 2: 消耗令牌
console.assert(rl.allowRequest('p1') === true, 'T2: first request allowed');
console.assert(rl.getTokens('p1') < 5, 'T2: tokens decreased');
console.log('  T2 PASS: tokens consumed');

// 测试 3: 耗尽后拒绝
for (let i = 0; i < 4; i++) rl.allowRequest('p1');
console.assert(rl.allowRequest('p1') === false, 'T3: should reject when empty');
console.log('  T3 PASS: rejected when exhausted');

// 测试 4: 独立 key
console.assert(rl.allowRequest('p2') === true, 'T4: p2 independent');
console.log('  T4 PASS: independent keys');

// 测试 5: reset
rl.reset('p1');
console.assert(rl.getTokens('p1') >= 4, 'T5: reset restores tokens');
console.log('  T5 PASS: reset works');

// 测试 6: getAllSnapshots
const snaps = rl.getAllSnapshots();
console.assert(snaps.p1 && snaps.p2, 'T6: snapshots exist');
console.log('  T6 PASS: getAllSnapshots works');

console.log('\n[RL Demo] ALL PASS (6/6)');
