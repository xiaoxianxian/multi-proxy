// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== 模型目录上游同步（codex-proxy/model-sync.js，P5 前半）====================
// 目的：/v1/models 从「硬编码 builtin + providers.json」升级成**真上游同步**——
// 用供应商自己的 key 打它的 GET /v1/models，把真实在售模型并进目录（抄 new-api 的
// adaptor.GetModelList() 思路）。上游新上模型不用改代码就会出现。
//
// 纪律（与全站同源）：
//   · **门控默认关**：PROXY_MODEL_SYNC 不设 ⇒ 本模块零调用，/v1/models 行为逐字不变。
//   · **add-only**：同步只**新增** id，永不删除；上游临时抽风 → 目录保持不变（陈旧好过消失）。
//   · **失败不影响端点**：任何供应商拉取失败只记 status，/v1/models 照常返回静态部分。
//   · **绝不把 key 写进缓存**：缓存只存模型 id + 归属 + 状态，api_key 一律不落盘。
//   · **纯函数/IO 分离**：parse/merge/response 是纯函数（可单测钉死）；fetch 与文件
//     读写从参数注入，测试不碰网络不碰磁盘。
//
// ⚠️ 格式覆盖范围（刻意收敛）：后台同步只打 **OpenAI 兼容**的 GET {base_url}/models
//    （Bearer 鉴权）。这覆盖 DeepSeek / Kimi / Agnes / DashScope compatible-mode /
//    Ollama(openai 兼容端点)。Anthropic（/v1/messages/models）与 Gemini
//    （?key=）的差异格式不走后台同步 —— manager 的 /api/fetch-models 已支持交互式
//    拉取，那里加格式分支就够了，后台同步不重复造。

// providers.json 的 models 字段实际存在两种形状：
//   · manager Web UI 写的对象数组 [{id, name, pricing…}]（providers.sample.json 即此形状）
//   · proxy.js 旧代码假设的字符串数组 ['m1','m2']
// 两种都认（proxy.js:332 旧代码只认字符串，遇到对象形状会把对象当 id 塞进响应 —— 已修）。
function extractProviderModelIds(provider) {
  if (!provider || !Array.isArray(provider.models)) return [];
  const out = [];
  for (const m of provider.models) {
    if (typeof m === 'string' && m.trim()) out.push(m.trim());
    else if (m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim()) out.push(m.id.trim());
  }
  return out;
}

// 上游原始响应 → [{id, name?}]。格式判定只看结构不猜域名。
// 返回 [] = 认不出（调用方记 error，不当成「0 个模型」静默吞掉）。
function normalizeUpstreamModels(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  const seen = new Set();
  const push = (id, name) => {
    if (typeof id !== 'string' || !id.trim()) return;
    const clean = id.trim();
    if (seen.has(clean)) return;
    seen.add(clean);
    out.push(name ? { id: clean, name } : { id: clean });
  };
  // OpenAI 兼容：{data:[{id}]}
  if (Array.isArray(raw.data)) {
    for (const m of raw.data) {
      if (m && typeof m === 'object') push(m.id, m.name || m.display_name);
      else if (typeof m === 'string') push(m);
    }
    return out;
  }
  // Anthropic：{data:[{id, display_name}]} 与 OpenAI 同形，上面已覆盖
  // Gemini：{models:[{name:'models/xxx', displayName}]}
  if (Array.isArray(raw.models)) {
    for (const m of raw.models) {
      if (m && typeof m === 'object') {
        push(typeof m.name === 'string' ? m.name.replace(/^models\//, '') : m.id, m.displayName || m.display_name);
      } else if (typeof m === 'string') push(m);
    }
    return out;
  }
  // Ollama：{models:[{name}]} 与 Gemini 同形（name 无前缀），上面已覆盖
  return out;
}

// add-only 合并：existing 里的 id 永远赢；incoming 只补新 id。
// 返回 {models, added}（added = 新增的 id 数组，供日志/status 展示）。
function mergeSyncedModels(existing, incoming) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  const have = new Set(base.map((m) => (m && m.id) || m));
  const added = [];
  for (const m of Array.isArray(incoming) ? incoming : []) {
    const id = (m && m.id) || m;
    if (!id || have.has(id)) continue;
    have.add(id);
    base.push(m && typeof m === 'object' ? { ...m } : { id });
    added.push(id);
  }
  return { models: base, added };
}

// /v1/models 响应体（OpenAI 形状）。dedupe 顺序：builtin → user providers → synced，
// 先到先得（builtin 永远在，保证门控关闭时响应与旧版逐字一致）。
function buildModelsResponse({ builtin = [], userProviders = [], synced = [] } = {}) {
  const data = [];
  const seen = new Set();
  const add = (id, ownedBy, created) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    data.push({ id, object: 'model', created: created || Math.floor(Date.now() / 1000), owned_by: ownedBy });
  };

  for (const p of builtin) {
    for (const name of (p && p.availableModels) || []) add(name, p.name);
  }
  for (const p of userProviders) {
    for (const name of extractProviderModelIds(p)) add(name, p.name);
  }
  for (const m of synced) {
    if (m && typeof m === 'object') add(m.id, m.owned_by, m.created);
    else add(m, 'synced');
  }
  return { object: 'list', data };
}

