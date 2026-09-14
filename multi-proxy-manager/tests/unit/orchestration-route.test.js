'use strict';

// L2 P2 接线测试：/api/orchestration 门控 + shadow 默认 + 单例协作历史 + 环拒绝。
// 非侵入：门控默认关 → 路由 403 零副作用；门控开 → shadow 下不触碰真实 adapter。

const express = require('express');
const request = require('supertest');

describe('L2 P2 orchestration route (/api/orchestration)', () => {
  let routerPath;
  let app;
  const build = () => {
    app = express();
    app.use(express.json());
    const r = require(routerPath);
    r._resetForTest && r._resetForTest();
    app.use('/api/orchestration', r);
    return app;
  };

  beforeEach(() => {
     // 缓存失效：每次取干净单例，验证单例重置语义
    delete require.cache[require.resolve('../../routes/orchestration')];
    routerPath = '../../routes/orchestration';
    });

  afterEach(() => {
    delete process.env.PROXY_ORCHESTRATION;
   });

  it('门控关(默认)：GET + POST 均 403，零副作用', async () => {
    build();
    const g = await request(app).get('/api/orchestration');
    expect(g.status).toBe(403);
    expect(g.body.error).toBe('orchestration-gate-closed');
    const p = await request(app).post('/api/orchestration/run').send({ input: 'jwt' });
    expect(p.status).toBe(403);
   });

  it('门控开 + 直供 DAG：200 + 子任务全 done + 历史记 1 条', async () => {
    process.env.PROXY_ORCHESTRATION = '1';
    build();
    const dag = {
      input: 'demo',
      template: 'single',
      subtasks: [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }],
      edges: [['a', 'b']],
     };
    const r = await request(app).post('/api/orchestration/run').send({ dag, shadowMode: true });
    expect(r.status).toBe(200);
    expect(r.body.runId).toMatch(/^run_/);
    expect(r.body.shadowMode).toBe(true);
    expect(r.body.subtasks.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(r.body.subtasks.every((s) => s.status === 'done')).toBe(true);
    // 协作历史累积
    const hist = await request(app).get('/api/orchestration');
    expect(hist.status).toBe(200);
    expect(hist.body.length).toBe(1);
   });

  it('门控开 + input 拆解(内置视频模板)：200 + 子任务全 done', async () => {
    process.env.PROXY_ORCHESTRATION = '1';
    build();
    const r = await request(app).post('/api/orchestration/run')
      .send({ input: '做一个短片 视频创作 demo' });
    expect(r.status).toBe(200);
    expect(r.body.template).toBe('video-workflow');
    expect(r.body.subtasks.length).toBe(5);
    expect(r.body.subtasks.every((s) => s.status === 'done')).toBe(true);
   });

  it('门控开 + 环 DAG：400(不冒泡)', async () => {
    process.env.PROXY_ORCHESTRATION = '1';
    build();
    const dag = {
      subtasks: [
        { id: 'x', deps: ['y'] },
        { id: 'y', deps: ['x'] },
      ],
      edges: [['x', 'y'], ['y', 'x']],
     };
    const r = await request(app).post('/api/orchestration/run').send({ dag });
      expect(r.status).toBe(400);              // 环被前置 hasCycle 拦截，转 400 不冒泡
      expect(r.body.message).toMatch(/cycle|unresolvable/i);
      });

  it('门控开 + 既无 input 也无 dag：400', async () => {
    process.env.PROXY_ORCHESTRATION = '1';
    build();
    const r = await request(app).post('/api/orchestration/run').send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('orchestration-no-input');
   });

  it('单例长寿命：两次 run 的历史累积为 2 条', async () => {
    process.env.PROXY_ORCHESTRATION = '1';
    build();
    const dag = { input: 'd', subtasks: [{ id: 'a', deps: [] }], edges: [] };
    await request(app).post('/api/orchestration/run').send({ dag });
    await request(app).post('/api/orchestration/run').send({ dag });
    const hist = await request(app).get('/api/orchestration');
    expect(hist.body.length).toBe(2);
   });
});
