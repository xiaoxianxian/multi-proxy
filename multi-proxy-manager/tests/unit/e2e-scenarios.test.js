/**
 * End-to-end integration test scenarios.
 * Tests cross-module flows: manager → proxy → config → logs.
 * Uses supertest against the manager app.
 *
 * Prerequisites:
 * - All proxy source files exist in the workspace
 * - NODE_ENV=test is set so server.js doesn't call app.listen()
 *
 * These tests verify the full chain without requiring real upstream APIs.
 */

const request = require('supertest');
const app = require('../server');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Resolve project root robustly: go up from tests/unit/ → multi-proxy-manager/ → proxy-rebuild/
const PROJECT_ROOT = path.resolve(__dirname, '../..', '..');

describe('E2E — Manager API Flow', () => {
  describe('GET /api/installed', () => {
    it('should list all managed proxies', async () => {
      const res = await request(app).get('/api/installed');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toContain('codex');
      expect(res.body).toContain('hermes');
      expect(res.body).toContain('cursor');
    });
  });

  describe('GET /api/status', () => {
    it('should return status for all proxies', async () => {
      const res = await request(app).get('/api/status');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');

      // Each proxy should have expected fields
      for (const [name, status] of Object.entries(res.body)) {
        expect(status).toHaveProperty('running');
        expect(status).toHaveProperty('port');
        expect(status).toHaveProperty('name');
        expect(status).toHaveProperty('fault');
      }
    });

    it('should report codex on port 18790', async () => {
      const res = await request(app).get('/api/status');
      expect(res.body.codex.port).toBe(18790);
    });

    it('should report hermes on port 18793', async () => {
      const res = await request(app).get('/api/status');
      expect(res.body.hermes.port).toBe(18793);
    });

    it('should report cursor on port 18794', async () => {
      const res = await request(app).get('/api/status');
      expect(res.body.cursor.port).toBe(18794);
    });
  });

  describe('GET /api/version', () => {
    it('should return version info', async () => {
      const res = await request(app).get('/api/version');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('version');
      expect(res.body).toHaveProperty('proxies');
    });
  });

  describe('GET /health', () => {
    it('should return manager health', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('Forward proxy to codex — /api/codex/v1/models', () => {
    it('should be in whitelist (not 404)', async () => {
      const res = await request(app).get('/api/codex/v1/models');
      // Will likely 503 (proxy not running) but should NOT be 404 (whitelist blocked)
      expect(res.status).not.toBe(404);
    });
  });

  describe('Forward proxy to hermes — /api/hermes/v1/models', () => {
    it('should be in whitelist (not 404)', async () => {
      const res = await request(app).get('/api/hermes/v1/models');
      expect(res.status).not.toBe(404);
    });
  });

  describe('Forward proxy to cursor — /api/cursor/v1/models', () => {
    it('should be in whitelist (not 404)', async () => {
      const res = await request(app).get('/api/cursor/v1/models');
      expect(res.status).not.toBe(404);
    });
  });

  describe('Whitelist blocks unauthorized access', () => {
    it('blocks admin endpoints on codex', async () => {
      const res = await request(app).get('/api/codex/admin/secret');
      expect(res.status).toBe(404);
    });

    it('blocks admin endpoints on hermes', async () => {
      const res = await request(app).get('/api/hermes/admin/secret');
      expect(res.status).toBe(404);
    });

    it('blocks DELETE on codex models', async () => {
      // DELETE on /api/codex/v1/models now requires auth (A3 fix)
      const res = await request(app).delete('/api/codex/v1/models');
      expect(res.status).toBe(401);
    });
  });
});

describe('E2E — Log System', () => {
  let logFile;

  beforeAll(() => {
    logFile = path.join(os.tmpdir(), 'multi-proxy-manager', 'requests.log');
  });

  it('GET /api/logs returns valid JSON', async () => {
    const res = await request(app).get('/api/logs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('logs');
    expect(res.body).toHaveProperty('count');
    expect(res.body).toHaveProperty('recent');
  });

  it('GET /api/logs?limit=5 returns limited results', async () => {
    const res = await request(app).get('/api/logs?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.recent).toBeLessThanOrEqual(5);
  });

  it('GET /api/logs/raw returns plain text', async () => {
    const res = await request(app).get('/api/logs/raw');
    expect(res.status).toBe(200);
    expect(typeof res.text).toBe('string');
  });

  it('POST /api/logs/clear requires auth', async () => {
    const res = await request(app).post('/api/logs/clear');
    expect(res.status).toBe(401);
  });
});

describe('E2E — Auth System', () => {
  it('GET /api/auth/status returns needsSetup', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('needsSetup');
  });

  it('POST /api/auth/login without password returns 400', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password required');
  });
});

describe('E2E — Proxy Config File Detection', () => {
  it('codex-proxy directory exists with proxy.js', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'codex-proxy', 'proxy.js'))).toBe(true);
  });

  it('hermes-proxy directory exists with proxy.py', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'hermes-proxy', 'proxy.py'))).toBe(true);
  });

  it('cursor-multi-model-proxy directory exists with dist/server/start.js or src', () => {
    const hasDist = fs.existsSync(path.join(PROJECT_ROOT, 'cursor-multi-model-proxy', 'dist', 'server', 'start.js'));
    const hasSrc = fs.existsSync(path.join(PROJECT_ROOT, 'cursor-multi-model-proxy', 'src'));
    expect(hasDist || hasSrc).toBe(true);
  });
});

describe('E2E — Manage Script', () => {
  it('manage.sh exists', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'manage.sh'))).toBe(true);
  });

  it('install.sh exists', () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'install.sh'))).toBe(true);
  });
});
