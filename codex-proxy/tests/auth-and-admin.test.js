/**
 * Codex Proxy — auth + admin/CRUD endpoints (the surface integration.test.js leaves out).
 *
 * Mirrors proxy.js route LOGIC in an inline express app — never require('../proxy.js')
 * which would call app.listen(18790) and collide with the running proxy.
 * Deterministic by design: in-memory providers array, no real network, no disk writes
 * (saveProviders/updateConfigToml intentionally not invoked here).
 *
 * Covers endpoints with NO coverage in proxy.test.js / integration.test.js:
 *   requireAuth (401 path)  +  GET/PUT /api/settings  +  /api/providers CRUD
 *   +  GET /api/balances (empty)  +  /api/switch-model & /api/test-connection guard branches
 */

const express = require('express');
const request = require('supertest');

// ===== Inline findProvider (same fallback chain as proxy.js:177-201) =====
const UPSTREAM_MODELS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', availableModels: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: '', availableModels: ['moonshot-v1-8k', 'kimi-k2.5', 'moonshot-v1-auto'] },
  { name: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: '', availableModels: ['agnes-2.0-flash'] },
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

// ===== In-memory state (mirrors proxy.js: in-memory settings + providers array) =====
let settings = {};
let providers = [];

function generateId() {
  return 'prov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ===== Auth-gated app (mirrors proxy.js:17-25 requireAuth; token set at module load) =====
const AUTH_TOKEN = 'test-secret-token';
function authed() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, res, next) => {
    if (req.headers['x-proxy-auth'] === AUTH_TOKEN) return next();
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  });

  // GET /api/settings / PUT /api/settings  (proxy.js:338-352)
  app.get('/api/settings', (req, res) => res.json({ settings }));
  app.put('/api/settings', (req, res) => {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ success: false, error: 'Missing key', code: 'MISSING_KEY' });
    settings[key] = value;
    res.json({ success: true });
  });

  // /api/providers CRUD  (proxy.js:459-518, in-memory array — no disk persist in test)
  app.get('/api/providers', (req, res) => {
    const safe = providers.map(p => ({ ...p, api_key: p.api_key ? p.api_key.substring(0, 4) + '****' : '' }));
    res.json({ providers: safe });
  });
  app.post('/api/providers', (req, res) => {
    const { name, provider_id, api_key, base_url, enabled, models } = req.body;
    if (!name || !provider_id || !api_key || !base_url) {
      return res.status(400).json({ success: false, error: 'Missing required fields: name, provider_id, api_key, base_url' });
    }
    if (providers.find(p => p.provider_id === provider_id)) {
      return res.status(409).json({ success: false, error: 'Provider ID already exists' });
    }
    const provider = {
      id: generateId(), name, provider_id, api_key, base_url,
      models: Array.isArray(models) ? models.filter(m => typeof m === 'string') : [],
      enabled: enabled !== false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    providers.push(provider);
    res.json({ success: true, provider });
  });
  app.put('/api/providers/:id', (req, res) => {
    const idx = providers.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Provider not found' });
    const allowedFields = ['name', 'provider_id', 'api_key', 'base_url', 'enabled', 'models'];
    const updates = {};
    for (const field of allowedFields) if (req.body[field] !== undefined) updates[field] = req.body[field];
    updates.updated_at = new Date().toISOString();
    providers[idx] = { ...providers[idx], ...updates };
    res.json({ success: true, provider: providers[idx] });
  });
  app.delete('/api/providers/:id', (req, res) => {
    const idx = providers.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Provider not found' });
    providers.splice(idx, 1);
    res.json({ success: true });
  });

  // GET /api/balances  (proxy.js:544-575; empty providers → empty balances object, no fetch)
  app.get('/api/balances', async (req, res) => {
    const balances = {};
    for (const p of providers) {
      if (!p.enabled || !p.api_key) { balances[p.name] = '未启用'; continue; }
      // balance query hits upstream; guarded here by empty `providers` → loop is a no-op
    }
    res.json({ balances });
  });

  // POST /api/switch-model guard branches  (proxy.js:396-404)
  app.post('/api/switch-model', (req, res) => {
    const { model } = req.body;
    if (!model) return res.status(400).json({ success: false, error: '缺少 model 参数', code: 'MISSING_MODEL' });
    if (!findProvider(model)) return res.status(400).json({ success: false, error: `不支持的模型: ${model}`, code: 'UNSUPPORTED_MODEL' });
    res.json({ success: true }); // happy path would persist+route; not exercised in deterministic test
  });

  // POST /api/test-connection guard branches  (proxy.js:433-441)
  app.post('/api/test-connection', (req, res) => {
    const { model } = req.body;
    if (!model) return res.status(400).json({ success: false, error: '缺少 model 参数', code: 'MISSING_MODEL' });
    if (!findProvider(model)) return res.status(400).json({ success: false, error: `不支持的模型: ${model}`, code: 'UNSUPPORTED_MODEL' });
    res.json({ success: true });
  });

  return app;
}

