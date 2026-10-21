// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * 通用 key 池轮换 · 纯函数 · 门控 PROXY_KEYPOOL 默认关
 *
 * 用途：同账号多 key 摊薄限流（如 DeepSeek K1+K2 同余额池）。429（限流）时
 *       同 provider 换下一把 key 再试（有界），全部 key 都 429 才进 provider-fallback。
 *
 * 设计铁律（同 routing-policy.js）：
 *   · 门控 PROXY_KEYPOOL 默认关 → activeKey 恒 provider.apiKey、不轮换、零行为变更。
 *   · 纯函数 + IO 分离：key 选择只看 (provider, attemptIndex, env)，不碰网络/全局状态。
 *   · 第二把 key 走 env（DEEPSEEK_API_KEY_2，已在 .env、gitignored），**绝不写进任何 git 文件**。
 *   · 主备相同去重，避免「换 key」换到同一把。
 *
 * ⚠️ 别把门控默认改成开：开=429 自动换 key 重试，是行为变更，必须显式 PROXY_KEYPOOL=1 才启用。
 */

const GATE = 'PROXY_KEYPOOL';

/** 门控是否开（显式 PROXY_KEYPOOL=1 才开，默认关）。 */
function gateOpen(env = process.env) {
  return env[GATE] === '1';
}

/**
 * 某 provider 的 key 池（按序）：[主 key, 第二把]。
 *   · 主 = provider.apiKey
 *   · 第二把：provider.apiKey2（显式 per-provider）优先；否则 DeepSeek 域 ⇒ env.DEEPSEEK_API_KEY_2
 *   · 过滤空串 + 去重（主备相同只留一把）
 * 门控关 / provider 无效 ⇒ 返回 []（调用方回落 provider.apiKey，行为不变）。
 */
function keyPoolFor(provider, env = process.env) {
  if (!provider || !gateOpen(env)) return [];
  const primary = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  let secondary = '';
  if (typeof provider.apiKey2 === 'string' && provider.apiKey2.trim()) {
    secondary = provider.apiKey2.trim();
  } else if (/deepseek/i.test(String(provider.name || provider.id || provider.provider_id || ''))) {
    secondary = String(env.DEEPSEEK_API_KEY_2 || '').trim();
  }
  const pool = [primary, secondary].filter(k => k && k.trim());
  return [...new Set(pool)]; // 主备相同去重
}

/** 第 attemptIndex 次尝试该用哪把 key。池空（门控关 / 单 key）⇒ 回落 provider.apiKey（老行为）。 */
function activeKey(provider, attemptIndex, env = process.env) {
  const pool = keyPoolFor(provider, env);
  if (!pool.length) return provider ? provider.apiKey : undefined;
  return pool[Math.min(attemptIndex || 0, pool.length - 1)];
}

/** 当前 attemptIndex 之后还有没有下一把 key（true ⇒ 429 时可换 key 再试，否则进 provider-fallback）。 */
function hasNextKey(provider, attemptIndex, env = process.env) {
  const pool = keyPoolFor(provider, env);
  return pool.length > 1 && (attemptIndex || 0) < pool.length - 1;
}

module.exports = { GATE, gateOpen, keyPoolFor, activeKey, hasNextKey };
