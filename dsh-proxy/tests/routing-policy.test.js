// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * dsh-proxy/routing-policy.js 单元测试（node:test，零第三方依赖）。
 *
 * 为什么单独测：routing-policy 是「model-id 级路由」的判定内核，proxy/direct/deny
 * 三条转发路径的分岔全在这里，且它是**纯函数 + IO 分离**设计（读文件/env 由调用方
 * 注入），测试不碰磁盘不碰网络。
 *
 * 覆盖（对照源码注释里的纪律）：
 *   1. matchModelPattern：精确 / 大小写不敏感 / 后缀 glob / 中间 glob / 裸 * /
 *      正则元字符按字面 / 空值不抛。
 *   2. parseRoutingPolicy：null→无策略；default 与 rule.action 缺省 proxy；
 *      四种畸形输入全部 ok:false（fail-safe 的入口）。
 *   3. resolveRoute：空模型 deny；无策略恒 proxy（门控关 = 今天的行为逐字不变）；
 *      第一条命中即停；都不中 → default。
 *   4. resolveDirectTarget：无记录 / 缺 upstream / env 没设 → 各自可操作的报错；
 *      无 apiKeyEnv → ok 且 apiKey=null（不猜空 key）。
 *   5. buildDirectUpstreamUrl：去掉 reqPath 的 /v1 前缀防 /v1/v1，补前导 /。
 *
 * 跑法：node --test tests/   （或 npm test）
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIONS,
  matchModelPattern,
  parseRoutingPolicy,
  resolveRoute,
  resolveDirectTarget,
  buildDirectUpstreamUrl,
} = require('../routing-policy');

test('ACTIONS 恰好是 proxy/direct/deny 三个动作', () => {
  assert.deepEqual(ACTIONS, ['proxy', 'direct', 'deny']);
});

test('matchModelPattern: 精确匹配，大小写不敏感', () => {
  assert.equal(matchModelPattern('deepseek-v4-flash', 'deepseek-v4-flash'), true);
  assert.equal(matchModelPattern('DeepSeek-V4-Flash', 'deepseek-v4-flash'), true);
  assert.equal(matchModelPattern('deepseek-v4-flash', 'DEEPSEEK-V4-FLASH'), true);
  assert.equal(matchModelPattern('deepseek-v4-flash', 'deepseek-v4-pro'), false);
});

test('matchModelPattern: 后缀 glob 命中家族、不咬别家', () => {
  assert.equal(matchModelPattern('deepseek-v4-flash', 'deepseek-*'), true);
  assert.equal(matchModelPattern('deepseek-chat', 'deepseek-*'), true);
  assert.equal(matchModelPattern('kimi-k2.6', 'deepseek-*'), false);
});

test('matchModelPattern: 中间 glob（*-flash）', () => {
  assert.equal(matchModelPattern('agnes-3.0-flash', '*-flash'), true);
  assert.equal(matchModelPattern('deepseek-v4-flash', '*-flash'), true);
  assert.equal(matchModelPattern('agnes-3.0-pro', '*-flash'), false);
});

test('matchModelPattern: 裸 * = 全部', () => {
  assert.equal(matchModelPattern('anything-at-all', '*'), true);
  assert.equal(matchModelPattern('', '*'), false, '空 id 不匹配，哪怕模式是 *');
});

test('matchModelPattern: 模式里的正则元字符按字面量处理', () => {
  // kimi-k2.6 的 . 是字面点，不能匹配 kimi-k2X6；qwen3.8:27b 的 : 同理
  assert.equal(matchModelPattern('kimi-k2.6', 'kimi-k2.6'), true);
  assert.equal(matchModelPattern('kimi-k2X6', 'kimi-k2.6'), false);
  assert.equal(matchModelPattern('qwen3.8:27b-mlx', 'qwen3.8:*'), true);
  assert.equal(matchModelPattern('qwen3.8:27b-mlx', 'qwen3.8:27b-ml*'), true);
  assert.equal(matchModelPattern('qwen3.8:27b-mlx', 'qwen3.8:27b-ml?'), false, '不支持 ? 通配符');
});

