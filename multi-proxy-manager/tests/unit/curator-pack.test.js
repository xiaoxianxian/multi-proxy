'use strict';
// Curator pack 单元验收（M7 · 07-curator-pack-TASKS.md）
// 覆盖：默认关(0 results)/enable/disable 三态/appliesTo 过滤/handler 抛错 ok:false 不
//       中断/snapshot+rollback/预算不超/applyChange(M6 受限变更)/observe。
// 非侵入铁律④：pack 默认 enabled:false，未 enable 时 0 行为变更、不触网。
// 数字诚实：本报告只用模拟场景（passthrough + 注入 mock handler），不宣称生产级收益。
//
// 三条实测结论（07 §0，贯穿本测）：
//   修正 1：开关靠 applyPack 返回的 policy 引用（refs）翻 enabled，不重新 applyPack（会抛已注册）。
//   修正 2：pack 自建 createTokenPolicy() 实例，不用模块单例（module.exports 没导 _policies/_runHistory）。
//   修正 4：apply 必须传 ctx.agentType，否则 appliesTo 不命中静默跳过（0 results、不报错）。

const { createCurator, CHANGE_VALIDATORS, POLICY_FILES } = require('../../../packs/curator/curator-engine.js');
const TP = require('../../../l2/token-policy.js');

// 默认 5 个 hook + name（applyPack 给 name 套 [curator] 前缀）
const DEFAULT_HOOKS = POLICY_FILES.map((p) => p.hook); // 5 个 hook

describe('Curator pack · 默认关（非侵入铁律④）', () => {
  test('install 后 5 hook 的 apply 全 0 results（未 enable 不触网、不变 ctx）', () => {
    const c = createCurator();
    expect(c.refs.length).toBe(5); // 5 个 passthrough policy
    for (const h of DEFAULT_HOOKS) {
      const r = c.apply(h, { agentType: 'coding', history: [1, 2, 3], rawOutput: 'x', response: 'y', messages: [] });
      expect(r.results.length).toBe(0);
    }
    // listPolicies({enabled:true}) 视角也确认 0 个 enabled（走 instance，非 c.policies 吞 filter）
    expect(c.instance.listPolicies({ enabled: true }).length).toBe(0);
  });

  test('refs 全部 enabled:false（applyPack 默认关，§3.4）', () => {
    const c = createCurator();
    for (const p of c.refs) {
      expect(p.enabled).toBe(false);
      expect(TP.AGENT_TYPES).toContain('coding'); // sanity：默认 appliesTo 子集合法
    }
  });
});

describe('Curator pack · enable / disable 三态', () => {
  test('enable → 执行且 out 正确（passthrough 全量）→ disable 回 0', () => {
    const c = createCurator();

    // 关：0
    expect(c.apply('onHistory', { agentType: 'coding', history: [1, 2, 3] }).results.length).toBe(0);

    // 开：5 个 policy 全翻 true，enable() 返回 5
    expect(c.enable()).toBe(5);
    const r = c.apply('onHistory', { agentType: 'coding', history: [1, 2, 3] });
    expect(r.results.length).toBe(1);
    // memory-history passthrough：keepLastN=null → 全量保留
    expect(r.results[0].out.history).toEqual([1, 2, 3]);
    expect(r.results[0].ok).toBe(true);

    // 5 个 hook 各自 out 形状
    expect(c.apply('onToolOutput', { agentType: 'coding', rawOutput: 'abc', toolName: 't' }).results[0].out.rawOutput).toBe('abc');
    expect(c.apply('onResponse', { agentType: 'coding', response: 'hello' }).results[0].out.response).toBe('hello');
    expect(c.apply('onRoute', { agentType: 'coding', taskMeta: {} }).results[0].out.planMode).toBe('pass');
    expect(c.apply('onRequestAssemble', { agentType: 'coding', messages: [] }).results[0].out.messages).toEqual([]);

    // 关：回 0
    expect(c.disable()).toBe(5);
    expect(c.apply('onHistory', { agentType: 'coding', history: [1, 2, 3] }).results.length).toBe(0);
  });
});

describe('Curator pack · appliesTo 过滤（修正 4：ctx.agentType 必须命中）', () => {
  test('默认 appliesTo=[coding,aigc,research]：coding 命中、general 不命中（静默 0、不报错）', () => {
    const c = createCurator({ appliesTo: ['coding', 'aigc', 'research'] });
    c.enable();

    // 命中
    const hit = c.apply('onHistory', { agentType: 'coding', history: [1] });
    expect(hit.results.length).toBe(1);
    expect(hit.results[0].ok).toBe(true);

    // 不命中：不抛错、静默 0 results（极易误判成"pack 没生效"，故显式断言）
    expect(c.apply('onHistory', { agentType: 'general', history: [1] }).results.length).toBe(0);
  });

  test('不传 agentType → appliesTo 过滤掉（appliesTo.includes(undefined)=false）', () => {
    const c = createCurator();
    c.enable();
    expect(c.apply('onHistory', { history: [1] }).results.length).toBe(0);
  });
});

