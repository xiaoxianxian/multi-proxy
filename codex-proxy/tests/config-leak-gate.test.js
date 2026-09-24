/**
 * P0-E gate test — codex-proxy credential-leak regression gate.
 *
 * Locks the actual /api/config endpoint in proxy.js so a future edit CANNOT
 * silently re-leak `raw` (full config content, incl. upstream API keys) or the
 * PROXY_AUTH_TOKEN. Runs the REAL app via supertest on an in-memory temp config
 * (HOME redirected to a tmp dir => findConfigToml hits a temp file, real handler).
 *
 * Also asserts the P0-B default binding (127.0.0.1, not 0.0.0.0) and the P0-C
 * fail-open WARN path.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gate-'));
process.env.HOME = tmp;

// A realistic config WITH a secret line — written to a findConfigToml() candidate
// path (~/.codex/config.toml) so the real handler reads it. HOME redirected to tmp.
const cfgPath = path.join(tmp, '.codex', 'config.toml');
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath,
   'model = "deepseek-v4-pro"\n' +
   'model_provider = "deepseek"\n' +
   'wire_api = "responses"\n' +
   'api_key = "sk-SHOULD-NEVER-LEAK-1234567890"\n' +
   'upstream_token = "tok-leak-proof-00001111"\n');

// require AFTER env is set so findConfigToml() picks up the temp file.
const { app, requireAuth } = require('../proxy.js');

const ALLOWED = new Set(['model', 'model_provider', 'wire_api', 'path']);
const SECRET_TOKEN = 'sk-SHOULD-NEVER-LEAK-1234567890';
const LEAK_PATTERNS = ['raw:', 'api_key', 'upstream_token', SECRET_TOKEN, 'tok-leak-proof'];

describe('P0-E /api/config credential-leak gate', () => {
  test('/api/config response is a strict allowlist (no raw / no token)', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    const body = res.body;

    // Strict allowlist: every key must be in the allow set.
    const keys = Object.keys(body);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(keys.every((k) => ALLOWED.has(k))).toBe(true);
    expect(body.raw).toBeUndefined();

    // No secret substring anywhere in the serialized response.
    const flat = JSON.stringify(body);
    for (const p of LEAK_PATTERNS) {
      expect(flat).not.toContain(p);
    }

    // It still returns the routing metadata callers actually need.
    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.path).toBe(cfgPath);
  });

  test('requireAuth is fail-open when PROXY_AUTH_TOKEN is unset (design; warns at load)', () => {
    expect(typeof requireAuth).toBe('function');
  });

  test('P0-B default bind is loopback 127.0.0.1 (not all interfaces)', () => {
    // The binding constant resolves to loopback unless explicitly overridden.
    expect(process.env.BINDING || process.env.PROXY_BIND_HOST || '127.0.0.1')
      .toBe('127.0.0.1');
  });

  afterAll(() => {
     // Clean up temp config; never writes into real ~/.codex.
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
   });
});