test('matchModelPattern: 空值/非字符串不抛，恒 false', () => {
  assert.equal(matchModelPattern(null, 'x'), false);
  assert.equal(matchModelPattern('x', undefined), false);
  assert.equal(matchModelPattern(undefined, undefined), false);
  assert.equal(matchModelPattern('   ', '*'), false, 'trim 后为空不匹配');
});

test('parseRoutingPolicy: null/undefined → ok + policy:null（= 无策略）', () => {
  assert.deepEqual(parseRoutingPolicy(null), { ok: true, policy: null });
  assert.deepEqual(parseRoutingPolicy(undefined), { ok: true, policy: null });
});

test('parseRoutingPolicy: default 缺省 proxy、rule.action 缺省 proxy', () => {
  const r = parseRoutingPolicy({ rules: [{ match: 'a-*' }, { match: 'b', action: 'deny' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.policy, {
    default: 'proxy',
    rules: [{ match: 'a-*', action: 'proxy' }, { match: 'b', action: 'deny' }],
  });
});

test('parseRoutingPolicy: match 两侧空白被 trim', () => {
  const r = parseRoutingPolicy({ default: 'direct', rules: [{ match: '  agnes-*  ', action: 'proxy' }] });
  assert.equal(r.ok, true);
  assert.equal(r.policy.rules[0].match, 'agnes-*');
});

test('parseRoutingPolicy: 畸形输入全部 ok:false（fail-safe 到无策略）', () => {
  const cases = [
    ['非对象', 'nope'],
    ['数组', []],
    ['default 非法', { default: 'forward' }],
    ['rules 非数组', { rules: {} }],
    ['rule 非对象', { rules: ['x'] }],
    ['rule.match 空串', { rules: [{ match: '   ' }] }],
    ['rule.match 非字符串', { rules: [{ match: 42 }] }],
    ['rule.action 非法', { rules: [{ match: 'a', action: 'drop' }] }],
  ];
  for (const [name, raw] of cases) {
    const r = parseRoutingPolicy(raw);
    assert.equal(r.ok, false, `${name} 应该 ok:false`);
    assert.equal(r.policy, undefined, `${name} 不该返回 policy`);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, `${name} 应带可读 error`);
  }
});

test('resolveRoute: 空 model id → deny（防御性分支，不误放）', () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    const r = resolveRoute(bad, { default: 'proxy', rules: [] });
    assert.equal(r.action, 'deny');
    assert.equal(r.reason, 'empty-model-id');
  }
});

test('resolveRoute: 无策略（门控关/文件缺失/畸形 fail-safe）→ 恒 proxy', () => {
  for (const policy of [null, undefined]) {
    const r = resolveRoute('deepseek-v4-flash', policy);
    assert.deepEqual(r, { action: 'proxy', matched: false, pattern: null, reason: 'no-policy' });
  }
});

test('resolveRoute: 第一条命中的规则即停（顺序即优先级）', () => {
  const { policy } = parseRoutingPolicy({
    default: 'direct',
    rules: [
      { match: 'deepseek-v4-flash', action: 'proxy' },
      { match: 'agnes-*', action: 'proxy' },
      { match: '*', action: 'direct' },
    ],
  });
  const a = resolveRoute('deepseek-v4-flash', policy);
  assert.equal(a.action, 'proxy');
  assert.equal(a.matched, true);
  assert.equal(a.pattern, 'deepseek-v4-flash');
  assert.equal(a.reason, 'rule:deepseek-v4-flash');

  const b = resolveRoute('agnes-3.0-flash', policy);
  assert.equal(b.action, 'proxy');
  assert.equal(b.pattern, 'agnes-*');

  const c = resolveRoute('kimi-k2.6', policy);
  assert.equal(c.action, 'direct');
  assert.equal(c.matched, true);
  assert.equal(c.reason, 'rule:*');
});

