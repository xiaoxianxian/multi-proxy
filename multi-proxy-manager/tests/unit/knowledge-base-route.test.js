'use strict';

// L2 P0 · knowledge-base route test — /api/knowledge
// 非侵入：门控 PROXY_KNOWLEDGE_BASE 关 → 全 403 零副作用；门控开 → 拉模式暴露检索 + 摄取/删除（写操作 requireAuth）。
// 覆盖：门控 403 / status / docs 列表 / retrieve / ingest(鉴权+400) / delete(鉴权+不存在) 。
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// 有效 token（镜像 api.test.js / registry.test.js：requireAuth 校验 x-auth-token）
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-kb-secret';
const AUTH_TOKEN = jwt.sign({ authenticated: true, ts: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = require('../../routes/knowledge-base');
  if (router._resetForTest) router._resetForTest();
  app.use('/api/knowledge', router);
  return app;
}

describe('L2 P0 knowledge-base route (/api/knowledge)', () => {

  describe('门控关（PROXY_KNOWLEDGE_BASE 未设 = 默认零副作用）', () => {
    let app;
    beforeEach(() => {
      delete process.env.PROXY_KNOWLEDGE_BASE;
      app = buildApp();
    });

    test('GET /api/knowledge/status → 403 gate-closed', async () => {
      const r = await request(app).get('/api/knowledge/status');
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/knowledge-gate-closed/i);
      expect(r.body.hint).toMatch(/PROXY_KNOWLEDGE_BASE/);
    });
    test('GET /api/knowledge/docs → 403', async () => {
      const r = await request(app).get('/api/knowledge/docs');
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/knowledge-gate-closed/i);
    });
    test('POST /api/knowledge/retrieve → 403', async () => {
      const r = await request(app).post('/api/knowledge/retrieve')
        .set('Content-Type', 'application/json').send({ query: 'x' });
      expect(r.status).toBe(403);
    });
    test('POST /api/knowledge/ingest → 403（写操作也被门控挡在 auth 之前）', async () => {
      const r = await request(app).post('/api/knowledge/ingest')
        .set('Content-Type', 'application/json').send({ id: 'x', text: 'y' });
      expect(r.status).toBe(403);
    });
    test('DELETE /api/knowledge/docs/:id → 403', async () => {
      const r = await request(app).delete('/api/knowledge/docs/d1');
      expect(r.status).toBe(403);
    });
  });

  describe('门控开（PROXY_KNOWLEDGE_BASE=1）', () => {
    let app;
    beforeEach(() => {
      process.env.PROXY_KNOWLEDGE_BASE = '1';
      app = buildApp();
    });
    afterEach(() => {
      delete process.env.PROXY_KNOWLEDGE_BASE;
    });

    // ---- 读端点（不鉴权，拉模式）----
    test('GET /api/knowledge/status → 200 ready + 空库', async () => {
      const r = await request(app).get('/api/knowledge/status');
      expect(r.status).toBe(200);
      expect(r.body.ready).toBe(true);
      expect(r.body.docs).toBe(0);
      expect(r.body.chunks).toBe(0);
      expect(r.body.persisted).toBe(false);
    });
    test('GET /api/knowledge/docs → 200 空数组', async () => {
      const r = await request(app).get('/api/knowledge/docs');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBe(0);
    });
    test('POST /api/knowledge/retrieve → 200 空库返回空数组', async () => {
      const r = await request(app).post('/api/knowledge/retrieve')
        .set('Content-Type', 'application/json').send({ query: 'anything' });
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBe(0);
    });
    test('POST /api/knowledge/retrieve → 检索命中（摄取后）', async () => {
      // 摄取需鉴权
      const ing = await request(app).post('/api/knowledge/ingest')
        .set('Content-Type', 'application/json').set('x-auth-token', AUTH_TOKEN)
        .send({ id: 'd1', title: 'NO_PROXY 铁律', text: 'NO_PROXY 含裸逗号星号会致 ETIMEDOUT 绕过代理' });
      expect(ing.status).toBe(200);
      expect(ing.body.ingested).toBeGreaterThan(0);
      const r = await request(app).post('/api/knowledge/retrieve')
        .set('Content-Type', 'application/json').send({ query: '代理 绕过 超时', topK: 2 });
      expect(r.status).toBe(200);
      expect(r.body.length).toBeGreaterThan(0);
      expect(r.body[0].id.startsWith('d1#')).toBe(true);
      expect(r.body[0].title).toBe('NO_PROXY 铁律');
      expect(r.body[0].score).toBeGreaterThan(0);
    });
    test('POST /api/knowledge/retrieve 缺 query → 空数组（拉模式不臆测）', async () => {
      const r = await request(app).post('/api/knowledge/retrieve')
        .set('Content-Type', 'application/json').send({ topK: 3 });
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBe(0);
    });

    // ---- 写端点（requireAuth）----
    test('POST /api/knowledge/ingest 无 token → 401', async () => {
      const r = await request(app).post('/api/knowledge/ingest')
        .set('Content-Type', 'application/json').send({ id: 'd1', text: 'x' });
      expect(r.status).toBe(401);
    });
    test('POST /api/knowledge/ingest 缺 id/text → 400', async () => {
      const r = await request(app).post('/api/knowledge/ingest')
        .set('Content-Type', 'application/json').set('x-auth-token', AUTH_TOKEN)
        .send({});
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/knowledge-ingest-failed/i);
    });
    test('POST /api/knowledge/ingest + DELETE 鉴权通过 → 文档增删闭环', async () => {
       // kb 是模块级单例：先删掉前序用例（检索命中/缺query）遗留的 doc，保证本用例从干净态起
      await request(app).delete('/api/knowledge/docs/d1').set('x-auth-token', AUTH_TOKEN);
      const ing = await request(app).post('/api/knowledge/ingest')
        .set('Content-Type', 'application/json').set('x-auth-token', AUTH_TOKEN)
        .send({ id: 'doc-1', title: 't', text: '正文内容' });
      expect(ing.status).toBe(200);
      expect(ing.body.id).toBe('doc-1');
      // 列文档
      const docs = await request(app).get('/api/knowledge/docs');
      expect(docs.body.length).toBe(1);
      expect(docs.body[0].id).toBe('doc-1');
      // 删除
      const del = await request(app).delete('/api/knowledge/docs/doc-1').set('x-auth-token', AUTH_TOKEN);
      expect(del.status).toBe(200);
      expect(del.body.removed).toBe(true);
      // 删除后再列 → 空
      const docs2 = await request(app).get('/api/knowledge/docs');
      expect(docs2.body.length).toBe(0);
    });
    test('DELETE /api/knowledge/docs/:id 无 token → 401', async () => {
      const r = await request(app).delete('/api/knowledge/docs/whatever');
      expect(r.status).toBe(401);
    });
    test('DELETE 不存在的文档 → 200 removed:false', async () => {
      const r = await request(app).delete('/api/knowledge/docs/nope').set('x-auth-token', AUTH_TOKEN);
      expect(r.status).toBe(200);
      expect(r.body.removed).toBe(false);
    });
  });

  describe('门控放行值（1/true/on 均放行，其余 403）', () => {
    it.each(['1', 'true', 'on'])('PROXY_KNOWLEDGE_BASE=%s → 200', async (val) => {
      process.env.PROXY_KNOWLEDGE_BASE = val;
      const app = buildApp();
      const r = await request(app).get('/api/knowledge/status');
      expect(r.status).toBe(200);
      delete process.env.PROXY_KNOWLEDGE_BASE;
    });
    it.each(['', '0', 'off', 'false'])('PROXY_KNOWLEDGE_BASE=%s → 403', async (val) => {
      process.env.PROXY_KNOWLEDGE_BASE = val;
      const app = buildApp();
      const r = await request(app).get('/api/knowledge/status');
      expect(r.status).toBe(403);
      delete process.env.PROXY_KNOWLEDGE_BASE;
    });
  });
});
