// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * l2/route-sticky.js 单元测试（node:test，零第三方依赖）。
 *
 * 覆盖（外部对照 #71 PilotDeck 落地件，2026-10-18；双通道设计当日修正）：
 *   1. isContinuation：白名单命中（中英+尾标点）；「继续改需求」不命中（不是整体确认）；
 *      超长不命中；非字符串 false。
 *   2. StickyStore：主/子双轨隔离；容量淘汰最旧；重复 set 刷新插入序；delete/clear。
 *   3. resolveTierDecision 分支：
 *      · 门控关 ⇒ null（judgeFn 一次都不调）；
 *      · sticky 命中 ⇒ from=sticky，judgeFn 零调用（省调用是机制目的）；
 *      · **无 sticky + 请求级 previousTier + 短确认** ⇒ from=continuation，
 *        judgeFn 零调用（双通道设计：previousTier 是请求级透传，不走 store）；
 *      · 首轮（无 previousTier）⇒ 调 judge，from=judge，结果写 store；
 *      · judge 失败/抛错 ⇒ from=fallback，tier=defaultTier（不崩）；
 *      · 无 sessionKey ⇒ null（调用方退化原路径）；
 *      · 子 agent 轨独立（不撞主轨 sticky）。
 *
 * 跑法：node --test l2/tests/route-sticky.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StickyStore,
  isContinuation,
  resolveTierDecision,
  GATE_ENV,
} = require('../route-sticky.js');

// ---- isContinuation ----

test('isContinuation：白名单整体命中（中英混合）', () => {
  for (const t of ['好的', '继续', '冲', '嗯', '可以', 'go', 'continue', 'ok', 'yes', 'proceed']) {
    assert.equal(isContinuation(t), true, `「${t}」应判为续聊`);
  }
});

test('isContinuation：尾标点不算数（「好的。」「继续!」仍是确认）', () => {
  assert.equal(isContinuation('好的。'), true);
  assert.equal(isContinuation('继续!'), true);
  assert.equal(isContinuation('ok?'), true);
});

test('isContinuation：带内容的句子不是确认（整体匹配，不是包含匹配）', () => {
  assert.equal(isContinuation('继续改需求'), false);
  assert.equal(isContinuation('好的，把第三章重写'), false);
  assert.equal(isContinuation('go ahead and refactor the module'), false);
});

test('isContinuation：超长不命中；非字符串 false', () => {
  assert.equal(isContinuation('这是一段很长的普通消息明显超过确认词长度上限'), false);
  assert.equal(isContinuation(''), false);
  assert.equal(isContinuation(null), false);
  assert.equal(isContinuation(undefined), false);
  assert.equal(isContinuation(42), false);
});

test('isContinuation：「开始」刻意不收（可能是新任务首句，锁错比不锁糟）', () => {
  assert.equal(isContinuation('开始'), false);
  assert.equal(isContinuation('跑'), false);
});

// ---- StickyStore ----

test('StickyStore：主/子双轨隔离', () => {
  const s = new StickyStore();
  s.set('sess1', true, { tier: 'large' });
  s.set('sess1', false, { tier: 'small' });
  assert.equal(s.get('sess1', true).tier, 'large');
  assert.equal(s.get('sess1', false).tier, 'small');
});

test('StickyStore：容量淘汰最旧（Map 保序）', () => {
  const s = new StickyStore(2);
  s.set('a', true, { tier: 'small' });
  s.set('b', true, { tier: 'medium' });
  s.set('c', true, { tier: 'large' }); // 超容量 ⇒ 淘汰最旧 'a'
  assert.equal(s.size, 2);
  assert.equal(s.get('a', true), null);
  assert.equal(s.get('b', true).tier, 'medium');
  assert.equal(s.get('c', true).tier, 'large');
});