describe('Curator pack · handler 抛错被吞成 ok:false、流程不中断（token-policy.js:169-170）', () => {
  test('抛错 policy 记 ok:false + error，后续仍 apply 不崩', () => {
    // 自定义 hooks：onHistory 注入一个抛错 handler + 一个正常 handler（验证不中断）
    const c = createCurator({
      hooks: {
        onHistory: [
          { name: 'boom', handler: () => { throw new Error('boom'); } },
          { name: 'after', handler: (x) => ({ history: (x.history || []).slice(1) }) },
        ],
      },
      appliesTo: ['coding'],
    });
    c.enable();

    const r = c.apply('onHistory', { agentType: 'coding', history: [1, 2, 3] });
    // 抛错那条 ok:false、error 含 'boom'
    const boom = r.results.find((x) => x.policy.includes('boom'));
    expect(boom).toBeDefined();
    expect(boom.ok).toBe(false);
    expect(boom.error).toMatch(/boom/);
    // 不中断：第二条正常执行
    const after = r.results.find((x) => x.policy.includes('after'));
    expect(after).toBeDefined();
    expect(after.ok).toBe(true);
    expect(r.results.length).toBe(2);

    // 服务仍可用：再 apply 不抛
    expect(() => c.apply('onHistory', { agentType: 'coding', history: [9] })).not.toThrow();
  });
});

describe('Curator pack · snapshot / rollback（修正 1：围绕 refs，不重 applyPack）', () => {
  test('snapshot(enable 前全 false) → enable → restore 回 false', () => {
    const c = createCurator();
    const snap = c.snapshot(); // 此刻全 false
    expect(snap.policies.every((p) => p.enabled === false)).toBe(true);
    expect(snap.policies.length).toBe(5);

    c.enable();
    expect(c.state().every((p) => p.enabled === true)).toBe(true);

    const restored = c.restore(snap); // 翻回快照值
    expect(restored).toBe(5);
    expect(c.state().every((p) => p.enabled === false)).toBe(true);

    // 回滚后仍可继续 apply（实例存活、不中断）
    expect(c.apply('onHistory', { agentType: 'coding', history: [1] })).toBeDefined();
  });

  test('restore(snap=null) 安全返回 0、不抛', () => {
    const c = createCurator();
    expect(c.restore(null)).toBe(0);
  });
});

describe('Curator pack · 预算不超（§3.5：maxInjectTokens:1000 / perPolicyMaxRatio:0.3）', () => {
  test('默认预算值不被破坏；passthrough cost=0 不触发跳过', () => {
    const c = createCurator();
    const rep0 = c.instance.report();
    expect(rep0.budget).toEqual({ maxInjectTokens: 1000, perPolicyMaxRatio: 0.3 });

    c.enable(); // 5 个 passthrough，cost 全 0
    for (const h of DEFAULT_HOOKS) {
      c.apply(h, { agentType: 'coding', history: [1], rawOutput: 'x', response: 'y', messages: [], taskMeta: {} });
    }
    const rep = c.instance.report();
    // 预算上限/单策略比例不被运行扰动
    expect(rep.budget.maxInjectTokens).toBe(1000);
    expect(rep.budget.perPolicyMaxRatio).toBe(0.3);
    // 全 cost=0 → 无因预算跳过
    expect(rep.skippedByBudget).toBe(0);
    // 余量保持满（0 扣减）
    expect(rep.remainingTokens).toBe(1000);
  });

  test('perPolicyMaxRatio：单 handler 成本 > 30% 上限时截断到上限', () => {
    const c = createCurator();
    const inst = c.instance;
    // ⚠️ 长度按 2026-10-01 校准后的估算系数（ASCII ≈ 0.255 token/字符）反推：
    // 1500 字符 → 382 > per = ceil(1000*0.3)=300 → 截断到 300（旧口径 ceil(901/3)=301 也能截断，故长度改大以保住「截断」这条断言）
    inst.registerPolicy({ hook: 'onToolOutput', name: 'big', priority: 5, handler: () => 'ok', payload: 'x'.repeat(1500) });
    const r = inst.apply('onToolOutput', {});
    const big = r.results.find((x) => x.policy === 'big');
    expect(big).toBeDefined();
    expect(big.effCost).toBe(300);
    expect(big.ok).toBe(true);
  });

  test('超剩余预算 → 低优先级 policy 被跳过（§3.5 串行贪心：前几个截断吃满后，末个 skip）', () => {
    const c = createCurator();
    const inst = c.instance; // 默认 budget max=1000 / perPolicyMaxRatio=0.3 → per=ceil(1000*0.3)=300
    // 4 个 policy，priority DESC，各 cost=1500 字符 → 382（>per=300 → 截断 300）
    // p1: 382<1000 → eff 300, 余 700；p2: eff 300, 余 400；p3: eff 300, 余 100；p4: 382>100 → skipped
    for (const [prio, name] of [[10, 'p1'], [9, 'p2'], [8, 'p3'], [7, 'p4']]) {
      inst.registerPolicy({ hook: 'onRequestAssemble', name, priority: prio, handler: () => 'ok', payload: 'x'.repeat(1500) });
    }
    const r = inst.apply('onRequestAssemble', {});
    expect(r.results.find((x) => x.policy === 'p1').ok).toBe(true);
    expect(r.results.find((x) => x.policy === 'p1').effCost).toBe(300); // 截断到 per-policy 上限
    expect(r.results.find((x) => x.policy === 'p4').skipped).toBe(true); // 余 100 < 301 → skip
    // 注：apply 对 skipped policy 仍执行 handler 并记 ok:true+skipped:true（shadow 记账，不实际注入/扣减）
    expect(inst.report().skippedByBudget).toBe(1);
  });
});

