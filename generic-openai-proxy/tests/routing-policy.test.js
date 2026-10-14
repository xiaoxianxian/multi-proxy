// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

const {
  matchModelPattern,
  parseRoutingPolicy,
  resolveRoute,
  resolveDirectTarget,
  buildDirectUpstreamUrl,
} = require('../routing-policy');

describe('P6 routing-policy: matchModelPattern', () => {
  test('精确匹配，大小写不敏感', () => {
    expect(matchModelPattern('deepseek-v4-flash', 'deepseek-v4-flash')).toBe(true);
    expect(matchModelPattern('DeepSeek-V4-Flash', 'deepseek-v4-flash')).toBe(true);
    expect(matchModelPattern('deepseek-v4-flash', 'deepseek-v4-pro')).toBe(false);
  });

  test('后缀 glob：deepseek-* 命中家族、不咬别家', () => {
    expect(matchModelPattern('deepseek-v4-flash', 'deepseek-*')).toBe(true);
    expect(matchModelPattern('deepseek-chat', 'deepseek-*')).toBe(true);
    expect(matchModelPattern('kimi-k2.6', 'deepseek-*')).toBe(false);
  });

  test('中间 glob：*-flash', () => {
    expect(matchModelPattern('agnes-3.0-flash', '*-flash')).toBe(true);
    expect(matchModelPattern('deepseek-v4-flash', '*-flash')).toBe(true);
    expect(matchModelPattern('agnes-3.0-pro', '*-flash')).toBe(false);
  });

  test('裸 * = 全部', () => {
    expect(matchModelPattern('anything-at-all', '*')).toBe(true);
  });

  test('通配符不跨字符类、正则元字符按字面（模式里有 . + 的模型 id）', () => {
    // kimi-k2.6 里的 . 是字面点，不能被当成「任意字符」匹配 kimi-k2X6
    expect(matchModelPattern('kimi-k2.6', 'kimi-k2.6')).toBe(true);
    expect(matchModelPattern('kimi-k2X6', 'kimi-k2.6')).toBe(false);
    expect(matchModelPattern('qwen3.8:27b-mlx', 'qwen3.8:*')).toBe(true);
  });

  test('空值不匹配（不抛）', () => {
    expect(matchModelPattern('', '*')).toBe(false);
    expect(matchModelPattern(null, 'x')).toBe(false);
    expect(matchModelPattern('x', undefined)).toBe(false);
  });
});

describe('P6 routing-policy: parseRoutingPolicy', () => {
  test('null/undefined → ok + policy:null（无策略）', () => {
    expect(parseRoutingPolicy(null)).toEqual({ ok: true, policy: null });
    expect(parseRoutingPolicy(undefined)).toEqual({ ok: true, policy: null });
  });

  test('合法策略：default 缺省 proxy、rule.action 缺省 proxy', () => {
    const r = parseRoutingPolicy({ rules: [{ match: 'a-*' }, { match: 'b', action: 'deny' }] });
    expect(r.ok).toBe(true);
    expect(r.policy).toEqual({
      default: 'proxy',
      rules: [{ match: 'a-*', action: 'proxy' }, { match: 'b', action: 'deny' }],
    });
  });

  test('default 显式 direct', () => {
    const r = parseRoutingPolicy({ default: 'direct', rules: [{ match: 'x', action: 'proxy' }] });
    expect(r.policy.default).toBe('direct');
  });

  test('畸形一律 ok:false + 说清哪儿不对', () => {
    expect(parseRoutingPolicy([]).ok).toBe(false);                       // 数组不是对象
    expect(parseRoutingPolicy('x').ok).toBe(false);                     // 字符串
    expect(parseRoutingPolicy({ default: 'nope' }).ok).toBe(false);     // 坏 default
    expect(parseRoutingPolicy({ rules: {} }).ok).toBe(false);           // rules 非数组
    expect(parseRoutingPolicy({ rules: [{ match: '' }] }).ok).toBe(false);   // 空 match
    expect(parseRoutingPolicy({ rules: [{ match: 'a', action: 'x' }] }).ok).toBe(false); // 坏 action
    expect(parseRoutingPolicy({ rules: ['a'] }).ok).toBe(false);        // rule 非对象
    const bad = parseRoutingPolicy({ rules: [{ match: 'a', action: 'x' }] });
    expect(bad.error).toMatch(/rules\[0\]\.action/);
  });
});

