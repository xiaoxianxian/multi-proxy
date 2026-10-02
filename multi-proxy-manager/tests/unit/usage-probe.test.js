'use strict';

// usage-probe 单测 —— 「开盒即用」的地基：接入方只贴 raw，解析由本模块单点吃掉。
//
// 口径：归一不出来就**全 0**（宁可空账，不虚账）；认不出的 wire 要如实报出来，
// 让接入方一眼看出「这条没接上」，而不是假装成功。
//
// 三个真实踩过的坑（2026-10-02 实测，别回退）：
//   1. Anthropic 流式 usage 藏在 `message_delta.usage` 子层，不往里挖一层 thinking 恒 0；
//   2. 非流式响应整段是 JSON 且 usage 包在 `.usage` 里，只认 SSE 会退化成全 0 空账；
//   3. OpenAI 线没有 `output_tokens_details` 时，`typeof td && ...` 会因
//      `typeof undefined` 是字符串（truthy）而短路失效 → 必须对象短路。

const { detectWire, fromSse, fromJsonText, normalize, toUsage } = require('../../lib/usage-probe.js');

describe('usage-probe · 三条 wire 的归一', () => {
  test('Anthropic 原生（input/output/output_tokens_details）', () => {
    expect(toUsage({
      input_tokens: 31, output_tokens: 47, output_tokens_details: { thinking_tokens: 37 },
    })).toMatchObject({ prompt: 31, completion: 47, cacheHit: 0, thinking: 37, wire: 'anthropic' });
  });

  test('OpenAI 原生（prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens）', () => {
    expect(toUsage({
      prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 },
    })).toMatchObject({ prompt: 100, completion: 50, cacheHit: 30, thinking: 0, wire: 'openai' });
  });

  test('Gemini（usage_metadata 四个字段）', () => {
    expect(toUsage({
      usage_metadata: {
        prompt_token_count: 80, candidates_token_count: 60,
        cached_content_token_count: 20, thoughts_token_count: 40,
      },
    })).toMatchObject({ prompt: 80, completion: 60, cacheHit: 20, thinking: 40, wire: 'gemini' });
  });

  test('裸 thinking_tokens（OpenAI 某些上游不套 details）', () => {
    expect(toUsage({ input_tokens: 5, output_tokens: 9, thinking_tokens: 4 }))
      .toMatchObject({ prompt: 5, completion: 9, thinking: 4 });
  });

  test('Anthropic 缓存命中走 cache_read_input_tokens，且计入 cacheHit', () => {
    // 2026-10-02 真 Kimi 响应：input_tokens=0 但 prompt_tokens=31（命中缓存不重复收输入钱）
    const t = toUsage({
      input_tokens: 0, cache_read_input_tokens: 31, output_tokens: 48,
      output_tokens_details: { thinking_tokens: 38 }, prompt_tokens: 31,
    });
    expect(t).toMatchObject({ prompt: 31, completion: 48, cacheHit: 31, thinking: 38 });
  });
});

describe('usage-probe · raw 的三种形状', () => {
  const sse = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":47,"output_tokens_details":{"thinking_tokens":37}}}\n\n';

  test('SSE 流式：取末事件并下探 usage 子层', () => {
    expect(toUsage(sse)).toMatchObject({ completion: 47, thinking: 37, wire: 'anthropic' });
  });

  test('SSE 中途半截：整条忽略，不制造半个数字', () => {
    expect(toUsage('event: content_block_start\ndata: {"type":"c'))
      .toMatchObject({ prompt: 0, completion: 0, thinking: 0, wire: 'raw-unparsed' });
  });

  test('非流式整段 JSON：Anthropic 把 usage 包在 .usage 里', () => {
    const body = JSON.stringify({
      id: 'chk_01A1', type: 'message',
      usage: { input_tokens: 31, cache_read_input_tokens: 31, output_tokens: 48, output_tokens_details: { thinking_tokens: 38 } },
    });
    expect(toUsage(body)).toMatchObject({ prompt: 31, completion: 48, cacheHit: 31, thinking: 38, wire: 'anthropic' });
  });

  test('非流式整段 JSON：整段就是裸 usage（OpenAI 兼容面）', () => {
    expect(toUsage(JSON.stringify({ prompt_tokens: 20, completion_tokens: 11 })))
      .toMatchObject({ prompt: 20, completion: 11, wire: 'openai' });
  });

  test('非 JSON 文本 / 半截 JSON：全 0 且如实报 raw-unparsed', () => {
    expect(toUsage('hello world, not json')).toMatchObject({ wire: 'raw-unparsed' });
    expect(toUsage('{"usage":{"input_tokens":31,"output')).toMatchObject({ wire: 'raw-unparsed' });
  });

  test('入口可以直喂「包了一层」的响应体对象', () => {
    expect(toUsage({ usage: { input_tokens: 3, output_tokens: 4 } }))
      .toMatchObject({ prompt: 3, completion: 4 });
  });
});

describe('usage-probe · 认不出时的诚实口径', () => {
  test('null → 全 0 / unknown，绝不折算 0 冒充有数', () => {
    const t = toUsage(null);
    expect(t).toEqual({ prompt: 0, completion: 0, cacheHit: 0, thinking: 0, wire: 'unknown' });
  });

  test('空对象 → 全 0 / custom', () => {
    expect(toUsage({})).toMatchObject({ wire: 'custom' });
  });
});

describe('usage-probe · detectWire（接入方可以不声明）', () => {
  test('对象：anthropic / openai / gemini / custom', () => {
    expect(detectWire({ input_tokens: 1 })).toBe('anthropic');
    expect(detectWire({ prompt_tokens: 1 })).toBe('openai');
    expect(detectWire({ usage_metadata: {} })).toBe('gemini');
    expect(detectWire({})).toBe('custom');
  });

  test('包一层 { usage: {...} } 也能认', () => {
    expect(detectWire({ usage: { input_tokens: 1 } })).toBe('anthropic');
  });

  test('字符串：SSE → sse，整段 JSON → 其内部 wire，垃圾 → null', () => {
    expect(detectWire('data: {"usage":{"input_tokens":1}}')).toBe('sse');
    expect(detectWire(JSON.stringify({ usage: { input_tokens: 1 } }))).toBe('anthropic');
    expect(detectWire('not json at all')).toBe(null);
  });
});

describe('usage-probe · fromSse / fromJsonText 边界', () => {
  test('fromSse 无 data: 直接返回 null', () => {
    expect(fromSse('plain text')).toBe(null);
  });

  test('fromJsonText 非 JSON / 空 → null', () => {
    expect(fromJsonText('[]')).toBe(null);
    expect(fromJsonText('')).toBe(null);
  });

  test('fromJsonText 认不出 usage 形状 → null', () => {
    expect(fromJsonText(JSON.stringify({ id: 'x' }))).toBe(null);
  });

  test('normalize 吃非对象 → 全 0', () => {
    expect(normalize(null)).toMatchObject({ wire: 'unknown' });
  });
});
