import { Router, Request, Response } from 'express';
import { db } from '../../db/database.js';
import crypto from 'crypto';
import { SecretsManager, getEncryptionKey } from '../../utils/crypto.js';

const router = Router();
const secrets = new SecretsManager();

// ==================== Provider CRUD ====================

// GET /admin-api/providers
router.get('/providers', (_req: Request, res: Response) => {
  const providers = db.prepare('SELECT * FROM providers ORDER BY name ASC').all();
  // Mask API keys for display
  const safe = providers.map((p: any) => ({
    ...p,
    api_key: p.api_key ? p.api_key.slice(0, 4) + '****' : '(empty)',
  }));
  res.json({ providers: safe });
});

// POST /admin-api/providers
router.post('/providers', (req: Request, res: Response) => {
  const { id: rawId, name, provider_id, api_key, base_url, enabled } = req.body;
  if (!name || !provider_id || !api_key || !base_url) {
    res.status(400).json({ success: false, error: 'Missing required fields: name, provider_id, api_key, base_url', code: 'MISSING_FIELDS' });
    return;
  }
  const id = rawId || crypto.randomUUID();
  try {
    const encKey = secrets.encrypt(api_key);
    const stmt = db.prepare(`INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)`);
    stmt.run(id, name, provider_id, encKey, base_url, enabled ? 1 : 0);
    res.json({ success: true, id });
  } catch (e: any) {
    res.status(409).json({ success: false, error: e.message, code: 'DUPLICATE_PROVIDER' });
  }
});

// PUT /admin-api/providers/:id — D4: fixed dynamic SQL injection.
// Only allows a strict whitelist of columns and uses parameterized queries.
router.put('/providers/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const body = req.body;

  const allowedColumns = ['name', 'provider_id', 'api_key', 'base_url', 'enabled'];
  const safeBody: Record<string, unknown> = {};

  for (const col of allowedColumns) {
    if (!(col in body)) continue;
    const val = body[col];
    if (val === undefined || val === null) continue;
    safeBody[col] = val;
  }

  const keys = Object.keys(safeBody);
  if (keys.length === 0) {
    res.status(400).json({ success: false, error: 'No valid fields to update', code: 'EMPTY_UPDATE' });
    return;
  }

  // Build parameterized UPDATE with explicit column mapping.
  const updates: string[] = [];
  const values: unknown[] = [];

  if ('name' in safeBody)            { updates.push('name = ?');             values.push(safeBody.name); }
  if ('provider_id' in safeBody)     { updates.push('provider_id = ?');      values.push(safeBody.provider_id); }
  if ('api_key' in safeBody)         { updates.push('api_key = ?');          values.push(secrets.encrypt(String(safeBody.api_key))); }
  if ('base_url' in safeBody)        { updates.push('base_url = ?');         values.push(safeBody.base_url); }
  if ('enabled' in safeBody)         { updates.push('enabled = ?');          values.push(safeBody.enabled ? 1 : 0); }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE providers SET ${updates.join(', ')} WHERE id = ?`;
  const result = db.prepare(sql).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ success: false, error: 'Provider not found', code: 'PROVIDER_NOT_FOUND' });
    return;
  }
  res.json({ success: true });
});

// DELETE /admin-api/providers/:id
router.delete('/providers/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM providers WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ success: false, error: 'Provider not found', code: 'PROVIDER_NOT_FOUND' });
    return;
  }
  res.json({ success: true });
});

// ==================== Model CRUD ====================

// GET /admin-api/models
router.get('/models', (_req: Request, res: Response) => {
  const models = db.prepare(`
    SELECT m.*, p.name as provider_name
    FROM models m
    LEFT JOIN providers p ON m.provider_id = p.id
    ORDER BY p.name, m.name
  `).all();
  res.json({ models });
});

// POST /admin-api/models
router.post('/models', (req: Request, res: Response) => {
  const { id, provider_id, name, enabled, alias } = req.body;
  if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    res.status(400).json({ success: false, error: 'Invalid model id format (allowed: a-zA-Z0-9_- up to 128 chars)', code: 'INVALID_ID' });
    return;
  }
  if (!provider_id || !name) {
    res.status(400).json({ success: false, error: 'Missing required fields: provider_id, name', code: 'MISSING_FIELDS' });
    return;
  }
  db.prepare('INSERT INTO models (id, provider_id, name, enabled, alias) VALUES (?, ?, ?, ?, ?)').run(
    id, provider_id, name, enabled ? 1 : 0, alias || null
  );
  res.json({ success: true });
});

// DELETE /admin-api/models/:id
router.delete('/models/:id', (req: Request, res: Response) => {
  db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==================== Route CRUD ====================

// GET /admin-api/routes
router.get('/routes', (_req: Request, res: Response) => {
  const routes = db.prepare('SELECT * FROM routes ORDER BY created_at DESC').all();
  res.json({ routes });
});

// POST /admin-api/routes
router.post('/routes', (req: Request, res: Response) => {
  const { id, default_model, fallback_chain, rules, max_retries } = req.body;
  db.prepare('INSERT INTO routes (id, default_model, fallback_chain, rules, max_retries) VALUES (?, ?, ?, ?, ?)').run(
    id, default_model, JSON.stringify(fallback_chain || []), JSON.stringify(rules || []), max_retries || 2
  );
  res.json({ success: true });
});

// ==================== Logs ====================

// GET /admin-api/logs
router.get('/logs', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const logs = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?').all(limit);
  const logsFormatted = (logs as any[]).map((l: any) => {
    const proxyField = l.proxy ? `[${l.proxy}] ` : '';
    return `[${l.timestamp}] ${proxyField}${l.level}: ${l.message}`;
  }).join('\n');
  res.json({ logs: logsFormatted });
});

// ==================== Health ====================

// GET /admin-api/health
router.get('/health', (_req: Request, res: Response) => {
  const providers = db.prepare('SELECT * FROM providers').all();
  const models = db.prepare('SELECT * FROM models WHERE enabled = 1').all();
  res.json({
    status: 'ok',
    providers: providers.length,
    models: models.length,
  });
});

// ==================== Settings ====================

// GET /admin-api/settings
router.get('/settings', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings: Record<string, unknown> = {};
  (rows as any[]).forEach(r => {
    const v = r.value;
    const t = r.value_type || 'string';
    if (t === 'number') settings[r.key] = Number(v);
    else if (t === 'boolean') settings[r.key] = v === 'true';
    else if (t === 'json') settings[r.key] = JSON.parse(v);
    else settings[r.key] = v;
  });
  res.json({ settings });
});

// PUT /admin-api/settings
router.put('/settings', (req: Request, res: Response) => {
  const { key, value, value_type } = req.body;
  let stringValue: string;
  let valueType = value_type || 'string';
  if (typeof value === 'number') {
    stringValue = String(value);
    valueType = 'number';
  } else if (typeof value === 'boolean') {
    stringValue = value ? 'true' : 'false';
    valueType = 'boolean';
  } else if (typeof value === 'object') {
    stringValue = JSON.stringify(value);
    valueType = 'json';
  } else {
    stringValue = String(value);
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)').run(key, stringValue, valueType);
  res.json({ success: true });
});

export { router };
