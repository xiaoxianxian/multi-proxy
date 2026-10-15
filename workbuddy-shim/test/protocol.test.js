// 协议纯函数单测（零依赖，node test/protocol.test.js）
'use strict';

const assert = require('assert');
const { Readable: NodeReadable } = require('stream');
const m = require('../server.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', e.message); }
}
const asyncTests = [];
function testAsync(name, fn) { asyncTests.push({ name, fn }); }

console.log('[protocol.test] WorkBuddy shim 协议纯函数');

test('regionOf: 空 domain = cn', () => {
  assert.strictEqual(m.regionOf(''), 'cn');
  assert.strictEqual(m.regionOf(undefined), 'cn');
});
test('regionOf: workbuddy.ai = global', () => {
  assert.strictEqual(m.regionOf('workbuddy.ai'), 'global');
  assert.strictEqual(m.regionOf('sub.workbuddy.ai'), 'global');
});

test('chatBaseUrl / originReferer', () => {
  assert.strictEqual(m.chatBaseUrl('cn'), 'https://copilot.tencent.com');
  assert.strictEqual(m.chatBaseUrl('global'), 'https://www.workbuddy.ai');
  assert.strictEqual(m.originReferer('cn'), 'https://www.codebuddy.cn');
});

test('commonHeaders 带 CLI UA', () => {
  const h = m.commonHeaders('cn');
  assert.strictEqual(h['User-Agent'], 'CLI/2.63.2 CodeBuddy/2.63.2');
  assert.strictEqual(h['X-Requested-With'], 'XMLHttpRequest');
});

test('chatHeaders: 有 uid 带 X-User-Id，无则 X-No-User-Id', () => {
  const withUid = m.chatHeaders('cn', 'UA', '5.5.6', { uid: 'u1', enterpriseId: '', domain: '' });
  assert.strictEqual(withUid['X-User-Id'], 'u1');
  assert.ok(!('X-No-User-Id' in withUid));
  const noUid = m.chatHeaders('cn', 'UA', '5.5.6', { uid: '', enterpriseId: '', domain: '' });
  assert.strictEqual(noUid['X-No-User-Id'], '1');
  assert.ok(!('X-User-Id' in noUid));
});
test('chatHeaders: enterpriseId / domain 三态', () => {
  const c = m.chatHeaders('cn', 'UA', '5.5.6', { uid: '', enterpriseId: 'e1', domain: 'd1' });
  assert.strictEqual(c['X-Enterprise-Id'], 'e1');
  assert.strictEqual(c['X-Domain'], 'd1');
  const none = m.chatHeaders('cn', 'UA', '5.5.6', { uid: '', enterpriseId: '', domain: '' });
  assert.strictEqual(none['X-No-Enterprise-Id'], '1');
  assert.strictEqual(none['X-No-Department-Info'], '1');
});

test('prepareChatBody: 强制 stream:true + developer→system', () => {
  const out = JSON.parse(m.prepareChatBody(JSON.stringify({
    model: 'x', stream: false,
    messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
  })));
  assert.strictEqual(out.stream, true);
  assert.strictEqual(out.messages[0].role, 'system');
});

test('normalizeToolChoice: none 删 tools + tool_choice', () => {
  const out = JSON.parse(m.prepareChatBody(JSON.stringify({
    model: 'x', tools: [{ a: 1 }], tool_choice: 'none', messages: [],
  })));
  assert.ok(!('tools' in out));
  assert.ok(!('tool_choice' in out));
});
test('normalizeToolChoice: 对象 auto/required 归一', () => {
  const auto = JSON.parse(m.prepareChatBody(JSON.stringify({ model: 'x', tool_choice: { type: 'auto' }, messages: [] })));
  assert.strictEqual(auto.tool_choice, 'auto');
  const req = JSON.parse(m.prepareChatBody(JSON.stringify({ model: 'x', tool_choice: { type: 'required' }, messages: [] })));
  assert.strictEqual(req.tool_choice, 'required');
});

test('prepareCnChatBody: 去掉 reasoning_effort off', () => {
  const out = JSON.parse(m.prepareCnChatBody(JSON.stringify({ model: 'x', reasoning_effort: 'off', messages: [] })));
  assert.ok(!('reasoning_effort' in out));
});

