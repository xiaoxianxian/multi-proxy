'use strict';
// P1 token 控制平面 · token-policy 内核 · 真跑验证
// node l2/token-policy.demo.js → 全 PASS
// 门控 PROXY_TOKEN_POLICY 默认 off（shadow），A1 接口定稿 + A2 策略预算 + A3 集成分叉。
const TP = require('./token-policy.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`! FAIL ${name} -- ${e.message}`); }
};

// 1. 门控默认 off（PROXY_TOKEN_POLICY 未设）
check('门控默认 off', () => {
  const inst = TP.createTokenPolicy();
  assert.strictEqual(inst.isGateOpen(), false);
  assert.strictEqual(TP.isGateOpen(), false);
});

// 2. 门控开（显式 gate:true）
check('门控开（gate:true）', () => {
  const inst = TP.createTokenPolicy({ gate: true });
  assert.strictEqual(inst.isGateOpen(), true);
});

// 3. 非法 hook 抛错（§3.3 只有 5 个 hook）
check('非法 hook 抛错', () => {
  const inst = TP.createTokenPolicy({ gate: false });
  let threw = false;
  try { inst.registerPolicy({ hook: 'onBogus', name: 'x', handler: () => {} }); }
  catch (e) { threw = /invalid hook/.test(e.message); }
  assert.ok(threw, '非 5-hook 的注册应抛错');
});

// 4. 5 个 hook 各自可注册 + 执行
check('5 个 hook 各自可注册', () => {
  const inst = TP.createTokenPolicy({ gate: false });
  for (const h of TP.HOOKS) {
    inst.registerPolicy({ hook: h, name: `h-${h}`, handler: () => ({ ok: h }) });
  }
  const cnt = (TP.HOOKS).length;
  const list = inst.listPolicies({ enabled: true });
  assert.strictEqual(list.length, cnt, `应注册 ${cnt} 个`);
  for (const h of TP.HOOKS) {
    const r = inst.apply(h, { agentType: 'general' });
    assert.deepStrictEqual(r.results[0].out, { ok: h }, `${h} 应执行`);
  }
});

// 5. priority 决定执行顺序（高→低）
check('priority DESC：高优先级先执行', () => {
  const inst = TP.createTokenPolicy({ gate: false, budget: { maxInjectTokens: 1000 } });
  const order = [];
  inst.registerPolicy({ hook: 'onRequestAssemble', name: 'low', priority: 1, handler: () => order.push('low') });
  inst.registerPolicy({ hook: 'onRequestAssemble', name: 'high', priority: 10, handler: () => order.push('high') });
  inst.registerPolicy({ hook: 'onRequestAssemble', name: 'mid', priority: 5, handler: () => order.push('mid') });
  inst.apply('onRequestAssemble', {});
  assert.deepStrictEqual(order, ['high', 'mid', 'low'], '按 priority DESC');
});

// 6. 策略预算 §3.5：超预算跳过低优先级（shadow，不改 ctx）
check('策略预算：超上限跳过低优先级', () => {
  const inst = TP.createTokenPolicy({ gate: false, budget: { maxInjectTokens: 100, perPolicyMaxRatio: 0.3 } });
  const cap = Math.ceil(100 * 0.3); // 30
  inst.registerPolicy({ hook: 'onRequestAssemble', name: 'big', priority: 10, handler: () => 'ok', payload: 'x'.repeat(300) }); // ~100
  inst.registerPolicy({ hook: 'onRequestAssemble', name: 'mid', priority: 5, handler: () => 'ok', payload: 'x'.repeat(150) }); // cap→30
  inst.registerPolicy({ hook: 'onRequestAssemble', name: 'low', priority: 1, handler: () => 'ok', payload: 'x'.repeat(150) }); // cap→30
  const r = inst.apply('onRequestAssemble', {});
  const byName = (n) => r.results.find((x) => x.policy === n);
  assert.ok(byName('big'), 'big 执行');
  assert.ok(byName('mid'), 'mid 截断后执行');
  assert.ok(byName('low').skipped, 'low 超剩余预算被 skip');
  assert.strictEqual(byName('low').integration, false);
  const rep = inst.report();
  assert.strictEqual(rep.skippedByBudget, 1, '1 个 handler 因预算跳过');
});

