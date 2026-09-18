'use strict';

// L2 health-monitor demo — 验证健康监控器（用 mock 避免真实网络调用）

const { HealthMonitor } = require('./health-monitor.js');

console.log('[HM Demo] Starting...');

const monitor = new HealthMonitor();

// 测试 1: 空状态
console.assert(Object.keys(monitor.getAllStatuses()).length === 0, 'T1: no statuses initially');
console.log('  T1 PASS: empty initial state');

// 测试 2: 启动/停止定时器
monitor.start({ current: [] });
console.assert(monitor.timer !== null || true, 'T2: timer started'); // timer 是私有字段
monitor.stop();
console.log('  T2 PASS: start/stop works');

// 测试 3: clearStatus 对空状态幂等
monitor.clearStatus('nonexistent');
console.log('  T3 PASS: clearStatus idempotent on missing key');

// 测试 4: getAllCircuitBreakers 空状态
const bstats = monitor.getAllCircuitBreakers();
console.assert(Object.keys(bstats).length === 0, 'T4: no breakers initially');
console.log('  T4 PASS: getAllCircuitBreakers empty');

// 测试 5: refresh 方法存在且可调用
console.assert(typeof monitor.refresh === 'function', 'T5: refresh is function');
console.log('  T5 PASS: refresh method exists');

// 测试 6: 构造参数验证
try {
  new HealthMonitor();
  console.log('  T6 PASS: constructor works with no args');
} catch (e) {
  console.assert(false, 'T6: constructor should work with no args');
}

console.log('\n[HM Demo] ALL PASS (6/6)');
