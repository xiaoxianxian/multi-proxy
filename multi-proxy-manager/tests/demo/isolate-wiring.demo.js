// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== M2 隔离「接线」冒烟（node tests/demo/isolate-wiring.demo.js）====================
//
// 与 provider-isolation-executor.demo.js 的分工：
//   那个验**内核**（plan/emit/cooldown/幂等/原子写，8 例）；
//   本脚本验**接线**——复刻 server.js:178-181 的启动判定（门控开 → registerExecutor('writeMarkers')），
//   证明「门控一开整条链路真跑起来」，并守住一条红线：**providers.json 必须一字未动**。
//
// 为什么单独验接线：内核 24 test + 8 demo 全绿，不等于生产接线正确。
//   server.js 那段是 `if (isolationEnabled()) registerExecutor('writeMarkers')`——
//   两把钥匙的第二把在启动期才配。内核绿而接线错（比如门控判断写反）时，
//   现象是「门控开了但 executor 仍空 → 走 degraded-no-executor → 零 fs」，静默无收益。
//
// 隔离性（绝不污染生产）：
//   - sidecar 全部落在 os.tmpdir() 临时目录（setMarkersFile），不碰 ~/.multi-proxy-manager/provider-isolation.json
//   - providers.json 只读 md5 比对，绝不写入
//   - 结束前 unregisterExecutor + reset + 复原 env

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const P = require('../../lib/provider-isolation-executor');

// 生产路由配置——本冒烟的「绝不触碰」红线对象（误改 = 全局路由重排）
const PROVIDERS = path.join(os.homedir(), '.multi-proxy-manager', 'providers.json');
const md5 = (f) => (fs.existsSync(f) ? crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex') : null);
const tmpFile = (tag) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isolate-wiring-')), `provider-isolation-${tag}.json`);

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); } catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const now = Date.now();
const unhealthy = {
  providerId: 'smoke-provider',
  status: 'unhealthy',
  consecutiveFailures: 3,
  unhealthySince: now - 1000,
  unhealthyUntil: now + 5 * 60 * 1000,
  lastSource: 'smoke',
};

console.log('\n=== M2 隔离接线冒烟（复刻 server.js:178-181）===\n');
console.log(`生产 providers.json: ${PROVIDERS}（存在=${fs.existsSync(PROVIDERS)}，本脚本只读不写）\n`);

// ---------- 场景 1：门控关（默认）→ 零 fs，sidecar 绝不出现 ----------
delete process.env.PROXY_HEALTH_ISOLATE;
P.reset();
const fOff = tmpFile('gate-off');
P.setMarkersFile(fOff);

check('1. 门控关（默认）：isolationEnabled=false / observeOnly=true', () => {
  assert.strictEqual(P.isolationEnabled(), false);
  assert.strictEqual(P.observeOnly(), true);
});
check('1b. 门控关：活跃 executor 为空（未注册 writeMarkers）', () => {
  assert.deepStrictEqual(P.getActiveExecutors(), []);
});
const rOff = P.run([unhealthy], { now });
check('1c. 门控关：run() 只产 observe 标记，零落盘', () => {
  assert.strictEqual(rOff.applied, 0);
  assert.strictEqual(rOff.observed, 1);
  assert.strictEqual(fs.existsSync(fOff), false, '门控关绝不该产生 sidecar 文件');
});

// ---------- 场景 2：门控开 + 复刻启动接线 → 真写 sidecar ----------
process.env.PROXY_HEALTH_ISOLATE = '1';
P.reset();
const fOn = tmpFile('gate-on');
P.setMarkersFile(fOn);

// ⬇︎ 这一行就是 server.js:178-181 的复刻
if (P.isolationEnabled()) { P.registerExecutor('writeMarkers'); }

check('2. 门控开：启动接线把 writeMarkers 注册进活跃表（第二把钥匙）', () => {
  assert.strictEqual(P.isolationEnabled(), true);
  assert.ok(P.getActiveExecutors().includes('writeMarkers'), 'writeMarkers 应已激活');
});

const providersBefore = md5(PROVIDERS);
const rOn = P.run([unhealthy], { now });

check('2b. 门控开：run() 真执行，applied=1', () => {
  assert.strictEqual(rOn.applied, 1, `applied 应为 1，实际 ${rOn.applied}`);
  assert.strictEqual(rOn.isolated, 1, '应判定为建议隔离 1 条');
  assert.strictEqual(rOn.degraded, 0, '不应退化（executor 已激活，degraded 应为 0）');
});
check('2c. sidecar 真落盘且含该 provider 条目', () => {
  assert.ok(fs.existsSync(fOn), 'sidecar 应落盘');
  const doc = JSON.parse(fs.readFileSync(fOn, 'utf8'));
  assert.strictEqual(doc.specVersion, P.SPEC_VERSION);
  const m = doc.entries['smoke-provider'];
  assert.ok(m, 'entries 应含 smoke-provider');
  assert.strictEqual(m.executed, true);
  assert.strictEqual(m.reason, 'consecutive-failures');
});
check('2d. 🔴 flippedEnabled=false —— 默认绝不 flip providers.json enabled', () => {
  const doc = JSON.parse(fs.readFileSync(fOn, 'utf8'));
  assert.strictEqual(doc.entries['smoke-provider'].flippedEnabled, false);
});
check('2e. 🔴 providers.json 一字未动（路由零影响，前后 md5 相同）', () => {
  assert.strictEqual(md5(PROVIDERS), providersBefore, 'providers.json 必须未被修改');
});

// ---------- 场景 3：cooldown 防风暴（5min 窗口内二次 → 不再写）----------
const rAgain = P.run([unhealthy], { now: now + 1000 });
check('3. cooldown：同 provider 5min 内二次 → deduped，不重复写盘', () => {
  assert.strictEqual(rAgain.deduped, 1, '第二次应被 cooldown 去重');
  assert.strictEqual(rAgain.applied, 0);
});

// ---------- 场景 4：自愈 heal —— 窗口过期自动解除 ----------
const healed = P.heal({ now: now + 6 * 60 * 1000 });
check('4. heal：unhealthyUntil 过期 → 标记自动解除', () => {
  assert.strictEqual(healed.healed, 1);
  assert.strictEqual(P.count(), 0);
});
check('4b. heal 后 sidecar 反映解除（entries 清空）', () => {
  const doc = JSON.parse(fs.readFileSync(fOn, 'utf8'));
  assert.deepStrictEqual(doc.entries, {}, 'heal 后 entries 应为空');
});

// ---------- 收尾：复原，绝不留下活跃 executor ----------
P.unregisterExecutor('writeMarkers');
P.reset();
delete process.env.PROXY_HEALTH_ISOLATE;

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail === 0 ? 0 : 1);
