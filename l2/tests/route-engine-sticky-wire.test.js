// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * route-engine × route-sticky 接线回环测试（node:test，零第三方依赖）。
 *
 * 为什么单测之外还要这个：单测验的是 resolveTierDecision 函数本身，
 * **验不出 route-engine 的旁路有没有真挂上**（external-adopt-verify 第④步）。
 * 本测试起一个 mock Clef /v1/systemone 上游，真建 RouteEngine 真调 route()：
 *
 *   A. 门控开 + sessionId：首轮 judge（mock 收到 1 次）⇒ 次轮 sticky
 *      （mock 仍 1 次——「一次模型都不调」用请求计数证明，不是看返回值）；
 *   B. 门控关：两轮都直调 judge（mock 收到 2 次）——证明默认路径零变化；
 *   C. 无 sessionId：即使门控开也走原直调（退化路径）。
 *
 * 跑法：node --test l2/tests/route-engine-sticky-wire.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { RouteEngine } = require('../route-engine.js');

// ---- mock Clef SystemOne 上游 ----
// 记录每个 mock 实例收到的请求数（回环的核心断言就在这）
function startMockClef() {
  const state = { requests: 0, lastBody: null };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.lastBody = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'clef-flash-4bit',
        answers: { tier: { choice: '2', confidence: 0.9, probabilities: { '2': 0.9 } } },
        usage: { latency_ms: 120 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/v1/systemone` });
    });
  });
}

// 最小 registry：一个 text/small、一个 text/large profile
function fakeRegistry() {
  return {
    list: () => [
      { adapterId: 'local-small', capabilityTags: ['text'], modelType: 'text', modelTier: 'small' },
      { adapterId: 'cloud-big', capabilityTags: ['text'], modelType: 'text', modelTier: 'large' },
    ],
  };
}

test('回环 A：门控开 + sessionId ⇒ 首轮 judge、次轮 sticky，mock 只收 1 次', async () => {
  const mock = await startMockClef();
  const savedJudgeUrl = process.env.L2_LLM_JUDGE_URL;
  const savedGate = process.env.PROXY_ROUTE_STICKY;
  process.env.L2_LLM_JUDGE_URL = mock.url;
  process.env.PROXY_ROUTE_STICKY = '1';
  try {
    const engine = new RouteEngine({ registry: fakeRegistry(), llmJudge: true, shadowMode: true });

    // 首轮：长消息（非续聊）⇒ 走 judge
    const d1 = engine.route({ type: 'text', prompt: '帮我设计一个带熔断的调度器，要考虑……（长任务）', complexity: 'high', sessionId: 'wire-A' });
    await engine.awaitJudges();
    assert.equal(mock.state.requests, 1, '首轮应真调 judge 一次');
    assert.equal(d1.judge.tier, '2');
    assert.equal(d1.judge.stickyFrom, 'judge');
    assert.equal(d1.judgePending, false);

    // 次轮：同 session 普通消息 ⇒ sticky 命中，**不新增 mock 请求**
    const d2 = engine.route({ type: 'text', prompt: '把刚才那个调度器的超时逻辑再改细一点', complexity: 'low', sessionId: 'wire-A' });
    await engine.awaitJudges();
    assert.equal(mock.state.requests, 1, 'sticky 命中时 mock 零新增请求（省调用被请求计数证明）');
    assert.equal(d2.judge.stickyFrom, 'sticky');
    assert.equal(d2.judge.tier, '2', 'sticky 保持首轮档位（哪怕本轮 complexity=low）');

    // 第三轮：短确认「继续」+ 请求级 previousTier ⇒ 仍 sticky（session 内）
    const d3 = engine.route({ type: 'text', prompt: '继续', complexity: 'low', sessionId: 'wire-A', previousTier: '2' });
    await engine.awaitJudges();
    assert.equal(mock.state.requests, 1);
    assert.equal(d3.judge.stickyFrom, 'sticky');
  } finally {
    mock.server.close();
    if (savedJudgeUrl !== undefined) process.env.L2_LLM_JUDGE_URL = savedJudgeUrl; else delete process.env.L2_LLM_JUDGE_URL;
    if (savedGate !== undefined) process.env.PROXY_ROUTE_STICKY = savedGate; else delete process.env.PROXY_ROUTE_STICKY;
  }
});

test('回环 B：门控关 ⇒ 两轮都直调 judge（默认路径零变化）', async () => {
  const mock = await startMockClef();
  const savedJudgeUrl = process.env.L2_LLM_JUDGE_URL;
  const savedGate = process.env.PROXY_ROUTE_STICKY;
  process.env.L2_LLM_JUDGE_URL = mock.url;
  delete process.env.PROXY_ROUTE_STICKY; // 门控关
  try {
    const engine = new RouteEngine({ registry: fakeRegistry(), llmJudge: true, shadowMode: true });
    engine.route({ type: 'text', prompt: '第一轮长消息', complexity: 'high', sessionId: 'wire-B' });
    await engine.awaitJudges();
    engine.route({ type: 'text', prompt: '第二轮普通消息', complexity: 'low', sessionId: 'wire-B' });
    await engine.awaitJudges();
    assert.equal(mock.state.requests, 2, '门控关时两轮都直调（与 2026-10-03 老行为一致）');
  } finally {
    mock.server.close();
    if (savedJudgeUrl !== undefined) process.env.L2_LLM_JUDGE_URL = savedJudgeUrl; else delete process.env.L2_LLM_JUDGE_URL;
    if (savedGate !== undefined) process.env.PROXY_ROUTE_STICKY = savedGate; else delete process.env.PROXY_ROUTE_STICKY;
  }
});

test('回环 C：无 sessionId ⇒ 即使门控开也走原直调（退化路径）', async () => {
  const mock = await startMockClef();
  const savedJudgeUrl = process.env.L2_LLM_JUDGE_URL;
  const savedGate = process.env.PROXY_ROUTE_STICKY;
  process.env.L2_LLM_JUDGE_URL = mock.url;
  process.env.PROXY_ROUTE_STICKY = '1';
  try {
    const engine = new RouteEngine({ registry: fakeRegistry(), llmJudge: true, shadowMode: true });
    engine.route({ type: 'text', prompt: '没有 session 的消息', complexity: 'high' }); // 无 sessionId
    await engine.awaitJudges();
    engine.route({ type: 'text', prompt: '第二条没有 session 的消息', complexity: 'high' });
    await engine.awaitJudges();
    assert.equal(mock.state.requests, 2, '无 sessionKey 时 sticky 链不启用，两轮都直调');
  } finally {
    mock.server.close();
    if (savedJudgeUrl !== undefined) process.env.L2_LLM_JUDGE_URL = savedJudgeUrl; else delete process.env.L2_LLM_JUDGE_URL;
    if (savedGate !== undefined) process.env.PROXY_ROUTE_STICKY = savedGate; else delete process.env.PROXY_ROUTE_STICKY;
  }
});

test('回环 D：previousTier 透传给 judge（mock 收到的 state 里含上轮档位）', async () => {
  const mock = await startMockClef();
  const savedJudgeUrl = process.env.L2_LLM_JUDGE_URL;
  const savedGate = process.env.PROXY_ROUTE_STICKY;
  process.env.L2_LLM_JUDGE_URL = mock.url;
  process.env.PROXY_ROUTE_STICKY = '1';
  try {
    const engine = new RouteEngine({ registry: fakeRegistry(), llmJudge: true, shadowMode: true });
    // 非续聊的长消息 + previousTier ⇒ 走 judge 且 state 带上下文
    engine.route({
      type: 'text', prompt: '把支付模块的退款链路单独拆一个服务，要考虑幂等', complexity: 'medium',
      sessionId: 'wire-D', previousTier: 'medium',
    });
    await engine.awaitJudges();
    assert.equal(mock.state.requests, 1);
    assert.match(String(mock.state.lastBody.state || ''), /medium/, 'judge 的 state 提示应带上轮档位');
  } finally {
    mock.server.close();
    if (savedJudgeUrl !== undefined) process.env.L2_LLM_JUDGE_URL = savedJudgeUrl; else delete process.env.L2_LLM_JUDGE_URL;
    if (savedGate !== undefined) process.env.PROXY_ROUTE_STICKY = savedGate; else delete process.env.PROXY_ROUTE_STICKY;
  }
});
