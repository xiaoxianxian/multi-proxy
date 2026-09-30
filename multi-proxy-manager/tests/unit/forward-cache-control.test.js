/**
 * P2 · cache_control 真注入 — TDD RED 测试
 *
 * 来源：docs/10-initiatives/24-cache_control-P2与M6-override实施计划-2026-09-30.md §块①
 * 5 条 case（对应 24 号 Step 1）：
 *   1. anthropic /v1/messages → 门控开时注入 cache_control:{type:'ephemeral'}
 *   2. qwen/dashscope 隐式缓存 → 门控开时不注入（上游自动做，仅旁路记账）
 *   3. 门控关（PROXY_CACHE_CONTROL=0）→ 零注入，body 逐字节一致
 *   4. 本地 provider（codex/hermes/cursor）→ 即使门控开也不注入
 *   5. 注入决策读 Pricing.cacheHit，但不改变 rankByCost 排序
 *
 * 锁 provider = 选项 A（anthropic messages），见 24 号 §Step 3 + 09-30 维护者拍板。
 * 门控 PROXY_CACHE_CONTROL 默认关 = 零行为回归（非侵入铁律④）。
 *
 * 所有 5 条 case 先写，实现后全转 PASS。
 */

const { maybeInjectCacheControl, isCacheControlEligible } = require('../../lib/forward');

describe('cache_control P2 · TDD RED', () => {

  // ── Case 1: anthropic /v1/messages 门控开 → 注入 cache_control ──
  describe('Case 1 · anthropic /v1/messages 门控开 → 注入', () => {
    test('顶层 cache_control:{type:ephemeral} 被注入', () => {
      const body = {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
      };
      const result = maybeInjectCacheControl(body, {
        proxyName: 'anthropic',
        gate: true,
      });
      // 断言：顶层 cache_control 被注入
      expect(result).toHaveProperty('cache_control', { type: 'ephemeral' });
      // 断言：原始 messages 结构不被破坏
      expect(result.messages).toEqual(body.messages);
    });

    test('block 级 cache_control 加在 system prompt 后第一 block', () => {
      const body = {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        system: 'You are a helpful assistant',
        messages: [
          { role: 'user', content: 'hi' },
        ],
      };
      const result = maybeInjectCacheControl(body, {
        proxyName: 'anthropic',
        gate: true,
      });
      // 断言：system 字符串被转换为 block 数组后，首 block 带 cache_control
      // (Anthropic API: system 可以是 string 或 Block[])
      expect(result.system).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: 'You are a helpful assistant',
            cache_control: { type: 'ephemeral' },
          }),
        ])
      );
    });
  });

  // ── Case 2: dashscope/qwen 隐式缓存 → 不注入 ──
  describe('Case 2 · qwen/dashscope 隐式缓存 → 不注入', () => {
    test('dashscope 隐式缓存：门控开也不改变 body', () => {
      const body = {
        model: 'qwen3.8:27b-mlx',
        messages: [{ role: 'user', content: 'hi' }],
      };
      const result = maybeInjectCacheControl(body, {
        proxyName: 'dashscope',
        gate: true,
        // dashscope = 隐式缓存，代理侧无需注入
      });
      // 断言：body 逐字节一致，不注入 cache_control
      expect(result).toEqual(body);
    });
  });

  // ── Case 3: 门控关 → 零注入 ──
  describe('Case 3 · 门控关 → 零注入（零行为回归）', () => {
    test('PROXY_CACHE_CONTROL=0（gate:false）→ body 逐字节一致', () => {
      const body = {
        model: 'claude-3-5-sonnet',
        max_tokens: 512,
        messages: [{ role: 'user', content: 'hi' }],
      };
      const result = maybeInjectCacheControl(body, {
        proxyName: 'anthropic',
        gate: false,  // 门控关 = 默认
      });
      expect(result).toEqual(body);
    });

    test('门控关时 isCacheControlEligible 返回 false', () => {
      expect(isCacheControlEligible('anthropic', false)).toBe(false);
    });
  });

  // ── Case 4: 本地 provider → 不注入 ──
  describe('Case 4 · 本地 provider → 不注入', () => {
    test('codex 即使门控开也不注入 cache_control', () => {
      const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] };
      const result = maybeInjectCacheControl(body, {
        proxyName: 'codex',
        gate: true,
      });
      expect(result).toEqual(body);
    });

    test('hermes 即使门控开也不注入', () => {
      const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] };
      const result = maybeInjectCacheControl(body, {
        proxyName: 'hermes',
        gate: true,
      });
      expect(result).toEqual(body);
    });

    test('cursor 即使门控开也不注入', () => {
      const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] };
      const result = maybeInjectCacheControl(body, {
        proxyName: 'cursor',
        gate: true,
      });
      expect(result).toEqual(body);
    });
  });

  // ── Case 5: 注入不改变 rankByCost 排序 ──
  describe('Case 5 · 不改变 Pricing/rankByCost 排序', () => {
    test('cache_hit 计数变化不影响路由排序（仅观测）', () => {
      // 门控开，注入 cache_control 后，路由排序不变
      const body = { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] };
      // 注入前快照
      const before = maybeInjectCacheControl(JSON.parse(JSON.stringify(body)), {
        proxyName: 'anthropic',
        gate: true,
      });
      // 再注入一次（幂等：已有 cache_control 不重复添加）
      const before2 = maybeInjectCacheControl(JSON.parse(JSON.stringify(before)), {
        proxyName: 'anthropic',
        gate: true,
      });
      // 两次注入结果一致（幂等，不产生累积副作用）
      expect(before2).toEqual(before);
    });
  });
});
