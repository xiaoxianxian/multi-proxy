// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../../data/proxy.db');

export const db: BetterSqlite3Database = new Database(DB_PATH);

// 启用 WAL 模式提升并发性能
db.pragma('journal_mode = WAL');

// 启用外键约束以确保引用完整性
db.pragma('foreign_keys = ON');

// D10: Checkpoint WAL on startup to prevent stale WAL file residue after crashes
try {
  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('[DB] WAL checkpoint completed on startup.');
} catch (e) {
  console.warn('[DB] WAL checkpoint failed:', (e as Error).message);
}

// 创建数据库表
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

   -- P0-2 路由反馈闭环：shadow 观测落库（门控 PROXY_ROUTING_FEEDBACK=1，默认关）。
   -- 记录每次 shadow 计算出的「引擎会选谁」+ 真实转发后的运行时元数据；纯加性，不改现有表，门控关时本表不写。
  CREATE TABLE IF NOT EXISTS routing_feedback (
    id INTEGER PRIMARY KEY,
    task_type TEXT NOT NULL,
    model TEXT NOT NULL,
    suggestion TEXT,           -- 引擎建议的模型（null=建议与默认同）
    default_model TEXT,
    latency_ms REAL,           -- 真实转发耗时（ms），转发前为 null，转发后 UPDATE 补
    output_tokens INTEGER,
    retried INTEGER DEFAULT 0,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
`);

// ==================== Migrations ====================

// D2: Ensure settings has value_type column (added for round-robin persistence).
// Older databases created before value_type existed only have (key, value).
(function ensureSettingsValueType() {
  const cols = db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>;
  if (!Array.isArray(cols) || cols.length === 0) return; // table not created yet
  if (cols.some(c => c.name === 'value_type')) return; // already migrated
  try {
    db.prepare("ALTER TABLE settings ADD COLUMN value_type TEXT DEFAULT 'string'").run();
    console.log('[DB] Added value_type column to settings table.');
  } catch (e) {
    console.warn('[DB] Could not add settings.value_type:', (e as Error).message);
  }
})();

// D1: Ensure providers has UNIQUE(provider_id).
// SQLite cannot add a UNIQUE constraint via ALTER TABLE, so we check whether the
// index already exists and recreate the table only when needed.
(function ensureProviderUniqueIndex() {
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string }>;

  // If a non-auto index covers provider_id, the constraint already exists.
  if ((indexes as any[]).some(i => i.name === 'unique_provider_id')) {
    return; // already migrated
  }

  // Check whether provider_id values are unique before adding constraint.
  const duplicateCount = db.prepare(`
    SELECT COUNT(*) AS dup FROM (
      SELECT provider_id, COUNT(*) AS c
      FROM providers
      GROUP BY provider_id
      HAVING c > 1
    )
  `).get() as { dup: number };

  if (duplicateCount.dup! > 0) {
    console.warn('[DB] Duplicate provider_id values exist; skipping UNIQUE constraint.');
    return;
  }

  // Use CREATE INDEX — SQLite treats a UNIQUE index as the constraint enforcement.
  try {
    db.prepare('CREATE UNIQUE INDEX unique_provider_id ON providers(provider_id)').run();
    console.log('[DB] Added UNIQUE(provider_id) index to providers table.');
  } catch (e) {
    console.warn('[DB] Could not create UNIQUE index:', (e as Error).message);
  }
})();

// D3: Hot-path indexes.
// - logs.timestamp: adminRoutes 按 ORDER BY timestamp DESC 查询、下方 30 天清理按范围删除，均全表扫描
// - models.name: chatHandler 每次聊天请求 WHERE m.name = ? AND m.enabled = 1，热路径全表扫描
try {
  db.prepare('CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_models_name ON models(name)').run();
} catch (e) {
  console.warn('[DB] Could not create indexes:', (e as Error).message);
}

// D4: Clean up logs older than 30 days at startup.
try {
  const result = db.prepare(
    "DELETE FROM logs WHERE timestamp < datetime('now', '-30 days')"
  ).run();
  if (result.changes > 0) {
    console.log(`[DB] Cleaned up ${result.changes} log(s) older than 30 days.`);
  }
} catch (e) {
  // Best-effort; non-critical.
  console.warn('[DB] Log cleanup skipped:', (e as Error).message);
}

// 清理孤儿记录（models 中外 provider_id 指向已删除的 providers）
try {
  const orphanResult = db.prepare(`
    DELETE FROM models WHERE provider_id NOT IN (SELECT id FROM providers)
  `).run();
  if (orphanResult.changes > 0) {
    console.log(`[DB] Cleaned up ${orphanResult.changes} orphaned model(s)`);
  }
} catch (e) {
  // Best-effort: non-critical migration
  console.warn('[DB] Orphan cleanup skipped:', (e as Error).message);
}
