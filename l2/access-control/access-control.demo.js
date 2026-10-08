// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// l2/access-control/access-control.demo.js
// 演示：给不同调用方分权限档，在执行有副作用的操作前 guard 一道。
// 运行：node l2/access-control/access-control.demo.js

const { createAccessControl } = require('./access-control.js');

const ac = createAccessControl({
  config: {
    callerTiers: {
      claude: 'safe_write',     // 自己的主力 agent：可建 thread、记成本，不可删/exec
      codex: 'safe_write',
      'cc-switch': 'read_only',  // 第三方上游网关：只许过只读流量
    },
  },
});

console.log('=== report ===');
console.log(JSON.stringify(ac.report(), null, 2));

const cases = [
  ['claude', 'chat.completions'],   // read → 允许
  ['claude', 'thread.create'],      // safe_write → 允许
  ['claude', 'db.write'],           // high_risk_write → 拒绝
  ['cc-switch', 'chat.completions'],// read → 允许
  ['cc-switch', 'savings.record'],  // safe_write → 拒绝（它只有 read_only）
  ['anonymous', 'exec'],            // 未声明调用方 + high_risk → 拒绝（fail-safe）
];

for (const [caller, op] of cases) {
  const r = ac.guard(op, { caller });
  console.log(`[${r.allowed ? 'PASS' : 'DENY'}] ${caller} -> ${op} | tier=${r.tier} cat=${r.category}${r.reason ? ' | ' + r.reason : ''}`);
}

// 门控关时（disabled）一律放行，接入热路径零行为变更
process.env.PROXY_ACCESS_DISABLED = '1';
const acOff = createAccessControl();
console.log('\n=== 门控关（disabled）===');
console.log('cc-switch -> db.write:', acOff.guard('db.write', { caller: 'cc-switch' }).allowed, '(应为 true)');