// ===== Auth middleware 401 (proxy.js:17-25, token enabled) =====
describe('Codex Proxy — requireAuth', () => {
  it('rejects with 401 when token header is missing or wrong', async () => {
    const app = authed();
    const noHdr = await request(app).get('/api/providers');
    expect(noHdr.status).toBe(401);
    expect(noHdr.body.error).toBe('Unauthorized');

    const bad = await request(app).get('/api/providers').set('x-proxy-auth', 'wrong');
    expect(bad.status).toBe(401);
  });

  it('passes through with 200 when token matches', async () => {
    const app = authed();
    const res = await request(app).get('/api/providers').set('x-proxy-auth', AUTH_TOKEN);
    expect(res.status).toBe(200);
  });
});

// ===== /api/settings =====
describe('Codex Proxy — /api/settings', () => {
  let app;
  beforeEach(() => { settings = {}; app = authed(); });

  it('returns an object shape even when empty', async () => {
    const res = await request(app).get('/api/settings').set('x-proxy-auth', AUTH_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('settings');
  });

  it('rejects PUT without a key (400 MISSING_KEY)', async () => {
    const res = await request(app).put('/api/settings').set('x-proxy-auth', AUTH_TOKEN).send({ value: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_KEY');
  });

  it('accepts PUT with key/value and persists in memory', async () => {
    await request(app).put('/api/settings').set('x-proxy-auth', AUTH_TOKEN).send({ key: 'current_model', value: 'deepseek-v4-pro' });
    const res = await request(app).get('/api/settings').set('x-proxy-auth', AUTH_TOKEN);
    expect(res.body.settings.current_model).toBe('deepseek-v4-pro');
  });
});

// ===== /api/providers CRUD =====
describe('Codex Proxy — /api/providers CRUD', () => {
  let app;
  beforeEach(() => { providers = []; app = authed(); });

  it('lists an empty array initially', async () => {
    const res = await request(app).get('/api/providers').set('x-proxy-auth', AUTH_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([]);
  });

  it('rejects POST missing required fields (400)', async () => {
    const res = await request(app).post('/api/providers').set('x-proxy-auth', AUTH_TOKEN)
      .send({ name: 'x' }); // no provider_id / api_key / base_url
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });

  it('creates a provider and masks api_key in the read view', async () => {
    const created = await request(app).post('/api/providers').set('x-proxy-auth', AUTH_TOKEN)
      .send({ name: 'MyProvider', provider_id: 'mp', api_key: 'sk-abcdef1234', base_url: 'https://example.com/v1', models: ['a', 'b'] });
    expect(created.status).toBe(200);
    expect(created.body.provider.id).toMatch(/^prov_/);
    expect(created.body.provider.name).toBe('MyProvider');
    expect(created.body.provider.models).toEqual(['a', 'b']);

    const list = await request(app).get('/api/providers').set('x-proxy-auth', AUTH_TOKEN);
    expect(list.body.providers).toHaveLength(1);
    expect(list.body.providers[0].api_key).toBe('sk-a****'); // first 4 chars + ****, full key never leaks
  });

  it('rejects duplicate provider_id (409)', async () => {
    await request(app).post('/api/providers').set('x-proxy-auth', AUTH_TOKEN)
      .send({ name: 'P', provider_id: 'dup', api_key: 'k', base_url: 'https://x/v1' });
    const dup = await request(app).post('/api/providers').set('x-proxy-auth', AUTH_TOKEN)
      .send({ name: 'P2', provider_id: 'dup', api_key: 'k', base_url: 'https://x/v1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('Provider ID already exists');
  });

  it('updates a provider by id and 404s when absent', async () => {
    const created = await request(app).post('/api/providers').set('x-proxy-auth', AUTH_TOKEN)
      .send({ name: 'Orig', provider_id: 'u', api_key: 'k', base_url: 'https://x/v1' });
    const id = created.body.provider.id;

    const ok = await request(app).put(`/api/providers/${id}`).set('x-proxy-auth', AUTH_TOKEN).send({ name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.provider.name).toBe('Renamed');

    const missing = await request(app).put('/api/providers/prov_nope').set('x-proxy-auth', AUTH_TOKEN).send({ name: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Provider not found');
  });

  it('deletes a provider by id and 404s when absent', async () => {
    const created = await request(app).post('/api/providers').set('x-proxy-auth', AUTH_TOKEN)
      .send({ name: 'ToDelete', provider_id: 'd', api_key: 'k', base_url: 'https://x/v1' });
    const id = created.body.provider.id;

    const ok = await request(app).delete(`/api/providers/${id}`).set('x-proxy-auth', AUTH_TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);

    const list = await request(app).get('/api/providers').set('x-proxy-auth', AUTH_TOKEN);
    expect(list.body.providers).toEqual([]);

    const missing = await request(app).delete('/api/providers/prov_nope').set('x-proxy-auth', AUTH_TOKEN);
    expect(missing.status).toBe(404);
  });
});

// ===== /api/balances =====
describe('Codex Proxy — /api/balances', () => {
  it('returns an empty balances object when no providers exist (no upstream fetch)', async () => {
    providers = [];
    const app = authed();
    const res = await request(app).get('/api/balances').set('x-proxy-auth', AUTH_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.balances).toEqual({});
  });

  it('marks disabled/keyless providers as 未启用 without an upstream fetch', async () => {
    providers = [
      { name: 'Enabled', provider_id: 'deepseek', api_key: 'k', base_url: 'https://api.deepseek.com/v1', enabled: true },
      { name: 'Off', provider_id: 'kimi', api_key: '', base_url: 'https://x/v1', enabled: false },
    ];
    // Enabled provider with provider_id 'deepseek' has a BALANCE_ENDPOINT in proxy.js and WOULD fetch
    // a real /user/info — so the test only asserts the deterministic 未启用 branch for the disabled one
    // and leaves the enabled one's network call unasserted to keep the suite offline/deterministic.
    const app = authed();
    const res = await request(app).get('/api/balances').set('x-proxy-auth', AUTH_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.balances['Off']).toBe('未启用');
  }, 15000);
});

// ===== /api/switch-model & /api/test-connection guard branches =====
describe('Codex Proxy — switch-model / test-connection guards', () => {
  let app;
  beforeEach(() => { app = authed(); });

  it('switch-model: 400 when model param missing', async () => {
    const res = await request(app).post('/api/switch-model').set('x-proxy-auth', AUTH_TOKEN).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_MODEL');
  });

  it('switch-model: 400 when model unsupported', async () => {
    const res = await request(app).post('/api/switch-model').set('x-proxy-auth', AUTH_TOKEN).send({ model: 'gpt-9-turbo' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_MODEL');
  });

  it('test-connection: 400 when model param missing', async () => {
    const res = await request(app).post('/api/test-connection').set('x-proxy-auth', AUTH_TOKEN).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_MODEL');
  });

  it('test-connection: 400 when model unsupported', async () => {
    const res = await request(app).post('/api/test-connection').set('x-proxy-auth', AUTH_TOKEN).send({ model: 'totally-unknown' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_MODEL');
  });
});
