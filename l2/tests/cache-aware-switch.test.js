// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * l2/cache-aware-switch.js 单元测试（node:test，零第三方依赖）。
 *
 * 覆盖（外部对照 #71 PilotDeck 落地件，2026-10-18）：
 *   1. 同模型 / 无 current / 无 token 估算 ⇒ 不决策（keepCurrent=false + reason）。
 *   2. 无 cache 观测（hitRatio=0）⇒ 放行切换（没依据不硬留）。
 *   3. 缺任一侧价表 ⇒ 放行 + reason（不拿 0 冒充免费）。
 *   4. 缺 cacheRead 价 ⇒ 放行 + reason。
 *   5. 留档更便宜 ⇒ keepCurrent=true，cacheLoss>0。
 *   6. 切档更便宜（next 单价低到覆盖 cache 损失）⇒ keepCurrent=false。
 *   7. hitRatio 口径：cacheRead/input，超 1 截断。
 *   8. 价表两种键名都收（provider/model 复合键 + 裸 model 键）。
 *
 * 跑法：node --test l2/tests/cache-aware-switch.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCacheAwareSwitch } = require('../cache-aware-switch.js');

const PRICING = {
  'p1/big': { input: 30, output: 60, cacheRead: 3 },   // 每百万 token CNY
  'p1/small': { input: 2, output: 4, cacheRead: 0.2 },
  'p1/nocache': { input: 10, output: 20 },             // 缺 cacheRead 价
};

test('同模型 ⇒ 无所谓切不切', () => {
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p1', model: 'big' },
    next: { provider: 'p1', model: 'big' },
    estimatedInputTokens: 10000,
  });
  assert.equal(r.keepCurrent, false);
  assert.equal(r.reason, 'same model');
});

test('无 current 参照系 ⇒ 不决策', () => {
  const r = evaluateCacheAwareSwitch({
    next: { provider: 'p1', model: 'small' },
    estimatedInputTokens: 10000,
  });
  assert.equal(r.keepCurrent, false);
  assert.equal(r.reason, 'no current reference');
});

test('无本轮 token 估算 ⇒ 不决策', () => {
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p1', model: 'big' },
    next: { provider: 'p1', model: 'small' },
    estimatedInputTokens: 0,
  });
  assert.equal(r.keepCurrent, false);
  assert.equal(r.reason, 'no estimated input tokens');
});

test('无 cache 观测（hitRatio=0）⇒ 放行切换，不硬留', () => {
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p1', model: 'big' },
    next: { provider: 'p1', model: 'small' },
    estimatedInputTokens: 10000,
    lastUsage: { inputTokens: 10000, cacheReadTokens: 0 },
    pricing: PRICING,
  });
  assert.equal(r.keepCurrent, false);
  assert.equal(r.hitRatio, 0);
  assert.match(r.reason, /no cache observation/);
});

test('缺任一侧价表 ⇒ 放行 + reason（不拿 0 冒充免费）', () => {
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p1', model: 'big' },
    next: { provider: 'p1', model: 'unlisted' },
    estimatedInputTokens: 10000,
    lastUsage: { inputTokens: 10000, cacheReadTokens: 8000 },
    pricing: PRICING,
  });
  assert.equal(r.keepCurrent, false);
  assert.match(r.reason, /missing pricing for next/);
});

test('current 价表缺 cacheRead 价 ⇒ 放行 + reason', () => {
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p1', model: 'nocache' },
    next: { provider: 'p1', model: 'small' },
    estimatedInputTokens: 10000,
    lastUsage: { inputTokens: 10000, cacheReadTokens: 8000 },
    pricing: PRICING,
  });
  assert.equal(r.keepCurrent, false);
  assert.match(r.reason, /missing cacheRead/);
});

test('留档更便宜 ⇒ keepCurrent=true，账算得对', () => {
  // 上轮命中率 0.8；本轮估算 10000 token。
  // 留 big：8000×3/1e6 + 2000×30/1e6 = 0.024+0.06 = 0.084
  // 切 small：10000×2/1e6 = 0.02  ← small 单价太低，切过去反而便宜！
  // 这组是「切档更便宜」场景，换下一组验留档。
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p1', model: 'big' },
    next: { provider: 'p1', model: 'small' },
    estimatedInputTokens: 10000,
    lastUsage: { inputTokens: 10000, cacheReadTokens: 8000 },
    pricing: PRICING,
  });
  assert.equal(r.keepCurrent, false, 'small 单价低到覆盖 cache 损失 ⇒ 该切');
  assert.equal(r.cachedCost, 0.084);
  assert.equal(r.prefillCost, 0.02);
  assert.ok(r.cacheLoss < 0, '负损失 = 切档反而省');
  assert.equal(r.hitRatio, 0.8);
});

test('留档更便宜 ⇒ keepCurrent=true（next 是另一个贵模型）', () => {
  // current=big 有 cache 命中；next 换另一套贵价（无复合键，用裸键）
  const pricing = {
    big: { input: 30, output: 60, cacheRead: 3 },
    'other-big': { input: 40, output: 80, cacheRead: 5 },
  };
  // 留 big：8000×3/1e6 + 2000×30/1e6 = 0.084
  // 切 other-big：10000×40/1e6 = 0.4
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p1', model: 'big' },
    next: { provider: 'p2', model: 'other-big' },
    estimatedInputTokens: 10000,
    lastUsage: { inputTokens: 10000, cacheReadTokens: 8000 },
    pricing,
  });
  assert.equal(r.keepCurrent, true);
  assert.equal(r.cachedCost, 0.084);
  assert.equal(r.prefillCost, 0.4);
  assert.equal(r.cacheLoss, 0.316);
  assert.match(r.reason, /staying keeps cache cheaper/);
});

test('hitRatio 口径：cacheRead/input，超过 1 截断（不猜负不猜超）', () => {
  const pricing = {
    a: { input: 30, output: 60, cacheRead: 3 },
    b: { input: 40, output: 80, cacheRead: 5 },
  };
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p', model: 'a' },
    next: { provider: 'p', model: 'b' },
    estimatedInputTokens: 1000,
    lastUsage: { inputTokens: 100, cacheReadTokens: 250 }, // 荒谬比例
    pricing,
  });
  assert.equal(r.hitRatio, 1, '截断到 1');
  // hitRatio=1 ⇒ 留档全是 cacheRead 价：1000×3/1e6=0.003 vs 切档 1000×40/1e6=0.04
  assert.equal(r.keepCurrent, true);
  assert.equal(r.cachedCost, 0.003);
});

test('价表裸 model 键也认（两种写法都收）', () => {
  const pricing = {
    'only-bare-key': { input: 10, output: 20, cacheRead: 1 },
  };
  const r = evaluateCacheAwareSwitch({
    current: { provider: 'p', model: 'only-bare-key' },
    next: { provider: 'p', model: 'only-bare-key-2' },
    estimatedInputTokens: 5000,
    lastUsage: { inputTokens: 5000, cacheReadTokens: 5000 },
    pricing,
  });
  // next 没价 ⇒ 放行；但证明 current 用裸键查到了（否则 reason 会说 current）
  assert.match(r.reason, /missing pricing for next/);
});