describe('Curator pack · applyChange 受限变更（M6 · 机械 assert 拦非法值，不安装）', () => {
  test('合法值 keepLastN=3 安装 + apply 后 out 按新参数切到最后 3 个', () => {
    const c = createCurator();
    const res = c.applyChange('onHistory', 'keepLastN', 3);
    expect(res.installed).toBe(true);
    expect(res.value).toBe(3);
    expect(res.hook).toBe('onHistory');
    // applyChange 内部已 enable 目标 policy；history 5 元素切片到 3
    const r = c.apply('onHistory', { agentType: 'coding', history: [1, 2, 3, 4, 5] });
    expect(r.results[0].out.history).toEqual([3, 4, 5]);
  });

  test('非法值被机械 assert 拦住、不安装：0 / 99 / 非整数 / 未知 change / 未知 hook', () => {
    const c = createCurator();
    expect(c.applyChange('onHistory', 'keepLastN', 0).installed).toBe(false);    // 下界
    expect(c.applyChange('onHistory', 'keepLastN', 99).installed).toBe(false);   // 上界（>20）
    expect(c.applyChange('onHistory', 'keepLastN', 1.5).installed).toBe(false);  // 非整数
    expect(c.applyChange('onHistory', 'keepLastN', 'abc').installed).toBe(false); // 类型错
    expect(c.applyChange('onHistory', 'bogus', 5).installed).toBe(false);        // 未知 change
    expect(c.applyChange('onBogus', 'keepLastN', 5).installed).toBe(false);      // 未知 hook
    // 被拦的不安装：onHistory 默认 enabled:false，非法值 install 失败 → 仍 false
    const onHistory = c.state().find((p) => p.hook === 'onHistory');
    expect(onHistory.enabled).toBe(false);
  });

  test('CHANGE_VALIDATORS 边界自洽（keepLastN∈(0,20]、maxOutputChars∈(0,20000]、ratio∈(0,1]）', () => {
    expect(CHANGE_VALIDATORS.keepLastN(1)).toBe(true);
    expect(CHANGE_VALIDATORS.keepLastN(20)).toBe(true);
    expect(CHANGE_VALIDATORS.maxOutputChars(20000)).toBe(true);
    expect(CHANGE_VALIDATORS.perPolicyMaxRatio(1)).toBe(true);
    expect(CHANGE_VALIDATORS.keepLastN(21)).toBe(false);
    expect(CHANGE_VALIDATORS.maxOutputChars(20001)).toBe(false);
    expect(CHANGE_VALIDATORS.perPolicyMaxRatio(1.5)).toBe(false);
  });
});

describe('Curator pack · observe（M5：report + _runHistory 实例访问）', () => {
  test('enable + apply 后：report hookInvocations≥1、_runHistory 有明细、budget 字段在', () => {
    const c = createCurator({ hooks: { onResponse: [{ name: 'passthrough', handler: (x) => x }] } });
    c.enable();
    c.apply('onResponse', { agentType: 'coding', response: 'x' });
    const rep = c.observe();
    expect(rep.hookInvocations).toBeGreaterThanOrEqual(1);
    expect(c.instance._runHistory.length).toBeGreaterThanOrEqual(1);
    expect(rep.budget.maxInjectTokens).toBe(1000);
  });
});
