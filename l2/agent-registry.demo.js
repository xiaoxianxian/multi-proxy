'use strict';

// Agent Registry 内核真跑验证（P0 增量 2）
// 演示：内存 CRUD + 能力查询 + 能力注册 + 文件持久化跨实例读回 + 负例。
// 全程零副作用：持久化写 os.tmpdir()/reg-*，绝不写 home / agent 文件。
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { AgentRegistry, newFileStorage } = require('./agent-registry.js');

let n = 0;
const ok = (msg, a) => { assert(a, msg); n += 1; console.log(`PASS  ${msg}`); };

// 1. 内存 CRUD
const r = new AgentRegistry();
const p = r.create({
    id: 'codex-worker', name: 'Codex worker', type: 'codex',
    capabilityTags: ['code', 'writing'], description: 'generic coding',
    maxRounds: 10, contextLength: 131072, costBudget: 100000, version: '1.0.0',
});
ok('create returns profile w/ createdAt+updatedAt', p.createdAt && p.updatedAt);
ok('count==1 after create', r.count() === 1);
ok('list length 1', r.list().length === 1);

r.create({
    id: 'cursor-vision', name: 'Cursor vision', type: 'cursor',
    capabilityTags: ['code', 'vision'], contextLength: 200000, version: '1.0.0',
});

// 2. 能力查询（编排引擎按能力路由的基础）
ok("byCapability('code')==2", r.byCapability('code').length === 2);
ok("byCapability('vision')==1", r.byCapability('vision').length === 1);
ok("byCapability('audio')==0", r.byCapability('audio').length === 0);

// 3. update（不可改 id）
const up = r.update('codex-worker', { maxRounds: 20 });
ok('update maxRounds 10->20', r.get('codex-worker').maxRounds === 20 && up.createdAt === p.createdAt);

// 4. 能力注册（并入，不覆盖旧标签）
r.registerCapabilities('cursor-vision', ['audio']);
const tags = r.get('cursor-vision').capabilityTags;
ok('register add audio', tags.includes('audio'));
ok('register keeps vision', tags.includes('vision'));

// 5. 负例：非法 type / 重复 id / 改 id / get 不存在 / 删不存在
let threw = false;
try { r.create({ id: 'bad', name: 'x', type: 'not-a-type', capabilityTags: [] }); } catch { threw = true; }
ok('invalid type rejected', threw);

threw = false;
try { r.create({ id: 'codex-worker', name: 'dup', type: 'codex', capabilityTags: [] }); } catch { threw = true; }
ok('duplicate id rejected', threw);

threw = false;
try { r.update('codex-worker', { id: 'other', type: 'codex' }); } catch { threw = true; }
ok('cannot change id via update', threw);

threw = false;
try { r.get('nope'); } catch { threw = true; }
ok('get not-found throws', threw);

// 6. remove + 能力查询反映删除
r.remove('cursor-vision');
ok('count==1 after remove', r.count() === 1);
ok("byCapability('audio')==0 after remove", r.byCapability('audio').length === 0);

threw = false;
try { r.remove('cursor-vision'); } catch { threw = true; }
ok('remove not-found throws', threw);

// 7. 文件持久化跨实例（非侵入：写注入 tmp dir，不写 home）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
const r2 = new AgentRegistry({ storage: newFileStorage(tmp) });
r2.create({ id: 'hermes-c', name: 'Hermes', type: 'hermes', capabilityTags: ['writing'], version: '1.0.0' });
const r3 = new AgentRegistry({ storage: newFileStorage(tmp) }); // 新实例从文件读回
ok('file storage persists across instances', r3.get('hermes-c').id === 'hermes-c');
// 持久化文件与 l2/specs/agent-profile.json 同构
const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'agents.json'), 'utf8'));
ok('persisted format has specVersion+entries', persisted.specVersion === '1.0.0' && Array.isArray(persisted.entries));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nDEMO: ALL PASS  (${n} checks)`);