// 7. perPolicyMaxRatio 单 handler 上限截断
check('perPolicyMaxRatio：单 handler 最多吃 30%', () => {
  const inst = TP.createTokenPolicy({ gate: false, budget: { maxInjectTokens: 100, perPolicyMaxRatio: 0.3 } });
  inst.registerPolicy({ hook: 'onToolOutput', name: 'a', handler: () => 'ok', payload: 'x'.repeat(300) });
  const r = inst.apply('onToolOutput', {});
  assert.strictEqual(r.results[0].effCost, 30, '300-token 指令被截断到 30');
  assert.strictEqual(r.remaining, 70, '100 - 30 = 70');
});

// 8. 集成分叉 §4.5：integration=true 时 cost 不进预算（外部引擎自管）
check('集成分叉：integration=不扣预算', () => {
  const inst = TP.createTokenPolicy({ gate: false, integration: true, budget: { maxInjectTokens: 100 } });
  inst.registerPolicy({ hook: 'onRequestAssemble', name: 'ext', integration: true, handler: () => ({ compressed: true }), payload: 'y'.repeat(9999) });
  const r = inst.apply('onRequestAssemble', {});
  assert.strictEqual(inst.isIntegration(), true);
  assert.strictEqual(r.remaining, 100, '集成模式不扣 remaining');
  assert.strictEqual(r.results[0].integration, true);
  assert.deepStrictEqual(r.results[0].out, { compressed: true });
});

// 9. applyPack：默认 enabled:false（§3.4 / 非侵入铁律④）
check('applyPack 默认 enabled=false（门控铁律）', () => {
  const inst = TP.createTokenPolicy({ gate: false });
  const manifest = {
    name: 'coding',
    appliesTo: ['coding'],
    enabled: false,
    hooks: {
      onRequestAssemble: [{ name: 'graft-inject', handler: () => 'g', priority: 5 }],
      onToolOutput: [{ name: 'rtk', handler: () => 'r', priority: 3 }],
     },
  };
  const regs = inst.applyPack(manifest);
  assert.strictEqual(regs.length, 2, 'pack 注册 2 个 handler');
  const enabled = inst.listPolicies({ enabled: true });
  assert.strictEqual(enabled.length, 0, '默认 enabled=false → 0 个启用');
  // 显式 enabled pack
  const inst2 = TP.createTokenPolicy({ gate: false });
  inst2.applyPack({ name: 'coding', appliesTo: ['coding'], enabled: true, hooks: { onRoute: [{ name: 'route', handler: () => 'x' }] } });
  assert.strictEqual(inst2.listPolicies({ enabled: true }).length, 1, '显式 enabled=true → 启用');
});

// 10. agent 类型过滤（§3.6）
check('agent 类型过滤：appliesTo 不匹配则不执行', () => {
  const inst = TP.createTokenPolicy({ gate: false });
  const hit = [];
  inst.registerPolicy({ hook: 'onRoute', name: 'only-coding', appliesTo: ['coding'], handler: () => hit.push('coding') });
  inst.apply('onRoute', { agentType: 'aigc' });
  assert.strictEqual(hit.length, 0, 'aigc 时 coding 专属 handler 不执行');
  inst.apply('onRoute', { agentType: 'coding' });
  assert.strictEqual(hit.length, 1, 'coding 时执行');
});

// 11. 报告含 budget / skippedByBudget / estSavedTokens
check('报告：budget + skipped + estSaved 字段', () => {
  const inst = TP.createTokenPolicy({ gate: false, budget: { maxInjectTokens: 50, perPolicyMaxRatio: 0.5 }, integration: true });
  inst.registerPolicy({ hook: 'onRequestAssemble', name: 'a', handler: () => 'ok' });
  inst.apply('onRequestAssemble', { now: 1 });
  const rep = inst.report();
  assert.strictEqual(rep.budget.maxInjectTokens, 50);
  assert.ok('skippedByBudget' in rep, '含 skippedByBudget');
  assert.ok('estSavedTokens' in rep, '含 estSavedTokens');
  assert.strictEqual(rep.policyCount, 1);
  assert.strictEqual(rep.gate, false);
});

// 12. handler 异常 shadow（不改 ctx、不抛）
check('handler 异常 shadow：记 error 不抛', () => {
  const inst = TP.createTokenPolicy({ gate: false });
  inst.registerPolicy({ hook: 'onResponse', name: 'boom', handler: () => { throw new Error('oops'); } });
  let threw = false;
  try { inst.apply('onResponse', { response: 'x' }); } catch (e) { threw = true; }
  assert.ok(!threw, 'apply 不抛 handler 异常');
  const rep = inst.report();
  assert.ok(rep.handlersExecuted >= 1, '仍计入执行');
});

console.log(`\n  token-policy demo:  ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
console.log('  PASS');