// ── IO 层（参数注入，测试用假 fetch / 假 fs）──

// 拉一个供应商的模型列表。永不抛。
// fetchImpl(url, opts) 由调用方给（生产 = 带 8s 超时的 fetch 包装；测试 = 假实现）。
async function syncOneProvider(provider, fetchImpl, now = Date.now()) {
  const id = provider && (provider.id || provider.name);
  const baseUrl = provider && typeof provider.base_url === 'string' ? provider.base_url.replace(/\/+$/, '') : '';
  if (!baseUrl) return { id, ok: false, error: 'base_url 缺失', models: [] };

  const headers = { Accept: 'application/json' };
  if (provider.api_key) headers.Authorization = `Bearer ${provider.api_key}`;

  let raw;
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { method: 'GET', headers });
    // res.ok（真 fetch）优先；没有就用 status 判 2xx。测试假实现可以只给一个。
    const ok = res && typeof res.ok === 'boolean'
      ? res.ok
      : !!(res && typeof res.status === 'number' && res.status >= 200 && res.status < 300);
    if (!ok) {
      return { id, ok: false, error: `HTTP ${res ? res.status : '无响应'}`, models: [] };
    }
    raw = typeof res.json === 'function' ? await res.json() : res;
  } catch (e) {
    return { id, ok: false, error: (e && e.message) || 'fetch 失败', models: [] };
  }

  const models = normalizeUpstreamModels(raw);
  if (models.length === 0) {
    // 认不出结构 ≠ 0 个模型：报出来，别静默当成「这供应商没模型」。
    return { id, ok: false, error: '响应结构无法识别（非 OpenAI/Gemini/Ollama 形状）', models: [] };
  }
  return {
    id,
    ok: true,
    error: null,
    fetchedAt: new Date(now).toISOString(),
    models: models.map((m) => ({ id: m.id, owned_by: provider.name || id, created: Math.floor(now / 1000) })),
  };
}

// 跑一轮全量同步：并发拉取（Promise.all，单个失败不拖垮整体）→ add-only 合并 → 原子落盘。
// readCache()/writeCache(obj) 注入；不传 writeCache = 只读演练（dry-run）。
async function runModelSync({ providers = [], fetchImpl, readCache, writeCache, now = Date.now() } = {}) {
  const enabled = (providers || []).filter((p) => p && p.enabled !== false && p.base_url);
  const results = await Promise.all(enabled.map((p) => syncOneProvider(p, fetchImpl, now)));

  const cache = (typeof readCache === 'function' ? readCache() : null) || { version: 1, models: [], providers: {} };
  let models = Array.isArray(cache.models) ? cache.models : [];
  const added = [];
  const providerStatus = {};

  for (const r of results) {
    providerStatus[r.id] = {
      ok: r.ok,
      fetchedAt: r.fetchedAt || null,
      count: r.ok ? r.models.length : 0,
      error: r.ok ? null : r.error,
    };
    if (r.ok) {
      const merged = mergeSyncedModels(models, r.models);
      models = merged.models;
      added.push(...merged.added);
    }
  }

  const next = {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    models,
    providers: providerStatus,
  };
  if (typeof writeCache === 'function') writeCache(next);

  return {
    added,
    total: models.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    providers: providerStatus,
  };
}

module.exports = {
  extractProviderModelIds,
  normalizeUpstreamModels,
  mergeSyncedModels,
  buildModelsResponse,
  syncOneProvider,
  runModelSync,
};
