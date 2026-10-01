#!/usr/bin/env node
'use strict';
// normalizeTools 真跑验证：纯函数 + 真语料 + 真上游对照
//
// 要证明的是**能力不丢**：归一化不是为了绕过 400，是为了把 codex 的子代理工具
// 原样搬给上游。所以断言不能只写「type 变了」，必须写「子工具一个不少」。
//
// 背景（2026-10-01 实测）：codex 0.159.3 走 responses 协议会发 type:'namespace'
// （子代理容器）与 type:'web_search'，agnes 只认 function / web_search_preview /
// code_interpreter / mcp → 整包 400。用 ~/.codex/config.toml 的真 key 直连二分：
//   归一前 → HTTP 400  tools[7].type: unknown variant `namespace`
//   归一后 → HTTP 200  真回推理

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const B = require('./token-policy-bridge.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const FN = (name) => ({
  type: 'function', name, description: 'd', strict: false,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});
const NS_WITH = {
  type: 'namespace', name: 'multi_agent_v1', description: 'sub',
  tools: [FN('close_agent'), FN('open_agent')],
};
const NS_EMPTY = { type: 'namespace', name: 'orphan_ns', tools: [] };

console.log('normalizeTools 对照验证\n');

ok('① namespace 摊平成子 function，一个不少', () => {
  const r = B.normalizeTools({ tools: [NS_WITH] });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.from, ['namespace']);
  assert.strictEqual(r.body.tools.length, 2, `应摊出 2 个，实得 ${r.body.tools.length}`);
  assert.deepStrictEqual(r.body.tools.map((t) => t.type), ['function', 'function']);
  assert.deepStrictEqual(r.body.tools.map((t) => t.name), ['close_agent', 'open_agent']);
});

ok('② 摊平保留子工具的 schema，不是空壳', () => {
  const inner = NS_WITH.tools[0];
  const r = B.normalizeTools({ tools: [NS_WITH] });
  assert.deepStrictEqual(r.body.tools[0], inner, '子工具应逐字段原样搬出');
});

ok('③ 无子工具的 namespace 退化成无参 function 壳（不丢整包，功能退化）', () => {
  const r = B.normalizeTools({ tools: [NS_EMPTY] });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.body.tools.length, 1);
  assert.strictEqual(r.body.tools[0].type, 'function');
  assert.strictEqual(r.body.tools[0].name, 'orphan_ns');
  assert.deepStrictEqual(r.body.tools[0].parameters.properties, {});
});

ok('④ web_search → web_search_preview，其余字段原样保留', () => {
  const r = B.normalizeTools({ tools: [{ type: 'web_search', external_web_access: false }] });
  assert.deepStrictEqual(r.from, ['web_search']);
  assert.deepStrictEqual(r.body.tools[0], { type: 'web_search_preview', external_web_access: false });
});

ok('⑤ 全 function 的包零改动（普通请求不该被序列化抖一遍）', () => {
  const r = B.normalizeTools({ tools: [FN('a'), FN('b')] });
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.from, []);
  assert.strictEqual(r.body.tools.length, 2);
});

ok('⑥ 没有 tools 字段的包零改动', () => {
  const body = { model: 'x', input: 'hi' };
  const r = B.normalizeTools(body);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.body, body, '未改动时应返回原对象引用，不复制');
});

ok('⑦ 已归一化的包再跑一次幂等（from 为空）', () => {
  const r1 = B.normalizeTools({ tools: [NS_WITH, { type: 'web_search' }] });
  const r2 = B.normalizeTools(r1.body);
  assert.strictEqual(r2.changed, false, `二次应无改动，实得 ${JSON.stringify(r2.from)}`);
});

ok('⑧ 非对象元素与 null 不炸（原样透传，不猜）', () => {
  const r = B.normalizeTools({ tools: [null, 'str', NS_WITH] });
  assert.deepStrictEqual(r.body.tools[0], null);
  assert.deepStrictEqual(r.body.tools[1], 'str');
  // null / 'str' 各占 1，namespace 摊出 2 → 共 4
  assert.strictEqual(r.body.tools.length, 4, `实得 ${r.body.tools.length}`);
});

console.log('\n真实语料（codex 抓的 12 工具包）：');
const corpusPath = path.join(__dirname, '..', 'logs', 'bridge-corpus-2026-10-01.jsonl');
if (fs.existsSync(corpusPath)) {
  const line = fs.readFileSync(corpusPath, 'utf8').split('\n').find((l) => l.trim());
  const body = JSON.parse(line).body;
  const before = body.tools.map((t) => t.type);
  const r = B.normalizeTools(body);
  const after = r.body.tools.map((t) => t.type);
  console.log(`  归一前 ${before.length} 个: ${before.join(',')}`);
  console.log(`  归一后 ${after.length} 个: ${after.join(',')}`);
  ok('⑨ 真实语料：namespace 摊平 + web_search 改名，命中 2 类', () => {
    assert.deepStrictEqual(r.from, ['namespace', 'web_search']);
    assert.strictEqual(r.changed, true);
    assert.ok(!after.includes('namespace'), '不该还留 namespace');
    assert.ok(!after.includes('web_search'), '不该还留 web_search');
    assert.strictEqual(after.filter((t) => t === 'web_search_preview').length, 1);
  });
  ok('⑩ 真实语料：工具个数只增不减（摊平产出 ≥ 原始）', () => {
    assert.ok(r.body.tools.length >= before.length, `${r.body.tools.length} < ${before.length}`);
  });
} else {
  console.log('  (语料不在，跳过 ⑨⑩)');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