test('StickyStore：重复 set 同 key 刷新插入序（不算新条目）', () => {
  const s = new StickyStore(2);
  s.set('a', true, { tier: 'small' });
  s.set('b', true, { tier: 'medium' });
  s.set('a', true, { tier: 'large' });  // 刷新 a
  s.set('c', true, { tier: 'small' });  // 超容 ⇒ 应淘汰 b（a 刚被刷新）
  assert.equal(s.get('a', true).tier, 'large');
  assert.equal(s.get('b', true), null);
});

test('StickyStore：delete / clear / 空 key 空值不存', () => {
  const s = new StickyStore();
  s.set('a', true, { tier: 'small' });
  s.delete('a', true);
  assert.equal(s.get('a', true), null);
  s.set(null, true, { tier: 'small' });   // 空 key 拒绝
  s.set('b', true, null);                  // 空值拒绝
  assert.equal(s.size, 0);
  s.set('c', true, { tier: 'small' });
  s.clear();
  assert.equal(s.size, 0);
});

// ---- resolveTierDecision ----

// 小工具：带 judge 调用计数的假 judgeFn
function countingJudge(result, calls) {
  return async (text, opts) => {
    calls.count += 1;
    calls.lastOpts = opts;
    return result;
  };
}

// 小工具：跑单个用例时开/还门控
async function withGate(fn) {
  const saved = process.env[GATE_ENV];
  process.env[GATE_ENV] = '1';
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env[GATE_ENV] = saved; else delete process.env[GATE_ENV];
  }
}

test('resolveTierDecision：门控关 ⇒ null 且 judgeFn 零调用', async () => {
  const saved = process.env[GATE_ENV];
  delete process.env[GATE_ENV];
  try {
    const calls = { count: 0 };
    const r = await resolveTierDecision({
      text: '帮我写个组件', sessionKey: 's1', judgeFn: countingJudge({ tier: 'medium' }, calls), store: new StickyStore(),
    });
    assert.equal(r, null);
    assert.equal(calls.count, 0);
  } finally {
    if (saved !== undefined) process.env[GATE_ENV] = saved;
  }
});

test('resolveTierDecision：sticky 命中 ⇒ 不调 judge（省调用是机制目的）', async () => {
  await withGate(async () => {
    const calls = { count: 0 };
    const store = new StickyStore();
    // 先首轮建 sticky（走 judge 通道）
    await resolveTierDecision({
      text: '帮我写个复杂的调度器', sessionKey: 's1', isMainAgent: true,
      judgeFn: countingJudge({ tier: 'large' }, calls), store,
    });
    assert.equal(calls.count, 1);
    // 第二轮（哪怕消息不是短确认）⇒ sticky 直接沿用
    const r = await resolveTierDecision({
      text: '把刚才那个调度器的超时逻辑再改细一点', sessionKey: 's1', isMainAgent: true,
      judgeFn: countingJudge({ tier: 'small' }, calls), store,
    });
    assert.equal(r.from, 'sticky');
    assert.equal(r.tier, 'large');
    assert.equal(calls.count, 1, 'sticky 命中时一次模型都不该调');
  });
});

test('resolveTierDecision：无 sticky + 请求级 previousTier + 短确认 ⇒ continuation，不调 judge', async () => {
  await withGate(async () => {
    const calls = { count: 0 };
    const store = new StickyStore(); // 空 store：无服务端 sticky
    const r = await resolveTierDecision({
      text: '继续', sessionKey: 's1', isMainAgent: true,
      previousTier: 'large', // 请求级透传（客户端带的上一轮档位）
      judgeFn: countingJudge({ tier: 'small' }, calls), store,
    });
    assert.equal(r.from, 'continuation');
    assert.equal(r.tier, 'large');
    assert.equal(calls.count, 0, '续聊锁定不新增 judge 调用');
    // 续聊命中也落一条 sticky（下轮起走 sticky 通道）
    assert.equal(store.get('s1', true).tier, 'large');
  });
});

