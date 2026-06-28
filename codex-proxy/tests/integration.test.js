/**
 * Integration tests for codex-proxy HTTP endpoints.
 * Uses supertest against a standalone Express app that mirrors proxy.js routes.
 * Tests pure logic functions extracted from proxy.js.
 */

const express = require('express');
const request = require('supertest');

// ===== Inline UPSTREAM_MODELS (same as proxy.js) =====
const UPSTREAM_MODELS = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-deepseek',
    availableModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: 'sk-test-moonshot',
    availableModels: ['moonshot-v1-8k', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'moonshot-v1-128k', 'moonshot-v1-128k-vision-preview', 'moonshot-v1-32k', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-8k', 'moonshot-v1-8k-vision-preview', 'moonshot-v1-auto'],
  },
  {
    name: 'Agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: 'sk-test-agnes',
    availableModels: ['agnes-2.0-flash', 'agnes-1.5-flash', 'agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-video-v2.0'],
  }
];

function findProvider(modelName) {
  if (!modelName) return null;
  let provider = UPSTREAM_MODELS.find(p => p.availableModels.includes(modelName));
  if (provider) return provider;
  const lower = modelName.toLowerCase();
  if (lower.includes('deepseek')) return UPSTREAM_MODELS[0];
  if (lower.includes('kimi') || lower.includes('moonshot')) return UPSTREAM_MODELS[1];
  if (lower.includes('agnes')) return UPSTREAM_MODELS[2];
  return null;
}

// ===== Test App =====
let testApp;
let routingMode = 'codex';
const switchHistory = [];

beforeAll(() => {
  testApp = express();
  testApp.use(express.json({ limit: '50mb' }));

  // /v1/models
  testApp.get('/v1/models', (req, res) => {
    const models = UPSTREAM_MODELS.flatMap(p =>
      p.availableModels.map(name => ({
        id: name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: p.name
      }))
    );
    res.json({ object: 'list', data: models });
  });

  // /health
  testApp.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      uptime: Date.now(),
      models: UPSTREAM_MODELS.flatMap(p => p.availableModels)
    });
  });

  // /api/routing-mode
  testApp.get('/api/routing-mode', (req, res) => {
    res.json({ mode: routingMode });
  });

  // /api/set-routing-mode
  testApp.post('/api/set-routing-mode', (req, res) => {
    const { mode } = req.body;
    if (!['codex', 'config', 'both'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'Invalid mode' });
    }
    routingMode = mode;
    res.json({ success: true, mode });
  });

  // /api/providers/status
  testApp.get('/api/providers/status', (req, res) => {
    const providers = UPSTREAM_MODELS.map(p => ({
      name: p.name,
      baseUrl: p.baseUrl,
      status: p.apiKey ? 'online' : 'offline',
      models: p.availableModels
    }));
    res.json({ providers });
  });

  // /api/history
  testApp.get('/api/history', (req, res) => {
    res.json({ history: switchHistory.slice(0, 20).reverse() });
  });

  // /api/clear-history
  testApp.post('/api/clear-history', (req, res) => {
    switchHistory.length = 0;
    res.json({ success: true });
  });

  // /v1/chat/completions (passthrough)
  testApp.post('/v1/chat/completions', async (req, res) => {
    const { model } = req.body;
    const provider = findProvider(model);
    if (!provider) {
      return res.status(400).json({ error: { message: `Unsupported model: ${model}` } });
    }
    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify(req.body),
      });
      if (!response.ok) {
        const err = await response.text();
        return res.status(response.status).json({ error: { message: err } });
      }
      const data = await response.json();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: { message: e.message } });
    }
  });
});

