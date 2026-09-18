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

// 3. modelType 字段（可选）
r.create({
    id: 'hermes-multimodal', name: 'Hermes Multimodal', type: 'hermes',
    capabilityTags: ['vision', 'image', 'video'], modelType: 'multimodal', version: '1.0.0',
});
ok('modelType 可选字段写入', r.get('hermes-multimodal').modelType === 'multimodal');

// 4. byModelType 查询
ok("byModelType('multimodal')==1", r.byModelType('multimodal').length === 1);
ok("byModelType('text')==0（无显式设置）", r.byModelType('text').length === 0);

// 5. 能力查询（编排引擎按能力路由的基础）
ok("byCapability('code')==2", r.byCapability('code').length === 2);
ok("byCapability('vision')==2（cursor-vision + hermes-multimodal）", r.byCapability('vision').length === 2);
ok("byCapability('audio')==0", r.byCapability('audio').length === 0);

// 6. modelTier 字段（complexity 路由档位，可选校验 + byTier 查询，见 COMPLEXITY-MODE.md）
r.create({
    id: 'agnes-small', name: 'Agnes small', type: 'custom',
    capabilityTags: ['text', 'image'], modelTier: 'small', version: '1.0.0',
});
r.create({
    id: 'deepseek-medium', name: 'DeepSeek medium', type: 'custom',
    capabilityTags: ['code', 'review'], modelTier: 'medium', version: '1.0.0',
});
ok('modelTier 可选字段写入', r.get('agnes-small').modelTier === 'small');
ok("byTier('small')==1", r.byTier('small').length === 1);
ok("byTier('medium')==1", r.byTier('medium').length === 1);
ok("byTier('large')==0", r.byTier('large').length === 0);
// 向后兼容：旧 profile 无 modelTier → 不参与 byTier，但仍正常路由
ok("byTier('text')==0（无显式 tier，向后兼容）", r.byTier('text').length === 0);
ok("byTier('medium') 不含旧 profile codex-worker", !r.byTier('medium').some((p) => p.id === 'codex-worker'));

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
// 共 create 5 个（codex-worker/cursor-vision/hermes-multimodal/agnes-small/deepseek-medium），删 1 个剩 4
ok('count==4 after remove', r.count() === 4);
ok("byCapability('audio')==0 after remove", r.byCapability('audio').length === 0);

// 7. modelType 非法值拒绝
threw = false;
try { r.create({ id: 'bad-model', name: 'x', type: 'codex', capabilityTags: [], modelType: 'invalid' }); } catch { threw = true; }
ok('invalid modelType rejected', threw);

// 8. 文件持久化跨实例（非侵入：写注入 tmp dir，不写 home）
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
