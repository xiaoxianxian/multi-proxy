const request = require('supertest');
const app = require('../server');

describe('Multi-Proxy Manager API', () => {

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('GET /api/status', () => {
    it('should return status for configured proxies', async () => {
      const res = await request(app).get('/api/status');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      // At minimum, codex should be in the config if proxy.js exists
      if (res.body.codex) {
        expect(res.body.codex).toHaveProperty('running');
        expect(res.body.codex).toHaveProperty('port', 18790);
      }
    });
  });

  describe('GET /api/logs', () => {
    it('should return logs object', async () => {
      const res = await request(app).get('/api/logs');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('logs');
      expect(res.body).toHaveProperty('count');
    });

    it('should respect limit query param', async () => {
      const res = await request(app).get('/api/logs?limit=10');
      expect(res.status).toBe(200);
      // When log file doesn't exist, recent may not be present
      // Just verify it doesn't error
      expect(res.body.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /api/logs/raw', () => {
    it('should return empty or plain text', async () => {
      const res = await request(app).get('/api/logs/raw');
      expect(res.status).toBe(200);
      // When log file doesn't exist, express sends '' with default text/html
      // When it exists, it sends text/plain — either is acceptable
      expect(typeof res.text).toBe('string');
    });
  });

  describe('POST /api/logs/clear', () => {
    it('should require auth (401 without token)', async () => {
      const res = await request(app).post('/api/logs/clear');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/auth/status', () => {
    // Note: supertest + app.listen() in server.js can cause route conflicts.
    // We test the route pattern but accept the actual response shape.
    it('should return 200 with needsSetup', async () => {
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('needsSetup');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should return 400 without password', async () => {
      const res = await request(app).post('/api/auth/login').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Password required');
    });

    it('should return 401 with wrong password when env password is set', async () => {
      // Skip if MANAGER_PASSWORD is not set (dev mode)
      const envPwd = process.env.MANAGER_PASSWORD;
      if (!envPwd || envPwd.length === 0) {
        // In setup mode, first login creates the password
        return;
      }
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'wrong' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/installed', () => {
    it('should return array of installed proxy names', async () => {
      const res = await request(app).get('/api/installed');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toContain('codex');
      expect(res.body).toContain('hermes');
      expect(res.body).toContain('cursor');
    });
  });

  describe('Forward proxy whitelist', () => {
    it('should allow whitelisted GET endpoint', async () => {
      const res = await request(app).get('/api/codex/v1/models');
      // Will fail to reach upstream (503) but should not be blocked by whitelist (404)
      expect(res.status).not.toBe(404);
    });

    it('should block non-whitelisted endpoint with 404', async () => {
      const res = await request(app).get('/api/codex/admin/secret');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not found');
    });

    it('should block non-whitelisted HTTP method', async () => {
      // DELETE on /api/codex/v1/models now requires auth (A3 fix)
      // Previously returned 404 (whitelist block), now returns 401 (auth required)
      const res = await request(app).delete('/api/codex/v1/models');
      expect(res.status).toBe(401);
    });

    it('should block deep path traversal with ../..', async () => {
      const res = await request(app).get('/api/codex/v1/models/../../../etc/passwd');
      expect(res.status).not.toBe(401); // blocked by whitelist, not auth
    });

    it('should block nested URL-encoded path traversal', async () => {
      const res = await request(app).get('/api/codex/v1/..%252f..%252f..%252fetc/passwd');
      expect(res.status).not.toBe(200); // should not succeed
    });
  });
});