// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// P5-B 单测：/v1/models 上游同步（model-sync.js）。
// 纯函数钉形状；IO 层全部注入假 fetch / 假 cache，不碰网络不碰磁盘。

const {
  extractProviderModelIds,
  normalizeUpstreamModels,
  mergeSyncedModels,
  buildModelsResponse,
  syncOneProvider,
  runModelSync,
} = require('../model-sync');

describe('extractProviderModelIds：providers.json 的 models 两种形状都认', () => {
  test('字符串数组（proxy.js 旧假设的形状）', () => {
    expect(extractProviderModelIds({ models: ['m1', 'm2'] })).toEqual(['m1', 'm2']);
  });

  test('对象数组（manager Web UI 真实写的形状，providers.sample.json 即此）', () => {
    expect(extractProviderModelIds({ models: [{ id: 'qwen3.8-flash', name: 'X' }, { id: 'qwen-max' }] }))
      .toEqual(['qwen3.8-flash', 'qwen-max']);
  });

  test('混合 / 空串 / 非对象条目一律过滤；models 缺失返回 []', () => {
    expect(extractProviderModelIds({ models: ['a', { id: 'b' }, { noId: 1 }, '', null, 42] })).toEqual(['a', 'b']);
    expect(extractProviderModelIds({})).toEqual([]);
    expect(extractProviderModelIds(null)).toEqual([]);
  });
});

describe('normalizeUpstreamModels：三种上游形状', () => {
  test('OpenAI 兼容 {data:[{id}]}', () => {
    expect(normalizeUpstreamModels({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }))
      .toEqual([{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]);
  });

  test('Gemini {models:[{name:"models/xxx"}]} → 剥前缀', () => {
    expect(normalizeUpstreamModels({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] }))
      .toEqual([{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]);
  });

  test('Ollama {models:[{name}]}（无前缀原样）', () => {
    expect(normalizeUpstreamModels({ models: [{ name: 'qwen3.8:27b-mlx' }] }))
      .toEqual([{ id: 'qwen3.8:27b-mlx' }]);
  });

  test('去重 + 认不出的结构返回 []（不是「0 个模型」的静默吞掉）', () => {
    expect(normalizeUpstreamModels({ data: [{ id: 'a' }, { id: 'a' }] })).toEqual([{ id: 'a' }]);
    expect(normalizeUpstreamModels({ foo: 1 })).toEqual([]);
    expect(normalizeUpstreamModels(null)).toEqual([]);
  });
});

describe('mergeSyncedModels：add-only', () => {
  test('existing 的 id 永远赢；incoming 只补新 id；added 报告新增', () => {
    const existing = [{ id: 'a', owned_by: 'builtin', created: 111 }];
    const { models, added } = mergeSyncedModels(existing, [
      { id: 'a', owned_by: 'upstream', created: 999 }, // 冲突 → 保留 existing
      { id: 'b', owned_by: 'upstream', created: 999 }, // 新 → 补
    ]);
    expect(models).toEqual([
      { id: 'a', owned_by: 'builtin', created: 111 },
      { id: 'b', owned_by: 'upstream', created: 999 },
    ]);
    expect(added).toEqual(['b']);
  });

  test('existing 非数组 / null 容错', () => {
    expect(mergeSyncedModels(null, [{ id: 'x' }]).models).toEqual([{ id: 'x' }]);
    expect(mergeSyncedModels([{ id: 'x' }], null).added).toEqual([]);
  });
});

describe('buildModelsResponse：dedupe 顺序 builtin > user > synced', () => {
  test('同 id 先到先得；synced 带自己的 created', () => {
    const res = buildModelsResponse({
      builtin: [{ name: 'DeepSeek', availableModels: ['deepseek-v4-flash'] }],
      userProviders: [
        { name: 'P1', models: ['deepseek-v4-flash', 'p1-only'] },        // 前者撞 builtin → 丢
        { name: 'P2', models: [{ id: 'p2-only' }] },                      // 对象形状
      ],
      synced: [
        { id: 'p1-only', owned_by: 'up', created: 555 },                  // 撞 user → 丢
        { id: 'up-new', owned_by: 'up', created: 555 },
      ],
    });
    expect(res.object).toBe('list');
    expect(res.data.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'p1-only', 'p2-only', 'up-new']);
    const upNew = res.data.find((m) => m.id === 'up-new');
    expect(upNew.created).toBe(555);
    expect(upNew.owned_by).toBe('up');
    // builtin 条目的 created 是当前秒（旧行为）
    expect(res.data[0].created).toBe(Math.floor(Date.now() / 1000));
  });

  test('门控关闭等价路径：只传 builtin + userProviders，输出与旧版一致', () => {
    const res = buildModelsResponse({
      builtin: [{ name: 'A', availableModels: ['a1', 'a2'] }],
      userProviders: [{ name: 'B', models: ['b1'] }],
    });
    expect(res.data).toEqual([
      { id: 'a1', object: 'model', created: expect.any(Number), owned_by: 'A' },
      { id: 'a2', object: 'model', created: expect.any(Number), owned_by: 'A' },
      { id: 'b1', object: 'model', created: expect.any(Number), owned_by: 'B' },
    ]);
  });
});