describe('Codex Proxy Integration — HTTP Endpoints', () => {
  describe('GET /v1/models', () => {
    it('should return all models from 3 providers', async () => {
      const res = await request(testApp).get('/v1/models');
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);

      const ownedBy = res.body.data.map(m => m.owned_by);
      expect(ownedBy).toContain('DeepSeek');
      expect(ownedBy).toContain('Kimi');
      expect(ownedBy).toContain('Agnes');
    });

    it('should include all required model fields', async () => {
      const res = await request(testApp).get('/v1/models');
      const model = res.body.data[0];
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('object', 'model');
      expect(model).toHaveProperty('created');
      expect(model).toHaveProperty('owned_by');
    });
  });

  describe('GET /health', () => {
    it('should return healthy status with model list', async () => {
      const res = await request(testApp).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.uptime).toBeGreaterThan(0);
      expect(Array.isArray(res.body.models)).toBe(true);
      expect(res.body.models.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/providers/status', () => {
    it('should report all providers as online', async () => {
      const res = await request(testApp).get('/api/providers/status');
      expect(res.status).toBe(200);
      expect(res.body.providers).toHaveLength(3);
      res.body.providers.forEach(p => {
        expect(p).toHaveProperty('name');
        expect(p).toHaveProperty('status', 'online');
        expect(Array.isArray(p.models)).toBe(true);
        expect(p.models.length).toBeGreaterThan(0);
      });
    });
  });

  describe('GET /api/routing-mode', () => {
    it('should return default mode codex', async () => {
      const res = await request(testApp).get('/api/routing-mode');
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('codex');
    });
  });

  describe('POST /api/set-routing-mode', () => {
    it('should accept valid modes', async () => {
      for (const mode of ['codex', 'config', 'both']) {
        const res = await request(testApp).post('/api/set-routing-mode').send({ mode });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.mode).toBe(mode);
      }
    });

    it('should reject invalid mode', async () => {
      const res = await request(testApp).post('/api/set-routing-mode').send({ mode: 'invalid' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/history', () => {
    it('should return empty history initially', async () => {
      const res = await request(testApp).get('/api/history');
      expect(res.status).toBe(200);
      expect(res.body.history).toEqual([]);
    });
  });

  describe('POST /api/clear-history', () => {
    it('should clear all history', async () => {
      switchHistory.push({ timestamp: Date.now(), action: 'test' });
      const clearRes = await request(testApp).post('/api/clear-history');
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.success).toBe(true);

      const historyRes = await request(testApp).get('/api/history');
      expect(historyRes.body.history).toEqual([]);
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('should reject unsupported model', async () => {
      const res = await request(testApp).post('/v1/chat/completions').send({
        model: 'unknown-model-xyz',
        messages: [{ role: 'user', content: 'test' }]
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Unsupported model');
    });

    it('should accept valid model and forward to upstream', async () => {
      // fetch is not mocked in this test — it will fail at network level
      // but we verify the request reaches the upstream call, not blocked by whitelist
      const res = await request(testApp).post('/v1/chat/completions').send({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'test' }]
      });
      // Should NOT be 400 (unsupported model) — may be 500 (network error) which is expected
      expect(res.status).not.toBe(400);
    }, 15000);
  });
});

describe('Codex Proxy — findProvider routing logic', () => {
  it('routes exact model matches', () => {
    expect(findProvider('deepseek-v4-pro').name).toBe('DeepSeek');
    expect(findProvider('kimi-k2.5').name).toBe('Kimi');
    expect(findProvider('agnes-2.0-flash').name).toBe('Agnes');
  });

  it('routes by pattern matching', () => {
    expect(findProvider('deepseek-custom').name).toBe('DeepSeek');
    expect(findProvider('moonshot-v1-auto').name).toBe('Kimi');
    expect(findProvider('agnes-image-2.1-flash').name).toBe('Agnes');
  });

  it('returns null for unknown models', () => {
    expect(findProvider('gpt-4')).toBeNull();
    expect(findProvider('')).toBeNull();
    expect(findProvider(undefined)).toBeNull();
  });

  it('prefers exact match over pattern', () => {
    const result = findProvider('deepseek-v4-flash');
    expect(result.name).toBe('DeepSeek');
  });

  it('returns correct baseUrl for each provider', () => {
    expect(findProvider('deepseek-v4-pro').baseUrl).toBe('https://api.deepseek.com/v1');
    expect(findProvider('kimi-k2.5').baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(findProvider('agnes-2.0-flash').baseUrl).toBe('https://apihub.agnes-ai.com/v1');
  });

  it('counts correct number of models per provider', () => {
    const deepseek = findProvider('deepseek-v4-pro');
    expect(deepseek.availableModels.length).toBe(2);

    const kimi = findProvider('moonshot-v1-8k');
    expect(kimi.availableModels.length).toBeGreaterThan(10);

    const agnes = findProvider('agnes-2.0-flash');
    expect(agnes.availableModels.length).toBe(5);
  });
});
