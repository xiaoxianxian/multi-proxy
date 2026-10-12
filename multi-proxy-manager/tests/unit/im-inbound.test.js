// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 P4 IM 入站通道测试 — /api/im-inbound/webhook
// 非侵入：门控 off → 403 零副作用；门控开 + 注入 mock executor → 200 + reply（不触真网络）。
// 机器鉴权用 x-agent-token（与 cost-report 同通道），测试里设已知 token。
const request = require('supertest');
const express = require('express');

const router = require('../../routes/im-inbound');

// 已知机器 token（测试环境注入，模拟真实 agent 代理的 x-agent-token 鉴权）
const TEST_AGENT_TOKEN = 'test-agent-token-for-im-inbound';

function buildApp() {
  const app = express();
  app.use(express.json());
  // 把真实 executor 替换为 mock（避免触真网络 / 真花钱）
  app.locals.imExecutor = async (adapterId, subtask) => ({
    adapterId,
    model: 'mock-model',
    content: `mock-reply:${subtask.prompt}`,
  });
  app.use('/api/im-inbound', router);
  return app;
}

describe('L2 P4 IM inbound (/api/im-inbound)', () => {
  let app;

  beforeEach(() => {
    delete process.env.PROXY_IM_INBOUND;
    delete process.env.PROXY_EXECUTOR_BIND;
    process.env.MANAGER_AGENT_TOKEN = TEST_AGENT_TOKEN;
    router._resetForTest();
    app = buildApp();
  });

  afterEach(() => {
    delete process.env.MANAGER_AGENT_TOKEN;
  });

  // ---- 门控 ----
  test('门控关(默认)：POST /webhook → 403', async () => {
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({ channel: 'generic', text: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('im-inbound-gate-closed');
  });

  test('门控关：无鉴权头 → 403（门控优先于鉴权）', async () => {
    const res = await request(app).post('/api/im-inbound/webhook')
      .send({ channel: 'generic', text: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(403);
  });

  // ---- 鉴权 ----
  test('门控开 + 错误 agent token → 401（写端点不 fail-open，落到 requireAuth）', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', 'wrong-token')
      .send({ channel: 'generic', text: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBeFalsy();
  });

  // ---- 执行 + 回投（门控开 + mock executor）----
  test('门控开 + 归一化直连(body.text) → 200 + reply 经 mock executor', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({ channel: 'generic', text: 'hello', conversationId: 'c1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reply).toBe('mock-reply:hello');
    expect(res.body.conversationId).toBe('c1');
    expect(res.body.outbound).toBeNull(); // 没带 replyTo → 不回投
  });

  test('门控开 + 飞书原始 payload → 归一化后 200 + reply', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({
        channel: 'feishu',
        payload: { event: { message: { text: '@bot 你好', chat_id: 'oc_abc', sender_id: 'u1' } } },
      });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('mock-reply:你好'); // @bot 前缀被去掉
    expect(res.body.conversationId).toBe('oc_abc');
  });

  test('门控开 + Telegram 原始 payload → 归一化后 200 + reply', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({
        channel: 'telegram',
        payload: { message: { text: 'ping', chat: { id: 998877 }, from: { id: 554433 } } },
      });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('mock-reply:ping');
    expect(res.body.conversationId).toBe('998877');
  });

  test('飞书订阅握手(type=url_verification) → 回 challenge，不执行', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({ channel: 'feishu', payload: { type: 'url_verification', challenge: 'abc123' } });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('abc123');
    expect(res.body.reply).toBeUndefined();
  });

  test('带 replyTo.webhookUrl → 异步回投（non-fatal，回投失败不崩）', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({
        channel: 'generic',
        text: 'hi',
        conversationId: 'c1',
        replyTo: { channel: 'webhook', webhookUrl: 'http://127.0.0.1:1/unroutable' },
      });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('mock-reply:hi');
    // 127.0.0.1:1 不可达 → 回投 graceful 失败，不崩
    expect(res.body.outbound).toBeTruthy();
    expect(res.body.outbound.ok).toBe(false);
  });

  // ---- 边界 ----
  test('缺 channel → 400', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({ text: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('空文本 → 400', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({ channel: 'generic', text: '   ', conversationId: 'c1' });
    expect(res.status).toBe(400);
  });

  test('payload 与 text 都没有 → 400（形态不符）', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    const res = await request(app).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({ channel: 'feishu' });
    expect(res.status).toBe(400);
  });

  // ---- executor 未绑定（真执行门控关，且无注入）----
  test('门控开 + 无 executor 注入 + 无 PROXY_EXECUTOR_BIND → 500 明确报错（不静默）', async () => {
    process.env.PROXY_IM_INBOUND = '1';
    // 不注入 app.locals.imExecutor，且 PROXY_EXECUTOR_BIND 默认关 → getExecutor 返回 null
    const appNoExec = express();
    appNoExec.use(express.json());
    appNoExec.use('/api/im-inbound', router);
    const res = await request(appNoExec).post('/api/im-inbound/webhook')
      .set('x-agent-token', TEST_AGENT_TOKEN)
      .send({ channel: 'generic', text: 'hi', conversationId: 'c1' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/executor 未绑定/);
  });

  // ---- 纯函数（归一化）----
  test('normalizeInbound: feishu 去 @前缀 + 取 chat_id', () => {
    const m = router.normalizeInbound('feishu', { event: { message: { text: '@bot 你好', chat_id: 'oc_x', sender_id: 'u1' } } });
    expect(m.text).toBe('你好');
    expect(m.conversationId).toBe('oc_x');
    expect(m.userId).toBe('u1');
  });

  test('normalizeInbound: 未知 channel 回落 generic', () => {
    const m = router.normalizeInbound('whatsapp-not-impl', { text: 'yo', conversationId: 'c9' });
    expect(m.text).toBe('yo');
    expect(m.conversationId).toBe('c9');
  });

  test('normalizeInbound: 缺 raw → 抛错', () => {
    expect(() => router.normalizeInbound('feishu', null)).toThrow(/raw payload/);
  });
});
