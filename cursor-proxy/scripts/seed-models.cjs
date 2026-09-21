// scripts/seed-models.cjs — 幂等补 cursor-proxy models 表（消除 D5 路由塌缩）
//
// 背景：B1 灰度（2026-09-21）发现 cursor-proxy `models` 表 0 行时，`findProviderConfig`
//    （chatHandler.ts:165-186，非 round-robin 模式走 models 表）对任意 model fallback 到
//   「最新 created_at 的 provider」→ 当时落到 kimi → 请求 deepseek-v4-pro 等上游不认 → 404。
//   routing_mode=priority（非 round-robin）时这是 100% 路由塌缩。
//
// 权威依据：模型名 → provider type 映射来自代码常量
//   cursor-proxy/src/server/handlers/chatHandler.ts:219-226 MODEL_NAME_TO_PROVIDER_TYPE
//   （非脚本臆造）；models.provider_id 存的是 provider **UUID**（非 type，见 chatHandler.ts:189-192）。
//
// 安全规则：
//   - 写前先备份 data/proxy.db 到 /tmp/db-backup-*（可回滚）
//   - UUID 从 providers 表自身查（不手抄，杜绝错映射 → 重排路由）
//   - 幂等：已存在 (name,provider_id) 则跳过
//   - 事务：要么全插要么全不插
//   - 不写 providers / 不动 routing_mode / 不碰热路径 forward.js & proxy.js
//
// 用法（.cjs 因 cursor-proxy package.json 含 "type":"module"，必须 .cjs 才能跑 CJS）：
//   cd cursor-proxy
//   node scripts/seed-models.cjs          # 补 6 行（已存在则全跳过）
//   # 回滚：从 /tmp/db-backup-*/proxy.db 还原
'use strict';
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'proxy.db');
const db = new Database(DB_PATH);

// 1) type → provider UUID（从 DB 查，每 type 在 providers 唯一）
const typeToUuid = {};
for (const p of db.prepare('SELECT provider_id, id FROM providers').all()) {
  typeToUuid[p.provider_id] = p.id;
}
console.log('type → UUID:');
Object.entries(typeToUuid).forEach(([t, u]) => console.log('     ' + t + ' → ' + u));

// 2) 6 个 model 名 → type（照抄 chatHandler.ts:219-226 MODEL_NAME_TO_PROVIDER_TYPE）
const MODEL_NAME_TO_PROVIDER_TYPE = {
  'deepseek-v4-pro': 'deepseek',
  'deepseek-flash': 'deepseek',
  'agnes-2.5-flash': 'generic',
  'kimi-k2.6': 'openai',
  'kimi-k3': 'openai',
  'qwen3.8:27b-mlx': 'ollama',
};

function now() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
const ts = now();

const upsert = db.transaction((items) => {
  let inserted = 0, skipped = 0;
  for (const item of items) {
    const uuid = typeToUuid[item.type];
    if (!uuid) { console.log('  SKIP ' + item.name + ': type ' + item.type + ' 无对应 provider UUID'); continue; }
    if (db.prepare('SELECT 1 FROM models WHERE name = ? AND provider_id = ?').get(item.name, uuid)) {
      console.log('  SKIP（幂等已存在）' + item.name + ' → ' + uuid.slice(0, 8) + '...');
      skipped++;
      continue;
    }
    db.prepare('INSERT INTO models (id, provider_id, name, enabled, alias, created_at) VALUES (?, ?, ?, 1, NULL, ?)')
      .run(crypto.randomUUID(), uuid, item.name, ts);
    console.log('  INSERT ' + item.name + ' → provider_id=' + uuid.slice(0, 8) + '...');
    inserted++;
  }
  return { inserted, skipped };
});

console.log('');
console.log('=== 补 cursor-proxy models（幂等 + 事务） ===');
const r = upsert(Object.entries(MODEL_NAME_TO_PROVIDER_TYPE).map(([name, type]) => ({ name, type })));
console.log('结果: inserted=' + r.inserted + ' skipped=' + r.skipped);

console.log('');
console.log('=== 验证：models（name → provider） ===');
db.prepare('SELECT m.name, p.name AS provider, p.provider_id AS type FROM models m JOIN providers p ON m.provider_id = p.id AND p.enabled = 1 ORDER BY m.name').all()
  .forEach(x => console.log('     ' + x.name + '    →  provider=' + x.provider + ' (' + x.type + ')'));

console.log('');
console.log('providers enabled 仍 = ' + db.prepare('SELECT COUNT(*) c FROM providers WHERE enabled = 1').get().c + '（未动 providers）');
console.log('integrity: ' + db.prepare('PRAGMA integrity_check').get().integrity_check);
console.log('DONE');

module.exports = { MODEL_NAME_TO_PROVIDER_TYPE, run: upsert };
