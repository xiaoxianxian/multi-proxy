'use strict';
const PC = require('../../../l2/prompt-cache.js');

describe('prompt-cache kernel (l2/prompt-cache.js', () => {
  let cache;
  beforeEach(() => { cache = PC.createPromptCache({ gate: false, historyCapacity: 200 }); });

  test('门控默认 off（PROXY_PROMPT_CACHE 未设）', () => {
    const inst = PC.createPromptCache({ gate: false });
    expect(inst.isGateOpen()).toBe(false);
   });

  test('前缀哈希确定性：相同输入产生相同 key', () => {
    const SYS = 'You are a coding assistant.';
    const TOOLS = [{ name: 'read_file' }];
    const M0 = { role: 'system', content: SYS };
    const a = PC.buildPrefixKey(SYS, TOOLS, [M0, { role: 'user', content: 'hello' }]);
    const b = PC.buildPrefixKey(SYS, TOOLS, [M0, { role: 'user', content: 'world' }]);
    expect(a).toBe(b);
   });

  test('system prompt 变化 → key 变化', () => {
    const TOOLS = [{ name: 'read_file' }];
    const M0 = { role: 'system', content: 'A' };
    const a = PC.buildPrefixKey('A', TOOLS, [M0, { role: 'user', content: 'x' }]);
    const b = PC.buildPrefixKey('B', TOOLS, [M0, { role: 'user', content: 'x' }]);
    expect(a).not.toBe(b);
   });

  test('toolSchemas 变化 → key 变化', () => {
    const SYS = 'X';
    const M0 = { role: 'system', content: SYS };
    const a = PC.buildPrefixKey(SYS, [{ name: 'a' }], [M0, { role: 'user', content: 'x' }]);
    const b = PC.buildPrefixKey(SYS, [{ name: 'b' }], [M0, { role: 'user', content: 'x' }]);
    expect(a).not.toBe(b);
   });

  test('第一次请求 → cache miss + 断点注册', () => {
    const r = cache.record({ systemPrompt: 'X', toolSchemas: [{ name: 'a' }], messages: [{ role: 'user', content: 'q' }] }, { now: 1 });
    expect(r.hit).toBe(false);
    expect(cache.getBreakPointCount()).toBe(1);
   });

  test('相同前缀第二次 → cache hit', () => {
    const SYS = 'X';
    const TOOLS = [{ name: 'a' }];
    cache.record({ systemPrompt: SYS, toolSchemas: TOOLS, messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'q1' }] }, { now: 1 });
    const r2 = cache.record({ systemPrompt: SYS, toolSchemas: TOOLS, messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'q2' }] }, { now: 2 });
    expect(r2.hit).toBe(true);
    expect(r2.estTokensSaved).toBeGreaterThan(0);
   });

  test('不同前缀 → miss + 新断点', () => {
    const TOOLS = [{ name: 'a' }];
    cache.record({ systemPrompt: 'A', toolSchemas: TOOLS, messages: [{ role: 'user', content: 'q' }] }, { now: 1 });
    const r2 = cache.record({ systemPrompt: 'B', toolSchemas: TOOLS, messages: [{ role: 'user', content: 'q' }] }, { now: 2 });
    expect(r2.hit).toBe(false);
    expect(cache.getBreakPointCount()).toBe(2);
   });

  test('报告：3 次同 + 1 次异前缀 → cacheHitRate = 50%', () => {
    const SYS = 'X';
    const TOOLS = [{ name: 'a' }];
    const M0 = { role: 'system', content: SYS };
    for (let i = 0; i < 3; i++) {
       cache.record({ systemPrompt: SYS, toolSchemas: TOOLS, messages: [M0, { role: 'user', content: `q${i}` }] }, { now: i });
     }
    cache.record({ systemPrompt: 'Z', toolSchemas: TOOLS, messages: [M0, { role: 'user', content: 'other' }] }, { now: 3 });
    const rep = cache.report();
    expect(rep.cacheHits).toBe(2);
    expect(rep.cacheMisses).toBe(2);
    expect(rep.cacheHitRate).toBe(50);
    expect(rep.requestCount).toBe(4);
   });

  test('门控开（PROXY_PROMPT_CACHE=1）→ gate 字段 true', () => {
    process.env.PROXY_PROMPT_CACHE = '1';
    const inst = PC.createPromptCache();
    expect(inst.isGateOpen()).toBe(true);
    delete process.env.PROXY_PROMPT_CACHE;
   });

  test('crc32 确定性 + 确定性输出', () => {
    const a = PC.crc32('hello');
    const b = PC.crc32('hello');
    expect(a).toBe(b);
    expect(PC.crc32('world')).not.toBe(a);
   });
});