test('resolveTierDecision：首轮（无 previousTier）走 judge，结果写 store', async () => {
  await withGate(async () => {
    const calls = { count: 0 };
    const store = new StickyStore();
    const r = await resolveTierDecision({
      text: '重构整个支付模块', sessionKey: 's2', isMainAgent: true,
      judgeFn: countingJudge({ tier: 'large' }, calls), store,
    });
    assert.equal(r.from, 'judge');
    assert.equal(r.tier, 'large');
    assert.equal(calls.count, 1);
    assert.equal(calls.lastOpts.previousTier, undefined, '首轮无 previousTier 不硬传');
    assert.equal(store.get('s2', true).tier, 'large');
  });
});

test('resolveTierDecision：有 previousTier 的非续聊消息 ⇒ 仍走 judge 但带上轮上下文', async () => {
  await withGate(async () => {
    const calls = { count: 0 };
    const store = new StickyStore();
    const r = await resolveTierDecision({
      text: '把支付模块的退款链路单独拆一个服务', sessionKey: 's2b', isMainAgent: true,
      previousTier: 'medium',
      judgeFn: countingJudge({ tier: 'large' }, calls), store,
    });
    assert.equal(r.from, 'judge');
    assert.equal(calls.lastOpts.previousTier, 'medium', 'previousTier 透传给 judge 做上下文');
    assert.equal(r.previousTier, 'medium');
  });
});

test('resolveTierDecision：judge 返回 null ⇒ fallback 到 defaultTier', async () => {
  await withGate(async () => {
    const store = new StickyStore();
    const r = await resolveTierDecision({
      text: '某条消息', sessionKey: 's3', isMainAgent: true, defaultTier: 'medium',
      judgeFn: async () => null, store,
    });
    assert.equal(r.from, 'fallback');
    assert.equal(r.tier, 'medium');
  });
});

test('resolveTierDecision：judge 抛错不崩（旁路纪律）⇒ fallback', async () => {
  await withGate(async () => {
    const store = new StickyStore();
    const r = await resolveTierDecision({
      text: '某条消息', sessionKey: 's4', isMainAgent: true, defaultTier: 'small',
      judgeFn: async () => { throw new Error('judge down'); }, store,
    });
    assert.equal(r.from, 'fallback');
    assert.equal(r.tier, 'small');
  });
});

test('resolveTierDecision：无 sessionKey ⇒ null（调用方退化原路径）', async () => {
  await withGate(async () => {
    const calls = { count: 0 };
    const r = await resolveTierDecision({
      text: '消息', sessionKey: null, judgeFn: countingJudge({ tier: 'small' }, calls),
      store: new StickyStore(),
    });
    assert.equal(r, null);
    assert.equal(calls.count, 0);
  });
});

test('resolveTierDecision：子 agent 轨独立（不撞主轨 sticky）', async () => {
  await withGate(async () => {
    const calls = { count: 0 };
    const store = new StickyStore();
    // 主轨首轮
    await resolveTierDecision({
      text: '复杂任务', sessionKey: 's5', isMainAgent: true,
      judgeFn: countingJudge({ tier: 'large' }, calls), store,
    });
    // 子轨首轮 ⇒ 不吃主轨 sticky，自己判
    const r = await resolveTierDecision({
      text: '子任务', sessionKey: 's5', isMainAgent: false,
      judgeFn: countingJudge({ tier: 'small' }, calls), store,
    });
    assert.equal(r.from, 'judge');
    assert.equal(r.tier, 'small');
    assert.equal(calls.count, 2, '子轨独立判定');
    assert.equal(store.get('s5', false).tier, 'small');
    assert.equal(store.get('s5', true).tier, 'large');
  });
});

test('resolveTierDecision：子轨续聊同样锁档（previousTier 与轨位无关）', async () => {
  await withGate(async () => {
    const calls = { count: 0 };
    const store = new StickyStore();
    const r = await resolveTierDecision({
      text: '好的', sessionKey: 's6', isMainAgent: false,
      previousTier: 'small',
      judgeFn: countingJudge({ tier: 'large' }, calls), store,
    });
    assert.equal(r.from, 'continuation');
    assert.equal(r.tier, 'small');
    assert.equal(calls.count, 0);
  });
});
