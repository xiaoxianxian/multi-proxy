'use strict';
// P0 token 控制平面 · prompt-cache 内核 · 真跑验证
// node l2/prompt-cache.demo.js → 全 PASS（门控 off 时 shadow only，零 hot path 触碰）
const PC = require('./prompt-cache.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log(`  ok   ${name}`); }
    catch (e) { fail++; console.log(`! FAIL ${name}  -- ${e.message}`); }
};

// ---- 测试场景：固定前缀（system + toolSchemas + messages[0]），后续 messages[1:] 变动 ----
const SYS    = 'You are a helpful coding assistant. Use only TypeScript.';
const TOOLS  = [
  { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'exec_cmd',  parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
];
const M0     = { role: 'system', content: SYS };
const CONV_BASE = [M0];   // 第 0 轮只 system

// 1. 门控默认 off（PROXY_PROMPT_CACHE 未设 → gate closed）
check('门控默认 off', () => {
  assert.strictEqual(PC.isGateOpen(), false);
});

// 2. 前缀哈希确定性：相同输入产生相同 key
check('前缀哈希确定性：同输入同 key', () => {
  const inst = PC.createPromptCache({ gate: false, historyCapacity: 100 });
  const keyA = PC.buildPrefixKey(SYS, TOOLS, [M0, { role: 'user', content: 'hello' }]);
  const keyB = PC.buildPrefixKey(SYS, TOOLS, [M0, { role: 'user', content: 'goodbye' }]);
  assert.strictEqual(keyA, keyB, '变动部分（messages[1:]）不影响前缀 key');
});

// 3. 前缀变异：system prompt 变化 → key 变化
check('前缀变异：system 变化 → key 变化', () => {
  const keyA = PC.buildPrefixKey(SYS, TOOLS, [M0, { role: 'user', content: 'x' }]);
  const keyB = PC.buildPrefixKey('You are not a useful assistant.', TOOLS, [M0, { role: 'user', content: 'x' }]);
  assert.notStrictEqual(keyA, keyB, 'system 变化必须改变 key');
});

// 4. 前缀变异：toolSchemas 变化 → key 变化
check('前缀变异：toolSchemas 变化 → key 变化', () => {
  const keyA = PC.buildPrefixKey(SYS, TOOLS, [M0, { role: 'user', content: 'x' }]);
  const keyB = PC.buildPrefixKey(SYS, [TOOLS[0]], [M0, { role: 'user', content: 'x' }]);
  assert.notStrictEqual(keyA, keyB, 'toolSchemas 变化必须改变 key');
});

// 5. 第一次请求（cache miss）
check('第一个请求 → cache miss + 断点注册', () => {
  const inst = PC.createPromptCache({ gate: false, historyCapacity: 100 });
  const r = inst.record({ systemPrompt: SYS, toolSchemas: TOOLS, messages: [M0, { role: 'user', content: 'q1' }] }, { now: 1000 });
  assert.strictEqual(r.hit, false, '第一次必 miss');
  assert.strictEqual(inst.getBreakPointCount(), 1, '注册一个断点');
});

// 6. 第二次请求（同前缀 → cache hit）
check('第二个请求（同前缀）→ cache hit', () => {
  const inst = PC.createPromptCache({ gate: false, historyCapacity: 100 });
  const r1 = inst.record({ systemPrompt: SYS, toolSchemas: TOOLS, messages: [M0, { role: 'user', content: 'q1' }] }, { now: 1000 });
  const r2 = inst.record({ systemPrompt: SYS, toolSchemas: TOOLS, messages: [M0, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }, { role: 'user', content: 'q3' }] }, { now: 2000 });
  assert.strictEqual(r1.hit, false, '第一次 miss');
  assert.strictEqual(r2.hit, true, '第二次同前缀必 hit');
  assert.strictEqual(r2.estTokensSaved, r1.breakpoint.estTokensSaved, 'hit 时累计保存量');
  assert.ok(r2.estTokensSaved > 0, 'cache hit 节省 > 0 token');
});

// 7. 不同前缀 → cache miss 且新断点注册
check('不同前缀（system 变了）→ miss + 新断点', () => {
  const inst = PC.createPromptCache({ gate: false, historyCapacity: 100 });
  inst.record({ systemPrompt: SYS, toolSchemas: TOOLS, messages: [M0, { role: 'user', content: 'q1' }] }, { now: 1000 });
  const r2 = inst.record({ systemPrompt: 'Different system!', toolSchemas: TOOLS, messages: [M0, { role: 'user', content: 'q2' }] }, { now: 2000 });
  assert.strictEqual(r2.hit, false, '不同前缀 miss');
  assert.strictEqual(inst.getBreakPointCount(), 2, '两个独立断点');
});

// 8. 报告：cacheHitRate 统计正确
check('报告：cacheHits/cacheMisses/cacheHitRate', () => {
  const inst = PC.createPromptCache({ gate: false, historyCapacity: 100 });
  // 3 次同前缀 + 1 次不同前缀
  for (let i = 0; i < 3; i++) {
     inst.record({ systemPrompt: SYS, toolSchemas: TOOLS, messages: [M0, { role: 'user', content: `q${i}` }] }, { now: 1000 + i });
  }
  const inst2 = inst;  // same instance
  inst2.record({ systemPrompt: 'Other!', toolSchemas: TOOLS, messages: [M0, { role: 'user', content: 'other' }] }, { now: 4000 });
  const rep = inst2.report();
  assert.strictEqual(rep.cacheMisses, 2, '2 个不同前缀 miss');
  assert.strictEqual(rep.cacheHits, 2, '1 hit from 3 same-prefix');
  // 3 same-prefix: first miss, next 2 hit = 2 hits; 1 new prefix = 1 miss; total = 4, hits = 2
  assert.strictEqual(rep.requestCount, 4);
  assert.strictEqual(Math.round(rep.cacheHitRate), 50, '50% hit rate for 2/4');
});

// 9. 门控开时 isGateOpen() 正确反映
check('门控开（PROXY_PROMPT_CACHE=1）', () => {
  const inst = PC.createPromptCache({ gate: true });
  assert.strictEqual(inst.isGateOpen(), true);
});

// 10. 门控关时不写盘（一期：gate off → observe，不落盘；gate on → 可落盘 但本期未实现）
check('门控关 = observe（gate 字段为 false）', () => {
  const inst = PC.createPromptCache({ gate: false });
  const rep = inst.report();
  assert.strictEqual(rep.gate, false);
});

console.log(`\n  prompt-cache demo:  ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
console.log('  PASS');