describe('P6 routing-policy: resolveRoute', () => {
  const policy = parseRoutingPolicy({
    default: 'direct',
    rules: [
      { match: 'deepseek-v4-flash', action: 'proxy' },
      { match: 'agnes-*', action: 'proxy' },
      { match: 'kimi-*', action: 'deny' },
    ],
  }).policy;

  test('无策略（null）→ 恒 proxy，matched:false', () => {
    expect(resolveRoute('anything', null)).toEqual({
      action: 'proxy', matched: false, pattern: null, reason: 'no-policy',
    });
  });

  test('第一条命中即停（顺序即优先级）', () => {
    // deepseek-v4-flash 同时命中 rules[0] 与「无后续」——若顺序反了会被 * 之类吃掉
    const r = resolveRoute('deepseek-v4-flash', policy);
    expect(r).toEqual({ action: 'proxy', matched: true, pattern: 'deepseek-v4-flash', reason: 'rule:deepseek-v4-flash' });
  });

  test('glob 规则命中', () => {
    expect(resolveRoute('agnes-3.0-flash', policy)).toMatchObject({ action: 'proxy', matched: true, pattern: 'agnes-*' });
  });

  test('deny 规则', () => {
    expect(resolveRoute('kimi-k2.6', policy)).toMatchObject({ action: 'deny', matched: true });
  });

  test('无命中 → default', () => {
    expect(resolveRoute('gpt-5', policy)).toEqual({
      action: 'direct', matched: false, pattern: null, reason: 'default',
    });
  });

  test('空 model id → deny（防御：绝不把空模型当合法请求放过去）', () => {
    expect(resolveRoute('', policy).action).toBe('deny');
    expect(resolveRoute('', policy).reason).toBe('empty-model-id');
    expect(resolveRoute('  ', policy).action).toBe('deny');
    expect(resolveRoute(undefined, policy).action).toBe('deny');
  });

  test('空 model id 即便无策略也 deny（不能借 no-policy 放行）', () => {
    expect(resolveRoute('', null).action).toBe('deny');
  });
});

describe('P6 routing-policy: resolveDirectTarget', () => {
  const records = {
    dsh: { upstream: 'https://apihub.agnes-ai.cn/v1/', apiKeyEnv: 'AGNES_API_KEY' },
    ollama: { upstream: 'http://127.0.0.1:11434/v1' },  // 无 apiKeyEnv = 不需要鉴权
  };

  test('正常：upstream 去尾斜杠 + key 从注入 env 取', () => {
    const r = resolveDirectTarget('dsh', { records, env: { AGNES_API_KEY: 'sk-real' } });
    expect(r).toEqual({ ok: true, upstream: 'https://apihub.agnes-ai.cn/v1', apiKey: 'sk-real', apiKeyEnv: 'AGNES_API_KEY' });
  });

  test('无 takeover 记录 → ok:false + 说清缺什么', () => {
    const r = resolveDirectTarget('cursor', { records, env: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-takeover-record');
    expect(r.detail).toMatch(/cursor/);
  });

  test('记录缺 upstream → ok:false', () => {
    const r = resolveDirectTarget('x', { records: { x: { apiKeyEnv: 'K' } }, env: { K: 'v' } });
    expect(r).toMatchObject({ ok: false, reason: 'takeover-missing-upstream' });
  });

  test('apiKeyEnv 指向的 env 没设 → ok:false（不猜空 key 发出去）', () => {
    const r = resolveDirectTarget('dsh', { records, env: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('api-key-env-not-set');
    expect(r.apiKeyEnv).toBe('AGNES_API_KEY');
  });

  test('无 apiKeyEnv（本地 Ollama）→ ok + apiKey:null', () => {
    const r = resolveDirectTarget('ollama', { records, env: {} });
    expect(r).toEqual({ ok: true, upstream: 'http://127.0.0.1:11434/v1', apiKey: null, apiKeyEnv: null });
  });
});

describe('P6 routing-policy: buildDirectUpstreamUrl', () => {
  test('/v1 前缀不重复拼', () => {
    expect(buildDirectUpstreamUrl('https://apihub.agnes-ai.cn/v1', '/v1/chat/completions'))
      .toBe('https://apihub.agnes-ai.cn/v1/chat/completions');
    expect(buildDirectUpstreamUrl('https://apihub.agnes-ai.cn/v1/', '/v1/responses'))
      .toBe('https://apihub.agnes-ai.cn/v1/responses');
    expect(buildDirectUpstreamUrl('https://apihub.agnes-ai.cn/v1', '/v1/messages'))
      .toBe('https://apihub.agnes-ai.cn/v1/messages');
  });

  test('路径缺 /v1 前缀也不炸', () => {
    expect(buildDirectUpstreamUrl('https://x.com/v1', 'chat/completions'))
      .toBe('https://x.com/v1/chat/completions');
  });
});
