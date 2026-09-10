/**
 * Tests for Cursor Multi-Model Proxy SQLite database layer.
 *
 * Tests Provider CRUD, Model CRUD with foreign key constraints,
 * cascade deletes, orphan cleanup, and routes/settings tables.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper: create an in-memory database with the same schema
function createTestDb() {
  const db = new Database(':memory:');

  // Enable WAL and foreign keys (matches database.ts)
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      alias TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
      UNIQUE(provider_id, id)
    );

    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      default_model TEXT NOT NULL,
      fallback_chain TEXT NOT NULL,
      rules TEXT DEFAULT '[]',
      max_retries INTEGER DEFAULT 2,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      proxy TEXT DEFAULT 'system',
      timestamp TEXT DEFAULT (datetime('now')),
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      value_type TEXT DEFAULT 'string'
    );
  `);

  // Apply D1 migration: UNIQUE index on provider_id
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS unique_provider_id ON providers(provider_id)`);

  return db;
}

describe('Cursor SQLite Database Layer', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ==================== Provider CRUD ====================

  describe('Provider CRUD', () => {
    it('creates a provider', () => {
      const stmt = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      stmt.run('prov-001', 'OpenAI', 'openai', 'encrypted-key', 'https://api.openai.com', 1);

      const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get('prov-001');
      expect(provider).toBeDefined();
      expect(provider.name).toBe('OpenAI');
      expect(provider.provider_id).toBe('openai');
      expect(provider.enabled).toBe(1);
    });

    it('creates multiple providers', () => {
      const insert = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);
      insert.run('prov-002', 'Anthropic', 'anthropic', 'key2', 'https://api.anthropic.com', 1);
      insert.run('prov-003', 'Google', 'google', 'key3', 'https://generativelanguage.googleapis.com', 1);

      const providers = db.prepare('SELECT id, name FROM providers ORDER BY name').all();
      expect(providers).toHaveLength(3);
      expect(providers[0].name).toBe('Anthropic');
    });

    it('updates a provider', () => {
      const insert = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      db.prepare("UPDATE providers SET name = ?, updated_at = datetime('now') WHERE id = ?")
        .run('OpenAI Plus', 'prov-001');

      const provider = db.prepare('SELECT name, updated_at FROM providers WHERE id = ?').get('prov-001');
      expect(provider.name).toBe('OpenAI Plus');
      expect(provider.updated_at).toBeDefined();
    });

    it('disables a provider', () => {
      const insert = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      db.prepare('UPDATE providers SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(0, 'prov-001');

      const provider = db.prepare('SELECT enabled FROM providers WHERE id = ?').get('prov-001');
      expect(provider.enabled).toBe(0);
    });

    it('deletes a provider', () => {
      const insert = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      const del = db.prepare('DELETE FROM providers WHERE id = ?');
      const result = del.run('prov-001');
      expect(result.changes).toBe(1);

      const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get('prov-001');
      expect(provider).toBeUndefined();
    });

    it('returns 404 (changes=0) when deleting non-existent provider', () => {
      const del = db.prepare('DELETE FROM providers WHERE id = ?');
      const result = del.run('nonexistent');
      expect(result.changes).toBe(0);
    });

    it('rejects duplicate provider id', () => {
      const insert = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      expect(() => {
        insert.run('prov-001', 'Duplicate', 'openai', 'key2', 'https://api.openai.com', 1);
      }).toThrow();
    });

    it('rejects duplicate provider_id (UNIQUE constraint)', () => {
      const insert = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      expect(() => {
        insert.run('prov-002', 'Duplicate', 'openai', 'key2', 'https://api.dupe.com', 1);
      }).toThrow();
    });

    it('rejects provider with missing required fields', () => {
      const insert = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );

      // Missing api_key
      expect(() => {
        insert.run('prov-001', 'OpenAI', 'openai', null, 'https://api.openai.com', 1);
      }).toThrow();
    });
  });

  // ==================== Model CRUD ====================

  describe('Model CRUD', () => {
    it('creates a model linked to a provider', () => {
      const insertProv = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertProv.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      const insertModel = db.prepare(
        'INSERT INTO models (id, provider_id, name, enabled, alias) VALUES (?, ?, ?, ?, ?)'
      );
      insertModel.run('model-001', 'prov-001', 'gpt-4', 1, 'GPT-4');

      const model = db.prepare('SELECT * FROM models WHERE id = ?').get('model-001');
      expect(model).toBeDefined();
      expect(model.name).toBe('gpt-4');
      expect(model.alias).toBe('GPT-4');
      expect(model.enabled).toBe(1);
    });

    it('lists models joined with provider names', () => {
      // Insert providers
      const insertProv = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertProv.run('prov-oai', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);
      insertProv.run('prov-ant', 'Anthropic', 'anthropic', 'key2', 'https://api.anthropic.com', 1);

      // Insert models
      const insertModel = db.prepare(
        'INSERT INTO models (id, provider_id, name, enabled) VALUES (?, ?, ?, ?)'
      );
      insertModel.run('m1', 'prov-oai', 'gpt-4', 1);
      insertModel.run('m2', 'prov-oai', 'gpt-3.5-turbo', 1);
      insertModel.run('m3', 'prov-ant', 'claude-3', 1);

      const models = db.prepare(`
        SELECT m.*, p.name as provider_name
        FROM models m
        LEFT JOIN providers p ON m.provider_id = p.id
        ORDER BY p.name, m.name
      `).all();

      expect(models).toHaveLength(3);
      expect(models[0].provider_name).toBe('Anthropic');
      expect(models[0].name).toBe('claude-3');
      expect(models[1].name).toBe('gpt-3.5-turbo');
      expect(models[2].name).toBe('gpt-4');
    });

    it('filters enabled models', () => {
      const insertProv = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertProv.run('prov-oai', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      const insertModel = db.prepare(
        'INSERT INTO models (id, provider_id, name, enabled) VALUES (?, ?, ?, ?)'
      );
      insertModel.run('m1', 'prov-oai', 'gpt-4', 1);
      insertModel.run('m2', 'prov-oai', 'gpt-3.5', 0);

      const enabled = db.prepare('SELECT * FROM models WHERE enabled = 1').all();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('gpt-4');
    });
  });

  // ==================== Foreign Key / Cascade Delete (T8) ====================

  describe('Foreign Key Constraints', () => {
    it('enables foreign keys pragma', () => {
      const result = db.prepare("PRAGMA foreign_keys").get();
      expect(result.foreign_keys).toBe(1);
    });

    it('prevents inserting model with non-existent provider_id', () => {
      const insertModel = db.prepare(
        'INSERT INTO models (id, provider_id, name, enabled) VALUES (?, ?, ?, ?)'
      );

      expect(() => {
        insertModel.run('m1', 'nonexistent-provider', 'gpt-4', 1);
      }).toThrow();
    });

    it('cascades delete: models are deleted when provider is deleted', () => {
      const insertProv = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertProv.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      const insertModel = db.prepare(
        'INSERT INTO models (id, provider_id, name, enabled) VALUES (?, ?, ?, ?)'
      );
      insertModel.run('m1', 'prov-001', 'gpt-4', 1);
      insertModel.run('m2', 'prov-001', 'gpt-3.5', 1);

      // Verify models exist
      expect(db.prepare('SELECT COUNT(*) as count FROM models').get()).toEqual({ count: 2 });

      // Delete the provider
      db.prepare('DELETE FROM providers WHERE id = ?').run('prov-001');

      // Models should be cascaded-deleted
      const remaining = db.prepare('SELECT COUNT(*) as count FROM models').get();
      expect(remaining.count).toBe(0);
    });

    it('allows deleting provider with no models', () => {
      const insertProv = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertProv.run('prov-001', 'EmptyProvider', 'openai', 'key1', 'https://api.openai.com', 1);

      const result = db.prepare('DELETE FROM providers WHERE id = ?').run('prov-001');
      expect(result.changes).toBe(1);
    });
  });

  // ==================== Orphan Cleanup (T8) ====================

  describe('Orphan Cleanup', () => {
    it('cleans up orphaned models when FK enforcement is relaxed', () => {
      // Temporarily disable FK enforcement (some SQLite configurations do this)
      db.prepare("PRAGMA foreign_keys = OFF").run();

      const insertProv = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertProv.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      const insertModel = db.prepare(
        'INSERT INTO models (id, provider_id, name, enabled) VALUES (?, ?, ?, ?)'
      );
      insertModel.run('m1', 'prov-001', 'gpt-4', 1);

      // Delete the provider without FK enforcement
      db.prepare('DELETE FROM providers WHERE id = ?').run('prov-001');

      // Model is now orphaned (provider_id doesn't exist)
      const orphans = db.prepare(
        'SELECT COUNT(*) as count FROM models WHERE provider_id NOT IN (SELECT id FROM providers)'
      ).get();
      expect(orphans.count).toBe(1);

      // Run orphan cleanup
      const cleanup = db.prepare(
        'DELETE FROM models WHERE provider_id NOT IN (SELECT id FROM providers)'
      );
      const result = cleanup.run();
      expect(result.changes).toBe(1);

      // No more orphans
      const remaining = db.prepare(
        'SELECT COUNT(*) as count FROM models WHERE provider_id NOT IN (SELECT id FROM providers)'
      ).get();
      expect(remaining.count).toBe(0);
    });

    it('orphan cleanup does nothing when all models are valid', () => {
      const insertProv = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertProv.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);

      const insertModel = db.prepare(
        'INSERT INTO models (id, provider_id, name, enabled) VALUES (?, ?, ?, ?)'
      );
      insertModel.run('m1', 'prov-001', 'gpt-4', 1);

      const result = db.prepare(
        'DELETE FROM models WHERE provider_id NOT IN (SELECT id FROM providers)'
      ).run();
      expect(result.changes).toBe(0);
    });
  });

  // ==================== Routes Table ====================

  describe('Routes Table', () => {
    it('creates a route with JSON fields', () => {
      const stmt = db.prepare(
        'INSERT INTO routes (id, default_model, fallback_chain, rules, max_retries) VALUES (?, ?, ?, ?, ?)'
      );
      stmt.run(
        'route-001',
        'gpt-4',
        JSON.stringify(['gpt-3.5', 'claude-3']),
        JSON.stringify([]),
        2
      );

      const route = db.prepare('SELECT * FROM routes WHERE id = ?').get('route-001');
      expect(route).toBeDefined();
      expect(route.default_model).toBe('gpt-4');
      expect(JSON.parse(route.fallback_chain)).toEqual(['gpt-3.5', 'claude-3']);
    });

    it('returns empty routes list initially', () => {
      const routes = db.prepare('SELECT * FROM routes ORDER BY created_at DESC').all();
      expect(routes).toHaveLength(0);
    });
  });

  // ==================== Settings Table ====================

  describe('Settings Table', () => {
    it('inserts and retrieves settings', () => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('theme', 'dark');
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('language', 'en');

      const rows = db.prepare('SELECT * FROM settings').all();
      const settings: Record<string, string> = {};
      rows.forEach((r: any) => { settings[r.key] = r.value; });

      expect(settings.theme).toBe('dark');
      expect(settings.language).toBe('en');
    });
  });

  // ==================== Health endpoint simulation ====================

  describe('Health Query', () => {
    it('counts providers and enabled models', () => {
      const insertProv = db.prepare(
        'INSERT INTO providers (id, name, provider_id, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertProv.run('prov-001', 'OpenAI', 'openai', 'key1', 'https://api.openai.com', 1);
      insertProv.run('prov-002', 'Disabled', 'local', 'key2', 'http://localhost:8080', 0);

      const insertModel = db.prepare(
        'INSERT INTO models (id, provider_id, name, enabled) VALUES (?, ?, ?, ?)'
      );
      insertModel.run('m1', 'prov-001', 'gpt-4', 1);
      insertModel.run('m2', 'prov-001', 'gpt-3.5', 0);

      const providers = db.prepare('SELECT COUNT(*) as count FROM providers').get();
      const enabledModels = db.prepare('SELECT COUNT(*) as count FROM models WHERE enabled = 1').get();

      expect(providers.count).toBe(2);
      expect(enabledModels.count).toBe(1);
    });
  });
});
