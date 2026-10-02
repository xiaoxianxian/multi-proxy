'use strict';
// token-policy-bridge 流式 usage 抽取单测。
//
// 为什么补这组：codex 主路径 100% 走 SSE 流式，而 extractUsageFromSSE 早先只抽
// prompt/completion 两个字段 → observeSample 因 actualCacheMiss 非有限值恒 return，
// k 在「唯一真实流量路径」上永远测不到（55 号留下的缺口）。抽不到必须留 null，
// 绝不能编 0。

// ⚠️ 必须先 mock 两个 l2 模块：bridge 顶层 require 了 l2/token-policy 与 l2/context-fold，
// 而 l2/context-fold.js 此刻带着别人未解决的 git 冲突标记（<<<<<<<），真加载会
// SyntaxError。「测一个纯函数却要拖整条 l2 依赖链」本身就是测试 bites 自己的典型场景。
// extractUsageFromSSE 不碰这两个模块的任何导出，mock 掉是安全的。
jest.mock('../../../l2/token-policy.js', () => ({}));
jest.mock('../../../l2/context-fold.js', () => ({}));

const { extractUsageFromSSE } = require('../../../tools/token-policy-bridge.js');

const sse = (objs) =>
  objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n';

describe('bridge extractUsageFromSSE', () => {
  test('chat 形状：抽 prompt/completion + hit/miss（主流 DeepSeek 口径）', () => {
    const u = extractUsageFromSSE(
      sse([{ choices: [{ delta: { content: 'hi' } }] }, { usage: { prompt_tokens: 31092, completion_tokens: 12, prompt_cache_hit_tokens: 24496, prompt_cache_miss_tokens: 244 } }]),
    );
    expect(u).toEqual({
      prompt_tokens: 31092,
      completion_tokens: 12,
      hit: 24496,
      miss: 244,
    });
  });

  test('responses 形状：input_tokens_details 的 cache_read / cache_creation', () => {
    const u = extractUsageFromSSE(
      sse([
        { type: 'response.output_item.added' },
        { response: { usage: { input_tokens: 31092, output_tokens: 9, input_tokens_details: { cache_read: 24000, cache_creation: 0 } } } },
      ]),
    );
    expect(u.prompt_tokens).toBe(31092);
    expect(u.completion_tokens).toBe(9);
    expect(u.hit).toBe(24000);
    expect(u.miss).toBe(0);
  });

  test('chat 形状走 prompt_tokens_details.cached_tokens 兜底', () => {
    const u = extractUsageFromSSE(
      sse([{ usage: { prompt_tokens: 500, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 400 } } }]),
    );
    expect(u.hit).toBe(400);
    expect(u.miss).toBeNull(); // 没有 miss 字段就 null，不猜
  });

  test('只有 delta 没有 usage 的事件被忽略（取最后一个 usage）', () => {
    const u = extractUsageFromSSE(
      sse([
        { usage: { prompt_tokens: 111, completion_tokens: 1, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 11 } },
        { choices: [{ delta: {} }] },
        { usage: { prompt_tokens: 222, completion_tokens: 2, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 22 } },
      ]),
    );
    expect(u.prompt_tokens).toBe(222);
    expect(u.hit).toBe(200);
    expect(u.miss).toBe(22);
  });

  test('整段没有 usage → null（不编 0）', () => {
    expect(extractUsageFromSSE(sse([{ choices: [{ delta: { content: 'x' } }] }]))).toBeNull();
    expect(extractUsageFromSSE('')).toBeNull();
    expect(extractUsageFromSSE(null)).toBeNull();
    expect(extractUsageFromSSE('data: {oops\n\n')).toBeNull();
  });

  test('空输入/非字符串不炸', () => {
    expect(extractUsageFromSSE(undefined)).toBeNull();
    expect(extractUsageFromSSE(42)).toBeNull();
  });
});
