// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

const {
  isRetryableFailure,
  buildFallbackTargets,
  nextFallback,
  MAX_FALLBACK_DEPTH,
} = require('../failover');

describe('failover: isRetryableFailure', () => {
  test('瞬态：网络异常 errored=true → true', () => {
    expect(isRetryableFailure({ errored: true })).toBe(true);
  });
  test('瞬态：5xx → true', () => {
    expect(isRetryableFailure({ status: 500 })).toBe(true);
    expect(isRetryableFailure({ status: 502 })).toBe(true);
    expect(isRetryableFailure({ status: 503 })).toBe(true);
  });
  test('瞬态：429/408 → true（限流/超时）', () => {
    expect(isRetryableFailure({ status: 429 })).toBe(true);
    expect(isRetryableFailure({ status: 408 })).toBe(true);
  });
  test('确定性 4xx → false（不切，避免无意义重试）', () => {
    expect(isRetryableFailure({ status: 400 })).toBe(false);
    expect(isRetryableFailure({ status: 401 })).toBe(false);
    expect(isRetryableFailure({ status: 403 })).toBe(false);
    expect(isRetryableFailure({ status: 404 })).toBe(false);
  });
  test('缺 status 且非 errored → false', () => {
    expect(isRetryableFailure({})).toBe(false);
    expect(isRetryableFailure({ status: undefined })).toBe(false);
  });
});

describe('failover: buildFallbackTargets', () => {
  const all = [
    { provider_id: 'workbuddy', models: ['wb-deepseek-v3.2', 'wb-kimi-k2'] },
    { provider_id: 'ollama', models: ['qwen3.8:27b-mlx'] },
    { provider_id: 'kimi', models: ['kimi-k2.6'] },
  ];
  test('undefined/空 → []', () => {
    expect(buildFallbackTargets(undefined, all)).toEqual([]);
    expect(buildFallbackTargets([], all)).toEqual([]);
  });
  test('model 名精确命中 → 直接保留', () => {
    expect(buildFallbackTargets('wb-deepseek-v3.2', all)).toEqual(['wb-deepseek-v3.2']);
  });
  test('model 名数组 → 逐项', () => {
    expect(buildFallbackTargets(['wb-deepseek-v3.2', 'kimi-k2.6'], all)).toEqual(['wb-deepseek-v3.2', 'kimi-k2.6']);
  });
  test('provider_id 子串 → 取该 provider 首个 model', () => {
    expect(buildFallbackTargets('workbuddy', all)).toEqual(['wb-deepseek-v3.2']);
    expect(buildFallbackTargets('ollama', all)).toEqual(['qwen3.8:27b-mlx']);
  });
  test('裸字符串（非 model 非 provider_id）→ 保留，交由 findProvider', () => {
    expect(buildFallbackTargets('some-future-model', all)).toEqual(['some-future-model']);
  });
  test('混合写法（provider_id + model 名）', () => {
    expect(buildFallbackTargets(['workbuddy', 'kimi-k2.6'], all)).toEqual(['wb-deepseek-v3.2', 'kimi-k2.6']);
  });
});

describe('failover: nextFallback', () => {
  const all = [
    { provider_id: 'ollama', models: ['qwen3.8:27b-mlx'], fallback: ['wb-deepseek-v3.2'] },
    { provider_id: 'workbuddy', models: ['wb-deepseek-v3.2'], fallback: [] },
  ];
  const ollama = all[0];
  const wb = all[1];
  test('首次：返回未访问的 fallback', () => {
    expect(nextFallback('qwen3.8:27b-mlx', new Set(['qwen3.8:27b-mlx']), ollama, all)).toBe('wb-deepseek-v3.2');
  });
  test('已访问 → 返回 null（防循环）', () => {
    expect(nextFallback('qwen3.8:27b-mlx', new Set(['qwen3.8:27b-mlx', 'wb-deepseek-v3.2']), ollama, all)).toBeNull();
  });
  test('无 fallback → null', () => {
    expect(nextFallback('wb-deepseek-v3.2', new Set(['wb-deepseek-v3.2']), wb, all)).toBeNull();
  });
  test('MAX_FALLBACK_DEPTH 常量存在且为 5', () => {
    expect(MAX_FALLBACK_DEPTH).toBe(5);
  });
});
