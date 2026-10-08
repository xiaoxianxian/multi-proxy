#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// bridge-dryrun 验证： 「开关前后，发给上游的请求体会差哪些字节」能不能被算准
//
// 要证明三件事：
//   ① pack 默认全关 → 影响面恒为空（这才是「切 rewrite 也不省钱」的机械证据）
//   ② 装了真改动 → 能定位到具体字段 + 字节差额，不是泛泛一句「省了」
//   ③ 🔴 请求体没真的变，就不能算命中（写回但零变化 = 假节省，必须被识别出来）

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('./bridge-dryrun.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-demo-'));

// chat 协议语料：历史里有一条很长的 tool 输出，是内容压缩的靶子
function chatEntries() {
  return [{
    ts: 'x', path: '/v1/chat/completions', api: 'chat-completions', model: 'demo-model',
    body: {
      model: 'demo-model',
      messages: [
        { role: 'system', content: 'you are a coding agent' },
        { role: 'user', content: 'read the file' },
        { role: 'tool', name: 'Read', content: 'x'.repeat(4000) },
        { role: 'user', content: '现在告诉我结论' },
      ],
    },
  }];
}

// responses 协议语料：content 是 [{type:'input_text'}] 内容块（codex 真包就是这个形状）
function responsesEntries() {
  return [{
    ts: 'x', path: '/v1/responses', api: 'responses', model: 'demo-model',
    body: {
      model: 'demo-model',
      instructions: 'you are a coding agent',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'y'.repeat(4000) }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say OK' }] },
      ],
    },
  }];
}

// 纯图片条目：history 里没有任何文本 part → 压缩器「不硬塞一个 type 进去」，
// 于是 policy 写了回、字节却一字节没动，是 detector 的活靶子
function imageEntries() {
  return [{
    ts: 'x', path: '/v1/responses', api: 'responses', model: 'demo-model',
    body: {
      model: 'demo-model',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这张图里是什么' }] },
      ],
    },
  }];
}

function writeCorpus(name, entries) {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

console.log('bridge-dryrun demo\n');

// ---- 纯函数 ----

ok('loadCorpus 跳过坏行且不静默', () => {
  const p = path.join(DIR, 'mixed.jsonl');
  fs.writeFileSync(p, '{"body":{"model":"a"}}\n{bad json\n{"no":"body"}\n');
  const r = D.loadCorpus(p, 0);
  assert.strictEqual(r.entries.length, 1, '只应留下 1 条有效');
  assert.strictEqual(r.skipped.length, 2, '坏行与无 body 都要被计数');
});

ok('diffFields 认得出新增 / 删除 / 修改', () => {
  const c = D.diffFields({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
  const names = c.map((x) => x.field).sort();
  assert.deepStrictEqual(names, ['b', 'c']);
  const added = c.find((x) => x.field === 'c');
  assert.strictEqual(added.beforeChars, 0, '新增字段 beforeChars 应为 0');
});

// ---- 场景 1：pack 默认全关 ----

ok('① 默认全关 → 命中 0，这是「切 rewrite 也不省钱」的机械证据', () => {
  const p = writeCorpus('chat.jsonl', chatEntries());
  const rep = D.analyze(p, [], 0);
  assert.strictEqual(rep.summary.hit, 0);
  assert.strictEqual(rep.summary.tokensBefore, rep.summary.tokensAfter);
  assert.ok(D.toMarkdown(rep).includes('桥现在切到 rewrite 也不会产生任何改动'));
});

// ---- 场景 2：chat 协议 + 真改动 ----

ok('② 折叠 tool 输出 → 定位到 messages 字段 + 真实字节下降', () => {
  const p = writeCorpus('chat2.jsonl', chatEntries());
  const rep = D.analyze(p, [{ hook: 'onHistory', change: 'foldToolOutput', value: true }], 0);
  const e = rep.entries[0];
  assert.strictEqual(e.hit, true, '应该命中');
  const f = e.changed.find((x) => x.field === 'messages');
  assert.ok(f, `应有 messages 字段变化，实际：${JSON.stringify(e.changed)}`);
  assert.ok(f.deltaChars < 0, '折叠后字节数应下降');
  assert.ok(e.after.total < e.before.total, `token 应下降：${e.before.total}→${e.after.total}`);
});

ok('② 最后一条输入不能被吞掉（改写安全）', () => {
  const item = { body: chatEntries()[0].body, api: 'chat-completions' };
  const r = D.runOne(item, [{ hook: 'onHistory', change: 'foldToolOutput', value: true }]);
  assert.strictEqual(r.after.msgs, r.before.msgs, `条数不该变：${r.before.msgs}→${r.after.msgs}`);
  assert.strictEqual(r.after.total < r.before.total, true, '压的是内容不是条数，token 应下降');
});

ok('② params 用完即还原（同进程多组对照不互相污染）', () => {
  const mod = require('../packs/curator/policies/memory-history.js');
  const before = JSON.parse(JSON.stringify(mod.params));
  const p = writeCorpus('chat4.jsonl', chatEntries());
  D.analyze(p, [{ hook: 'onHistory', change: 'foldToolOutput', value: true }], 0);
  assert.deepStrictEqual(mod.params, before, `params 被污染：${JSON.stringify(mod.params)}`);
});

// ---- 场景 3：responses 内容块现在真会被压（textOf 静默失效已修）----

ok('③ responses 的 input_text 块现在真会命中（旧 textOf 只认 text 时这里是零变化）', () => {
  const p = writeCorpus('resp.jsonl', responsesEntries());
  const rep = D.analyze(p, [{ hook: 'onHistory', change: 'maxMsgChars', value: 800 }], 0);
  const e = rep.entries[0];
  assert.ok(e.changed.length > 0, `应该命中，实际变化：${JSON.stringify(e.changed)}`);
  assert.strictEqual(e.hit, true);
  assert.ok(e.after.total < e.before.total, `token 应下降：${e.before.total}→${e.after.total}`);
  assert.strictEqual(rep.summary.hit, 1);
  assert.strictEqual(rep.summary.writtenNoChange, 0, '有真变化就不该被算成假节省');
});

// ---- 场景 4：写回但零变化 = 假节省（靶子换成纯图片条目）----
// 为什么换靶子：此前用「responses 内容块」当靶子，那是因为旧 textOf 认不出 input_text
// 才零变化——修复后那条会真压缩，零变化这条现在由「没有任何文本 part」的图片条目来代表。

ok('④ 纯图片条目：policy 写回了却零变化 → 判未命中并显式标注', () => {
  const p = writeCorpus('img.jsonl', imageEntries());
  const rep = D.analyze(p, [{ hook: 'onHistory', change: 'maxMsgChars', value: 800 }], 0);
  const e = rep.entries[0];
  assert.strictEqual(e.changed.length, 0, '请求体不应有任何字段变化');
  assert.strictEqual(e.hit, false, '不能算命中');
  assert.ok(e.writtenFields.length > 0, '但确实被写回过（这正是要抓的假节省）');
  assert.strictEqual(rep.summary.writtenNoChange, 1);
  assert.ok(D.toMarkdown(rep).includes('假节省'));
});

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响判定 */ }

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
