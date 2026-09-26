'use strict';
const TP = require('../../../l2/token-policy.js');

describe('token-policy kernel (l2/token-policy.js · P1 设计稿 A1-A3)', () => {
  let tp;
  beforeEach(() => { tp = TP.createTokenPolicy({ gate: false }); });

  test('门控默认 off（PROXY_TOKEN_POLICY 未设）', () => {
    expect(tp.isGateOpen()).toBe(false);
    expect(TP.isGateOpen()).toBe(false);
  });

  test('门控开（gate:true）', () => {
    expect(TP.createTokenPolicy({ gate: true }).isGateOpen()).toBe(true);
  });

  test('5 个 hook 常量齐全', () => {
    expect(TP.HOOKS).toEqual(['onRequestAssemble', 'onHistory', 'onToolOutput', 'onResponse', 'onRoute']);
  });

  test('agent 类型枚举', () => {
    expect(TP.AGENT_TYPES).toEqual(['coding', 'aigc', 'research', 'general']);
  });

  test('非法 hook 抛错', () => {
    expect(() => tp.registerPolicy({ hook: 'onBogus', name: 'x', handler: () => {} })).toThrow(/invalid hook/);
  });

  test('handler 必须是函数', () => {
    expect(() => tp.registerPolicy({ hook: 'onRoute', name: 'x', handler: 1 })).toThrow(/handler must be function/);
  });

  test('重复注册同 hook/name 抛错', () => {
    tp.registerPolicy({ hook: 'onRoute', name: 'a', handler: () => {} });
    expect(() => tp.registerPolicy({ hook: 'onRoute', name: 'a', handler: () => {} })).toThrow(/already registered/);
  });

  test('5 hook 各自执行', () => {
    for (const h of TP.HOOKS) {
      tp.registerPolicy({ hook: h, name: `h-${h}`, handler: () => ({ ok: h }) });
    }
    for (const h of TP.HOOKS) {
      expect(tp.apply(h, { agentType: 'general' }).results[0].out).toEqual({ ok: h });
    }
  });

  test('priority DESC：高优先级先执行', () => {
    const inst = TP.createTokenPolicy({ gate: false, budget: { maxInjectTokens: 1000 } });
    const order = [];
    inst.registerPolicy({ hook: 'onRequestAssemble', name: 'low', priority: 1, handler: () => order.push('low') });
    inst.registerPolicy({ hook: 'onRequestAssemble', name: 'high', priority: 10, handler: () => order.push('high') });
    inst.registerPolicy({ hook: 'onRequestAssemble', name: 'mid', priority: 5, handler: () => order.push('mid') });
    inst.apply('onRequestAssemble', {});
    expect(order).toEqual(['high', 'mid', 'low']);
  });

  test('策略预算：超上限跳过最低优先级（§3.5）', () => {
    const inst = TP.createTokenPolicy({ gate: false, budget: { maxInjectTokens: 100, perPolicyMaxRatio: 0.3 } });
    inst.registerPolicy({ hook: 'onRequestAssemble', name: 'big', priority: 10, handler: () => 'ok', payload: 'x'.repeat(300) });
    inst.registerPolicy({ hook: 'onRequestAssemble', name: 'mid', priority: 5, handler: () => 'ok', payload: 'x'.repeat(150) });
    inst.registerPolicy({ hook: 'onRequestAssemble', name: 'low', priority: 1, handler: () => 'ok', payload: 'x'.repeat(150) });
    const r = inst.apply('onRequestAssemble', {});
    const byName = (n) => r.results.find((x) => x.policy === n);
    expect(byName('big')).toBeDefined();
    expect(byName('mid')).toBeDefined();
    expect(byName('low').skipped).toBe(true);
    expect(inst.report().skippedByBudget).toBe(1);
  });

  test('perPolicyMaxRatio：单 handler 成本截断到上限', () => {
    const inst = TP.createTokenPolicy({ gate: false, budget: { maxInjectTokens: 100, perPolicyMaxRatio: 0.3 } });
    inst.registerPolicy({ hook: 'onToolOutput', name: 'a', handler: () => 'ok', payload: 'x'.repeat(300) });
    const r = inst.apply('onToolOutput', {});
    expect(r.results[0].effCost).toBe(30);
    expect(r.remaining).toBe(70);
  });

  test('集成分叉：integration=true 不扣预算（§4.5）', () => {
    const inst = TP.createTokenPolicy({ gate: false, integration: true, budget: { maxInjectTokens: 100 } });
    inst.registerPolicy({ hook: 'onRequestAssemble', name: 'ext', integration: true, handler: () => ({ ok: true }), payload: 'y'.repeat(9999) });
    const r = inst.apply('onRequestAssemble', {});
    expect(inst.isIntegration()).toBe(true);
    expect(r.remaining).toBe(100);
    expect(r.results[0].integration).toBe(true);
  });

  test('applyPack 默认 enabled=false（§3.4 / 非侵入铁律④）', () => {
    const manifest = {
      name: 'coding', appliesTo: ['coding'], enabled: false,
      hooks: { onRequestAssemble: [{ name: 'g', handler: () => 'g' }], onToolOutput: [{ name: 'r', handler: () => 'r' }] },
    };
    const regs = tp.applyPack(manifest);
    expect(regs.length).toBe(2);
    expect(tp.listPolicies({ enabled: true }).length).toBe(0);
  });

  test('applyPack 显式 enabled=true 则启用', () => {
    const inst = TP.createTokenPolicy({ gate: false });
    inst.applyPack({ name: 'coding', appliesTo: ['coding'], enabled: true, hooks: { onRoute: [{ name: 'route', handler: () => 'x' }] } });
    expect(inst.listPolicies({ enabled: true }).length).toBe(1);
  });

  test('agent 类型过滤：appliesTo 不匹配不执行（§3.6）', () => {
    const hit = [];
    tp.registerPolicy({ hook: 'onRoute', name: 'only-coding', appliesTo: ['coding'], handler: () => hit.push(1) });
    tp.apply('onRoute', { agentType: 'aigc' });
    expect(hit.length).toBe(0);
    tp.apply('onRoute', { agentType: 'coding' });
    expect(hit.length).toBe(1);
  });

  test('报告含 budget / skipped / estSaved 字段', () => {
    const inst = TP.createTokenPolicy({ gate: false, budget: { maxInjectTokens: 50 }, integration: true });
    inst.registerPolicy({ hook: 'onRequestAssemble', name: 'a', handler: () => 'ok' });
    inst.apply('onRequestAssemble');
    const rep = inst.report();
    expect(rep.budget.maxInjectTokens).toBe(50);
    expect('skippedByBudget' in rep).toBe(true);
    expect('estSavedTokens' in rep).toBe(true);
    expect(rep.gate).toBe(false);
  });

  test('handler 异常 shadow：不抛、不改 ctx', () => {
    tp.registerPolicy({ hook: 'onResponse', name: 'boom', handler: () => { throw new Error('oops'); } });
    expect(() => tp.apply('onResponse', { response: 'x' })).not.toThrow();
  });

  test('applyPack 非法 manifest 抛错', () => {
    expect(() => tp.applyPack(null)).toThrow(/manifest must be object/);
    expect(() => tp.applyPack({})).toThrow(/manifest.name required/);
  });
});
