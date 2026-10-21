// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * key-pool 纯函数单测（门控 PROXY_KEYPOOL 默认关）。
 * 只测 (provider, attemptIndex, env) 的纯选择逻辑，不碰网络/全局状态，
 * 不依赖 jest 的 env 快照（每个用例自己传 fake env）。
 */
const { GATE, gateOpen, keyPoolFor, activeKey, hasNextKey } = require('../key-pool');

const deepseek = { name: 'DeepSeek', apiKey: 'K1' };
const kimi = { name: 'Kimi', apiKey: 'MK' };

describe('P7 key-pool: gate', () => {
  test('门控默认关（无 env）', () => {
    expect(gateOpen({})).toBe(false);
    expect(gateOpen(process.env)).toBe(false); // 默认没有 PROXY_KEYPOOL
  });
  test('显式 PROXY_KEYPOOL=1 才开', () => {
    expect(gateOpen({ [GATE]: '1' })).toBe(true);
    expect(gateOpen({ [GATE]: 'true' })).toBe(false); // 只认 '1'，防止误开
  });
});

describe('P7 key-pool: keyPoolFor', () => {
  test('门控关 → 空池（调用方回落 provider.apiKey）', () => {
    expect(keyPoolFor(deepseek, {})).toEqual([]);
  });
  test('门控开 + DeepSeek + DEEPSEEK_API_KEY_2 在 env → [K1, K2]', () => {
    const pool = keyPoolFor(deepseek, { [GATE]: '1', DEEPSEEK_API_KEY_2: 'K2' });
    expect(pool).toEqual(['K1', 'K2']);
  });
  test('门控开 + 第二把空 → 只有主 key', () => {
    const pool = keyPoolFor(deepseek, { [GATE]: '1' });
    expect(pool).toEqual(['K1']);
  });
  test('主备相同 → 去重（避免"换 key"换到同一把）', () => {
    const pool = keyPoolFor(deepseek, { [GATE]: '1', DEEPSEEK_API_KEY_2: 'K1' });
    expect(pool).toEqual(['K1']);
  });
  test('非 DeepSeek provider 不读 DEEPSEEK_API_KEY_2（避免拿别家 key 试别家模型）', () => {
    const pool = keyPoolFor(kimi, { [GATE]: '1', DEEPSEEK_API_KEY_2: 'K2' });
    expect(pool).toEqual(['MK']);
  });
  test('显式 provider.apiKey2 优先于 env（per-provider 第二把）', () => {
    const p = { name: 'Kimi', apiKey: 'MK', apiKey2: 'MK2' };
    const pool = keyPoolFor(p, { [GATE]: '1', DEEPSEEK_API_KEY_2: 'K2' });
    expect(pool).toEqual(['MK', 'MK2']);
  });
});

describe('P7 key-pool: activeKey', () => {
  test('门控关 → 恒 provider.apiKey（零行为变更的关键保证）', () => {
    expect(activeKey(deepseek, 0, {})).toBe('K1');
    expect(activeKey(deepseek, 5, {})).toBe('K1'); // 再大的 attempt 也不越界/不换
  });
  test('门控开 + 双 key → 按序取，越界钳制到最后一把', () => {
    const env = { [GATE]: '1', DEEPSEEK_API_KEY_2: 'K2' };
    expect(activeKey(deepseek, 0, env)).toBe('K1');
    expect(activeKey(deepseek, 1, env)).toBe('K2');
    expect(activeKey(deepseek, 99, env)).toBe('K2'); // 钳制
  });
  test('单 key 池 → 始终那把', () => {
    const env = { [GATE]: '1' };
    expect(activeKey(deepseek, 0, env)).toBe('K1');
    expect(activeKey(deepseek, 1, env)).toBe('K1');
  });
});

describe('P7 key-pool: hasNextKey', () => {
  test('门控关 → 永远 false（不进 key 轮换，走 provider-fallback）', () => {
    expect(hasNextKey(deepseek, 0, {})).toBe(false);
  });
  test('双 key：第 0 把有下一把、最后一把没有（有界，防无限重试）', () => {
    const env = { [GATE]: '1', DEEPSEEK_API_KEY_2: 'K2' };
    expect(hasNextKey(deepseek, 0, env)).toBe(true);
    expect(hasNextKey(deepseek, 1, env)).toBe(false);
  });
  test('单 key → 没有下一把', () => {
    expect(hasNextKey(deepseek, 0, { [GATE]: '1' })).toBe(false);
  });
});
