// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * l2/subagent-detect.js 单元测试（node:test，零第三方依赖）。
 *
 * 覆盖（外部对照 #71 PilotDeck 落地件，2026-10-18）：
 *   1. 三法各自命中：标签注入 / tools 清单反推 / 显式 isMainAgent=false。
 *   2. 无信号 ⇒ isSubagent=false（主 agent + 有派发工具）。
 *   3. ⚠️ 空 tools 数组 / 无 tools 字段**不反推**（宁可漏判不可错杀——
 *      父 agent 的简单对话也可能不带 tools）。
 *   4. modelHint 提取 + stripSubagentTags 剥掉（转发前不泄漏给上游）。
 *   5. strip 未命中返回原引用（热路径零分配纪律，断言引用相等不只是内容相等）。
 *   6. 畸形输入（null/缺字段/怪形状）不抛错。
 *
 * 跑法：node --test l2/tests/subagent-detect.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSubagent, stripSubagentTags } = require('../subagent-detect.js');

test('三法之标签注入：user 消息嵌 <multi-proxy-subagent-model> 命中且提取 modelHint', () => {
  const r = detectSubagent({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '调研这个仓库\n<multi-proxy-subagent-model>deepseek-v4-flash</multi-proxy-subagent-model>' }] },
    ],
    tools: [{ name: 'agent' }], // 有派发工具，排除法②不干扰，确保是①生效
    isMainAgent: true,
  });
  assert.equal(r.isSubagent, true);
  assert.equal(r.modelHint, 'deepseek-v4-flash');
  assert.equal(r.taggedInUserMessage, true);
  assert.ok(r.reasons.includes('tagged'));
});

test('三法之工具反推：有 tools 但无派发工具 ⇒ 子上下文', () => {
  const r = detectSubagent({
    messages: [{ role: 'user', content: [{ type: 'text', text: '看一下这个文件' }] }],
    tools: [{ name: 'read_file' }, { name: 'grep' }],
    isMainAgent: true,
  });
  assert.equal(r.isSubagent, true);
  assert.equal(r.missingAgentTool, true);
  assert.equal(r.modelHint, null);
  assert.ok(r.reasons.includes('missing-agent-tool'));
});

test('三法之显式标志：isMainAgent=false 直接命中', () => {
  const r = detectSubagent({
    messages: [{ role: 'user', content: '干点活' }],
    tools: [{ name: 'agent' }],
    isMainAgent: false,
  });
  assert.equal(r.isSubagent, true);
  assert.ok(r.reasons.includes('explicit'));
});

test('无信号：主 agent + 有派发工具 ⇒ 不是子上下文', () => {
  const r = detectSubagent({
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我重构这个模块' }] }],
    tools: [{ name: 'agent' }, { name: 'read_file' }],
    isMainAgent: true,
  });
  assert.equal(r.isSubagent, false);
  assert.deepEqual(r.reasons, []);
});

test('边界：空 tools 数组不反推（父 agent 简单对话也不带工具）', () => {
  const r = detectSubagent({
    messages: [{ role: 'user', content: '你好' }],
    tools: [],
    isMainAgent: true,
  });
  assert.equal(r.isSubagent, false);
  assert.equal(r.missingAgentTool, false);
});

test('边界：无 tools 字段不反推', () => {
  const r = detectSubagent({
    messages: [{ role: 'user', content: '你好' }],
    isMainAgent: true,
  });
  assert.equal(r.isSubagent, false);
});

test('派发工具同义词都认：launch_agent / spawn-agent / Task', () => {
  for (const name of ['agent', 'task', 'launch_agent', 'spawn-agent', 'Task']) {
    const r = detectSubagent({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name }],
      isMainAgent: true,
    });
    assert.equal(r.isSubagent, false, `tools 含 ${name} 时应判为主上下文`);
  }
});

test('strip：命中标签时剥掉且不泄漏；未命中返回原引用（零分配）', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '任务A<multi-proxy-subagent-model>m1</multi-proxy-subagent-model>' }] },
    { role: 'user', content: [{ type: 'text', text: '没有标签的消息' }] },
  ];
  const stripped = stripSubagentTags(messages);
  assert.equal(stripped[0].content[0].text, '任务A');
  assert.ok(!/multi-proxy-subagent-model/.test(stripped[0].content[0].text));
  // 未命中的第二条必须原引用返回（不是拷贝）——热路径零分配纪律
  assert.equal(stripped[1], messages[1]);
  // 输入不被 mutated（函数式纪律）
  assert.ok(messages[0].content[0].text.includes('multi-proxy-subagent-model'));
});

test('strip：字符串 content 形态也剥', () => {
  const messages = [{ role: 'user', content: '干活<multi-proxy-subagent-model>m2</multi-proxy-subagent-model>' }];
  const stripped = stripSubagentTags(messages);
  assert.equal(stripped[0].content, '干活');
});

test('畸形输入不抛错：null messages / 非数组 tools / 坏 block', () => {
  assert.doesNotThrow(() => detectSubagent({}));
  assert.doesNotThrow(() => detectSubagent({ messages: null, tools: 'nope' }));
  assert.doesNotThrow(() => detectSubagent({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }));
  const r = detectSubagent({ messages: null, tools: null, isMainAgent: true });
  assert.equal(r.isSubagent, false);
  assert.equal(r.modelHint, null);
});

test('非 user 消息里的标签不扫（只认 user 侧）', () => {
  const r = detectSubagent({
    messages: [
      { role: 'system', content: [{ type: 'text', text: '<multi-proxy-subagent-model>m3</multi-proxy-subagent-model>' }] },
      { role: 'user', content: [{ type: 'text', text: '普通消息' }] },
    ],
    tools: [{ name: 'agent' }],
    isMainAgent: true,
  });
  assert.equal(r.isSubagent, false);
  assert.equal(r.taggedInUserMessage, false);
});