test('prepareInternationalChatBody: 首位补 system + 去 off + 强制 stream', () => {
  const out = JSON.parse(m.prepareInternationalChatBody(JSON.stringify({
    model: 'x', reasoning_effort: 'off', messages: [{ role: 'user', content: 'hi' }],
  })));
  assert.strictEqual(out.messages[0].role, 'system');
  assert.strictEqual(out.messages[0].content, 'You are a helpful assistant.');
  assert.ok(!('reasoning_effort' in out));
  assert.strictEqual(out.stream, true);
});
test('prepareInternationalChatBody: 已有 system 不重复补', () => {
  const out = JSON.parse(m.prepareInternationalChatBody(JSON.stringify({
    model: 'x', messages: [{ role: 'system', content: 'existing' }, { role: 'user', content: 'hi' }],
  })));
  assert.strictEqual(out.messages[0].content, 'existing');
  assert.strictEqual(out.messages.length, 2);
});

test('prepareChatBodyForRegion: cn 用 cn 整形，global 用国际整形', () => {
  const cn = JSON.parse(m.prepareChatBodyForRegion('cn', JSON.stringify({ model: 'x', reasoning_effort: 'off', messages: [{ role: 'user', content: 'hi' }] })));
  // cn 不补 system
  assert.strictEqual(cn.messages.length, 1);
  const gl = JSON.parse(m.prepareChatBodyForRegion('global', JSON.stringify({ model: 'x', reasoning_effort: 'off', messages: [{ role: 'user', content: 'hi' }] })));
  assert.strictEqual(gl.messages[0].role, 'system');
});

test('buildAliasMap: 解析 wb-名称:真实id 映射', () => {
  const saved = process.env.WORKBUDDY_MODEL_ALIASES;
  process.env.WORKBUDDY_MODEL_ALIASES = 'wb-r1:deepseek-r1,wb-v32:deepseek-v3.2';
  const map = m.buildAliasMap();
  assert.strictEqual(map.get('wb-r1'), 'deepseek-r1');
  assert.strictEqual(map.get('wb-v32'), 'deepseek-v3.2');
  assert.strictEqual(map.size, 2);
  process.env.WORKBUDDY_MODEL_ALIASES = saved;
});

test('resolveModelAlias: 默认去 wb- 前缀', () => {
  // 模块加载时 WORKBUDDY_MODEL_ALIASES 未设置 ⇒ _aliasMap 为 null ⇒ 默认去 wb- 前缀。
  assert.strictEqual(m.resolveModelAlias('wb-deepseek-v3.2'), 'deepseek-v3.2');
  assert.strictEqual(m.resolveModelAlias('deepseek-v3.2'), 'deepseek-v3.2');
  assert.strictEqual(m.resolveModelAlias(''), '');
});

// ===== 非流式聚合（handleChatCompletions 的分支覆盖）=====
testAsync('aggregateStreamToCompletion: 多 chunk SSE 聚合为完整响应', async () => {
  const sse = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"你"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"好"}}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ];
  const webStream = NodeReadable.toWeb(NodeReadable.from(sse.map(s => Buffer.from(s))));
  const full = await m.aggregateStreamToCompletion({ body: webStream }, 'wb-deepseek-v3.2');
  assert.strictEqual(full.object, 'chat.completion');
  assert.strictEqual(full.choices[0].message.content, '你好');
  assert.strictEqual(full.choices[0].finish_reason, 'stop');
  assert.strictEqual(full.model, 'wb-deepseek-v3.2');
  assert.strictEqual(full.usage.total_tokens, 5);
});

testAsync('aggregateStreamToCompletion: 跨 chunk 边界的行也能解析', async () => {
  const chunks = [
    Buffer.from('data: {"id":"c","choices":[{"index":0,"delta":{"content":"AB"}}]}\n\ndata: {"id":"c","choices":[{"index":0,"delta":{"content":"CD"}}]}\n'),
    Buffer.from('data: [DONE]\n\n'),
  ];
  const webStream = NodeReadable.toWeb(NodeReadable.from(chunks));
  const full = await m.aggregateStreamToCompletion({ body: webStream }, 'm');
  assert.strictEqual(full.choices[0].message.content, 'ABCD');
});

(async () => {
  for (const t of asyncTests) {
    try { await t.fn(); pass++; console.log('  ✓', t.name); }
    catch (e) { fail++; console.error('  ✗', t.name, '\n     ', e.message); }
  }
  console.log(`\n[protocol.test] pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