describe('syncOneProvider：单供应商拉取（假 fetch）', () => {
  const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });

  test('成功 → ok:true + models 带 owned_by/created；Authorization 带 Bearer', async () => {
    let seenUrl; let seenHeaders;
    const fetchImpl = async (url, opts) => {
      seenUrl = url; seenHeaders = opts.headers;
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) };
    };
    const r = await syncOneProvider({ id: 'p1', name: 'P1', base_url: 'https://x.example/v1/', api_key: 'sk-secret' }, fetchImpl, 1000);
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([{ id: 'm1', owned_by: 'P1', created: 1 }]);
    expect(seenUrl).toBe('https://x.example/v1/models'); // 尾部斜杠已归一
    expect(seenHeaders.Authorization).toBe('Bearer sk-secret');
    // 🔴 key 不出现在返回值里（返回值会进 status/日志）
    expect(JSON.stringify(r)).not.toMatch(/sk-secret/);
  });

  test('无 api_key（本地 Ollama）→ 不发 Authorization 头', async () => {
    let seenHeaders;
    const fetchImpl = async (_u, opts) => { seenHeaders = opts.headers; return { ok: true, status: 200, json: async () => ({ models: [{ name: 'q' }] }) }; };
    const r = await syncOneProvider({ id: 'oll', name: 'Ollama', base_url: 'http://127.0.0.1:11434/v1' }, fetchImpl);
    expect(r.ok).toBe(true);
    expect(seenHeaders.Authorization).toBeUndefined();
  });

  test('HTTP 非 2xx → ok:false + 错误码，models 空', async () => {
    const r = await syncOneProvider({ id: 'p', name: 'P', base_url: 'https://x/v1', api_key: 'k' }, async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect(r).toMatchObject({ ok: false, error: 'HTTP 401', models: [] });
  });

  test('网络抛错 → ok:false 不向外抛', async () => {
    const r = await syncOneProvider({ id: 'p', name: 'P', base_url: 'https://x/v1' }, async () => { throw new Error('ECONNREFUSED'); });
    expect(r).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
  });

  test('结构认不出 → ok:false 报「无法识别」（区别于 0 模型）', async () => {
    const r = await syncOneProvider({ id: 'p', name: 'P', base_url: 'https://x/v1' }, okFetch({ unexpected: true }));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/无法识别/) });
  });

  test('base_url 缺失 → ok:false', async () => {
    const r = await syncOneProvider({ id: 'p', name: 'P' }, okFetch({ data: [] }));
    expect(r).toMatchObject({ ok: false, error: 'base_url 缺失' });
  });
});

describe('runModelSync：一轮同步（假 cache）', () => {
  const NOW = 1730000000000;
  const provider = (id, body, extra = {}) => ({ id, name: id, base_url: `https://${id}.test/v1`, api_key: 'k', ...extra });

  test('成功合并进既有缓存；add-only；provider status 落盘形状', async () => {
    const cache = { version: 1, models: [{ id: 'old', owned_by: 'builtin', created: 1 }], providers: {} };
    let written = null;
    const fetchImpl = async (url) => {
      if (url.startsWith('https://a.test')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'old' }, { id: 'a-new' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'b-new' }] }) };
    };
    const r = await runModelSync({
      providers: [provider('a', null), provider('b', null)],
      fetchImpl,
      readCache: () => cache,
      writeCache: (c) => { written = c; },
      now: NOW,
    });
    expect(r.added.sort()).toEqual(['a-new', 'b-new']);
    expect(r.total).toBe(3);
    expect(r.ok).toBe(2);
    expect(r.failed).toBe(0);
    expect(written.models.map((m) => m.id).sort()).toEqual(['a-new', 'b-new', 'old']);
    expect(written.providers.a).toMatchObject({ ok: true, count: 2 });
    expect(written.updatedAt).toBe(new Date(NOW).toISOString());
  });

  test('某个供应商失败 → 不影响其他家；既有缓存不删', async () => {
    const cache = { version: 1, models: [{ id: 'keep', owned_by: 'x', created: 1 }], providers: {} };
    let written = null;
    const fetchImpl = async (url) => {
      if (url.startsWith('https://bad.test')) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'good-new' }] }) };
    };
    const r = await runModelSync({
      providers: [provider('bad', null), provider('good', null)],
      fetchImpl,
      readCache: () => cache,
      writeCache: (c) => { written = c; },
      now: NOW,
    });
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(1);
    expect(written.models.map((m) => m.id).sort()).toEqual(['good-new', 'keep']);
    expect(written.providers.bad).toMatchObject({ ok: false, error: 'HTTP 503' });
  });

  test('disabled 供应商被跳过（不拉取）', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'z' }] }) }; };
    await runModelSync({
      providers: [provider('on', null), provider('off', null, { enabled: false })],
      fetchImpl,
      readCache: () => null,
      writeCache: () => {},
      now: NOW,
    });
    expect(calls).toBe(1);
  });

  test('不传 writeCache = dry-run：不写盘但返回合并结果', async () => {
    const r = await runModelSync({
      providers: [provider('a', null)],
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'dry' }] }) }),
      readCache: () => ({ version: 1, models: [], providers: {} }),
      now: NOW,
    });
    expect(r.added).toEqual(['dry']);
    expect(r.total).toBe(1);
  });
});