test('resolveRoute: 白名单写法 = default 非 proxy + 只给要代理的写 proxy', () => {
  const { policy } = parseRoutingPolicy({
    default: 'deny',
    rules: [{ match: 'deepseek-*', action: 'proxy' }],
  });
  assert.equal(resolveRoute('deepseek-chat', policy).action, 'proxy');
  const d = resolveRoute('kimi-k2.6', policy);
  assert.equal(d.action, 'deny');
  assert.equal(d.matched, false);
  assert.equal(d.reason, 'default');
});

test('resolveRoute: 都不中 → 落到 default，matched=false', () => {
  const { policy } = parseRoutingPolicy({ default: 'direct', rules: [{ match: 'a-*', action: 'proxy' }] });
  const r = resolveRoute('b-model', policy);
  assert.deepEqual(r, { action: 'direct', matched: false, pattern: null, reason: 'default' });
});

test('resolveDirectTarget: 三种失败各自返回可操作的 reason，不猜不回落', () => {
  const noRec = resolveDirectTarget('dsh', { records: {}, env: {} });
  assert.equal(noRec.ok, false);
  assert.equal(noRec.reason, 'no-takeover-record');
  assert.ok(noRec.detail.includes('dsh'));

  const noUp = resolveDirectTarget('dsh', { records: { dsh: {} }, env: {} });
  assert.equal(noUp.ok, false);
  assert.equal(noUp.reason, 'takeover-missing-upstream');

  const noEnv = resolveDirectTarget('dsh', {
    records: { dsh: { upstream: 'https://api.example.com/v1', apiKeyEnv: 'DSH_KEY' } },
    env: {},
  });
  assert.equal(noEnv.ok, false);
  assert.equal(noEnv.reason, 'api-key-env-not-set');
  assert.equal(noEnv.apiKeyEnv, 'DSH_KEY');
  assert.ok(noEnv.detail.includes('DSH_KEY'));
});

test('resolveDirectTarget: 无 apiKeyEnv = 上游免鉴权，ok 且 apiKey=null', () => {
  const r = resolveDirectTarget('ollama', {
    records: { ollama: { upstream: 'http://127.0.0.1:11434/v1' } },
    env: {},
  });
  assert.deepEqual(r, { ok: true, upstream: 'http://127.0.0.1:11434/v1', apiKey: null, apiKeyEnv: null });
});

test('resolveDirectTarget: env 命中 → ok + apiKey；upstream 尾部斜杠被剥掉', () => {
  const r = resolveDirectTarget('dsh', {
    records: { dsh: { upstream: 'https://api.example.com/v1///', apiKeyEnv: 'DSH_KEY' } },
    env: { DSH_KEY: 'sk-test-123' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.upstream, 'https://api.example.com/v1');
  assert.equal(r.apiKey, 'sk-test-123');
  assert.equal(r.apiKeyEnv, 'DSH_KEY');
});

test('buildDirectUpstreamUrl: 去 /v1 前缀防 /v1/v1，补前导 /', () => {
  assert.equal(
    buildDirectUpstreamUrl('https://api.example.com/v1', '/v1/chat/completions'),
    'https://api.example.com/v1/chat/completions'
  );
  assert.equal(
    buildDirectUpstreamUrl('https://api.example.com/v1/', '/v1/messages'),
    'https://api.example.com/v1/messages'
  );
  // reqPath 不以 /v1 开头时原样拼（防呆）
  assert.equal(
    buildDirectUpstreamUrl('https://api.example.com/v1', '/responses'),
    'https://api.example.com/v1/responses'
  );
  // 空前缀 / 空路径都不炸
  assert.equal(buildDirectUpstreamUrl('', ''), '/');
  assert.equal(buildDirectUpstreamUrl('http://x/v1', ''), 'http://x/v1/');
});
