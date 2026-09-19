'use strict';

// L2 P3 · MCP Bridge route test — /api/mcp
// 非侵入：门控关 → 全 403 零副作用；门控开 → 暴露 mcp bridge 的只读查询 + 路由决策。
const request = require('supertest');
const express = require('express');

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = require('../../routes/mcp');
  if (router._reset) router._reset();
  app.use('/api/mcp', router);
  return app;
}

describe('L2 P3 MCP route (/api/mcp)', () => {

  describe('门控关（PROXY_L2_MCP 未设 = 0）', () => {
    let app;
    beforeEach(() => {
      delete process.env.PROXY_L2_MCP;
      app = buildApp();
     });
    test('GET /api/mcp → 403', async () => {
      const r = await request(app).get('/api/mcp');
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/mcp gate closed/i);
     });
    test('GET /api/mcp/health → 403', async () => {
      const r = await request(app).get('/api/mcp/health');
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/mcp gate closed/i);
     });
    test('POST /api/mcp/call → 403', async () => {
      const r = await request(app).post('/api/mcp/call').set('Content-Type','application/json').send({name:'routeTask',arguments:{type:'video'}});
      expect(r.status).toBe(403);
     });
    test('POST /api/mcp/rpc → 403', async () => {
      const r = await request(app).post('/api/mcp/rpc').set('Content-Type','application/json').send({jsonrpc:'2.0',id:1,method:'ping'});
      expect(r.status).toBe(403);
     });
  });

  describe('门控开（PROXY_L2_MCP=1）', () => {
    let app;
    beforeEach(() => {
      process.env.PROXY_L2_MCP = '1';
      app = buildApp();
    });
    afterEach(() => {
      delete process.env.PROXY_L2_MCP;
    });
    test('GET /api/mcp → 200 + tools 数组 + routeTask', async () => {
      const r = await request(app).get('/api/mcp');
      expect(r.status).toBe(200);
      expect(r.body.gate).toBe('open');
      expect(Array.isArray(r.body.tools)).toBe(true);
      expect(r.body.tools.some(t => t.name === 'routeTask')).toBe(true);
      expect(r.body.tools.some(t => t.name === 'h3web')).toBe(true);
    });
    test('GET /api/mcp/health → 200 + status ok', async () => {
      const r = await request(app).get('/api/mcp/health');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
      expect(r.body.gate).toBe('open');
      expect(r.body.toolCount).toBeGreaterThan(1);
    });
    test('POST /api/mcp/call routeTask → 200 + shadow', async () => {
      const r = await request(app).post('/api/mcp/call').set('Content-Type','application/json')
        .send({ name: 'routeTask', arguments: { type: 'video', prompt: 'cat' } });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.result.shadow).toBe(true);
      expect(r.body.result.route.chosen.adapterId).toBeTruthy();
    });
    test('POST /api/mcp/call 缺 name → 400', async () => {
      const r = await request(app).post('/api/mcp/call').set('Content-Type','application/json').send({});
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/missing tool name/i);
    });
    test('POST /api/mcp/call 未知 tool → 422 + JSON-RPC error code', async () => {
      const r = await request(app).post('/api/mcp/call').set('Content-Type','application/json').send({ name: 'no-such-tool' });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe(-32602);
      expect(Array.isArray(r.body.data.available)).toBe(true);
    });
    test('POST /api/mcp/rpc ping → 200 + jsonrpc response', async () => {
      const r = await request(app).post('/api/mcp/rpc').set('Content-Type','application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(r.status).toBe(200);
      expect(r.body.jsonrpc).toBe('2.0');
      expect(r.body.id).toBe(1);
    });
    test('POST /api/mcp/rpc notification → 204', async () => {
      const r = await request(app).post('/api/mcp/rpc').set('Content-Type','application/json')
        .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(r.status).toBe(204);
    });
    test('GET /api/mcp (tools) + POST call 使用同一长寿命单例', async () => {
       // 两次请求应复用同一 server 实例
      const r1 = await request(app).get('/api/mcp/health');
      expect(r1.body.toolCount).toBeGreaterThan(1);
        // 路由仍返回同一单例的工具
      const r2 = await request(app).get('/api/mcp');
      expect(r2.body.tools.length).toBe(r1.body.toolCount);
     });
   });

  // ---- L2 P3 · 经 MCP bridge 的 complexity→modelTier 路由 ----
  // 生产 seed（l2/mcp-default-seed.js）已带三档 text-tier profile：
  //   agnes(small) / deepseek(medium,默认档) / qwen(large)，complexity 路由落点（见 COMPLEXITY-MODE.md §2.1）。
  // 经 routeTask + complexity 维度暴露给外部 MCP 客户端（与 route-engine.test.js 直测互补，此处覆盖 HTTP/JSON-RPC 面）。
  describe('complexity 三档路由（经 routeTask → routeEngine）', () => {
    let app;
    beforeEach(() => {
      process.env.PROXY_L2_MCP = '1';
      app = buildApp();
      });
    afterEach(() => {
      delete process.env.PROXY_L2_MCP;
      });

   // tierMatch / modelTier / expectedTier 在 mcp-server.js 的 route 投影里精简未透传
   //（对外 MCP 投影只暴露 adapterId/source/confidence，是既有设计），档位元数据断言由
   // route-engine.test.js 直测覆盖；此处只断言 complexity 落点 adapterId（三档区分即可验证路由）。
    test('complexity=low → 路由到 small 档（agnes）', async () => {
      const r = await request(app).post('/api/mcp/call').set('Content-Type','application/json')
         .send({ name: 'routeTask', arguments: { type: 'text', complexity: 'low', prompt: 'translate a short phrase' } });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.result.shadow).toBe(true);
      expect(r.body.result.route.chosen.adapterId).toBe('agnes');
       });

    test('complexity=high → 路由到 large 档（qwen，不降级）', async () => {
      const r = await request(app).post('/api/mcp/call').set('Content-Type','application/json')
         .send({ name: 'routeTask', arguments: { type: 'text', complexity: 'high', prompt: 'design distributed architecture' } });
      expect(r.status).toBe(200);
      expect(r.body.result.route.chosen.adapterId).toBe('qwen');
       });

    test('complexity 缺省 → 默认 medium 档（deepseek，保守不降级）', async () => {
      const r = await request(app).post('/api/mcp/call').set('Content-Type','application/json')
         .send({ name: 'routeTask', arguments: { type: 'text', prompt: 'write a few lines' } });
      expect(r.status).toBe(200);
      expect(r.body.result.route.chosen.adapterId).toBe('deepseek');
       });
   });
});
