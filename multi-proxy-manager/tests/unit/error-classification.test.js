/**
 * fetch-models / test-connection 错误文案分类测试
 * 验证 401/403（认证失败）、404（端点不存在）、网络错误三类文案区分。
 * axios 用 jest.mock 拦截，不发起真实网络请求。
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const request = require('supertest');
const jwt = require('jsonwebtoken');

// axios mock：可按用例注入 err（jest 要求 mock 前缀变量）
let mockAxiosImpl = null;
jest.mock('axios', () => {
  const fn = (...args) => mockAxiosImpl(...args);
  fn.get = (...args) => mockAxiosImpl(...args);
  return fn;
});

const app = require('../../server');

const AUTH_TOKEN = jwt.sign({ authenticated: true, ts: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' });
const authed = (req) => req.set('x-auth-token', AUTH_TOKEN);

function authError(status) {
  const err = new Error('Request failed with status code ' + status);
  err.response = { status };
  return err;
}

function networkError(code) {
  const err = new Error('connect ' + code);
  err.code = code;
  return err;
}

beforeEach(() => { mockAxiosImpl = null; });

describe('fetch-models / test-connection 错误文案区分', () => {

  describe('POST /api/fetch-models', () => {
    it('上游 401 → 提示认证失败而非无法连接', async () => {
      mockAxiosImpl = async () => { throw authError(401); };
      const res = await authed(request(app).post('/api/fetch-models'))
        .send({ providerId: 'openai-compatible', baseUrl: 'https://api.example.com', apiKey: 'k' });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('认证失败');
      expect(res.body.error).toContain('API Key');
    });

    it('上游 403 → 同样提示认证失败', async () => {
      mockAxiosImpl = async () => { throw authError(403); };
      const res = await authed(request(app).post('/api/fetch-models'))
        .send({ providerId: 'openai-compatible', baseUrl: 'https://api.example.com', apiKey: 'k' });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('认证失败');
    });

    it('网络不通（ECONNREFUSED）→ 提示连接问题', async () => {
      mockAxiosImpl = async () => { throw networkError('ECONNREFUSED'); };
      const res = await authed(request(app).post('/api/fetch-models'))
        .send({ providerId: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', apiKey: 'k' });
      expect(res.status).toBe(502);
      expect(res.body.error).toContain('无法连接到供应商 API');
    });

    it('成功响应 → 返回模型列表', async () => {
      mockAxiosImpl = async () => ({ data: { data: [{ id: 'gpt-test' }] } });
      const res = await authed(request(app).post('/api/fetch-models'))
        .send({ providerId: 'openai-compatible', baseUrl: 'https://api.example.com', apiKey: 'k' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.models[0].id).toBe('gpt-test');
    });
  });

  describe('POST /api/test-connection', () => {
    it('上游 401 → 提示认证失败', async () => {
      mockAxiosImpl = async () => { throw authError(401); };
      const res = await authed(request(app).post('/api/test-connection'))
        .send({ baseUrl: 'https://api.example.com', model: 'openai' });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('认证失败');
    });

    it('上游 404 → 提示检查 Base URL', async () => {
      mockAxiosImpl = async () => { throw authError(404); };
      const res = await authed(request(app).post('/api/test-connection'))
        .send({ baseUrl: 'https://api.example.com', model: 'openai' });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Base URL');
    });

    it('超时（ETIMEDOUT）→ 提示连接问题', async () => {
      mockAxiosImpl = async () => { throw networkError('ETIMEDOUT'); };
      const res = await authed(request(app).post('/api/test-connection'))
        .send({ baseUrl: 'http://10.255.255.1', model: 'openai' });
      expect(res.status).toBe(502);
      expect(res.body.error).toContain('无法连接到供应商 API');
    });

    it('连通成功', async () => {
      mockAxiosImpl = async () => ({ data: {} });
      const res = await authed(request(app).post('/api/test-connection'))
        .send({ baseUrl: 'https://api.example.com', model: 'openai' });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('连通成功');
    });
  });

  describe('无 token 认证边界', () => {
    it('fetch-models 无 token → 401', async () => {
      const res = await request(app).post('/api/fetch-models').send({});
      expect(res.status).toBe(401);
    });
    it('test-connection 无 token → 401', async () => {
      const res = await request(app).post('/api/test-connection').send({});
      expect(res.status).toBe(401);
    });
  });
});
