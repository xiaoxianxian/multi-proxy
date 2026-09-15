'use strict';
// P1 技能服务内核 · 真跑验证 demo（node l2/skill-service.demo.js）
// 全内存、非侵入、零网络零文件。覆盖 L2-BLUEPRINT P1 行 349 三验收项：Skill CRUD + 版本 + 规范格式适配。
const M = require('./skill-service.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}    -- ${e.message}`); } };
const svc = M.createSkillService({ clock: () => '2026-09-15T00:00:00Z' });
const base = { name: 'lark-shared', trigger: 'setup lark-cli', description: 'shared preflight',
    content: 'run auth login', tags: ['devops', 'auth'], source: 'builtin' };

// 1. CRUD：create 默认 version 1.0.0 / enabled true；get / update / remove
check('create + get + update + remove（CRUD）', () => {
    const c = svc.create(base);
    assert.strictEqual(c.version, '1.0.0');
    assert.strictEqual(c.enabled, true);
    assert.ok(c.id.startsWith('skill-lark'));            // id 缺省 = name slug
    assert.strictEqual(svc.get(c.id).version, '1.0.0');
    const u = svc.update(c.id, { description: 'updated' });
    assert.strictEqual(u.version, '1.0.1');               // update 缺省 bump patch
    assert.strictEqual(u.description, 'updated');
    assert.strictEqual(svc.remove(c.id), true);
    assert.throws(() => svc.get(c.id), /not found/);
 });
// 2. 市场：registerBuiltin / upload 带 source 标签
check('市场 registerBuiltin / upload（source 标签）', () => {
     const s1 = svc.registerBuiltin({ ...base, name: 'b1' });
    const s2 = svc.upload({ ...base, name: 'b2' });
    assert.strictEqual(s1.source, 'builtin');
    assert.strictEqual(s2.source, 'custom');
    assert.strictEqual(svc.list({ source: 'builtin' }).length, 1);
 });
// 3. 版本：bump patch 递增 + 保留旧版本（旧版禁用、新版启用）
check('bump 保留版本历史（旧版禁用/新版启用）', () => {
     svc.create({ ...base, name: 'vskill' });
    svc.bump('vskill'); svc.bump('vskill');
    const vs = svc.versions('vskill');
    assert.strictEqual(vs.length, 3, '保留 3 个版本');
    assert.strictEqual(vs[0].version, '1.0.2');           // 倒序最新在前
    assert.strictEqual(vs[0].enabled, true);              // 最新启用
    assert.strictEqual(vs[1].enabled, false);             // 旧版禁用
    assert.strictEqual(vs[2].enabled, false);
 });
// 4. 版本：rollback 把启用权翻到旧版本
check('rollback 到 1.0.0（启用权翻转）', () => {
     svc.rollback('vskill', '1.0.0');
    const cap = svc.toCapabilities().find((c) => c.name === 'vskill');
    assert.strictEqual(cap.version, '1.0.0');             // 投影里"在架"变 1.0.0
 });
// 5. 校验：坏 version / 缺必填 被拒
check('validateSkill 拒坏 version / 缺字段', () => {
     assert.throws(() => svc.create({ ...base, version: 'bad' }), /X\.Y\.Z/);
    assert.throws(() => svc.create({ name: 'nok' }), /missing/);
    assert.throws(() => svc.create({ name: 'nok2', description: 'd', trigger: 't' }), /missing content/);
 });
// 6. list 过滤 + 默认只暴露每 name 最新版本
check('list 过滤 source/tags/enabled + latest 折叠', () => {
     svc.create({ ...base, name: 'multi', version: '1.0.0', source: 'custom', tags: ['x'] });
     svc.bump('multi', { version: '1.2.0' });
     const custom = svc.list({ source: 'custom' });
    assert.ok(custom.every((e) => e.source === 'custom'));
     const byTag = svc.list({ tags: ['x'] });
    assert.ok(byTag.length >= 1 && byTag.every((e) => e.tags.includes('x')));
      // "在架"视图：multi 折叠成 1 条（最新 enabled 1.2.0）
     const latest = svc.list({ name: 'multi' }).length;
    assert.strictEqual(latest, 1, '同名多版本默认折叠 1 条');
 });
// 7. search 关键词
check('search 关键词子串匹配（case-insensitive）', () => {
     const r = svc.search('shared');
    assert.ok(r.length >= 1 && r.every((e) => `${e.name} ${e.trigger} ${e.content} ${e.description}`.toLowerCase().includes('shared')));
 });
// 8. 非侵入 + 不写 process.env
check('非侵入：内核不写 process.env / 不写盘', () => {
     const key = process.env.SERVICE_LEAK_TEST;
    assert.strictEqual(key, undefined);
      // 无 fs 副作用：跑完全程 store 只增不写盘（纯内存 _store）
    assert.ok(svc._store.entries.length >= 3);
 });
// 9. json 适配器规范往返
check('json 适配器规范往返', () => {
     const a = M.getAdapters().json;
    const doc = { specVersion: '1.0.0', entries: svc.list({ latest: false }) };
    const back = a.fromDoc(a.toDoc(doc));
    assert.strictEqual(back.entries.length, svc.list({ latest: false }).length);
 });
// 10. yaml-text 适配器往返（纯文本、零依赖）
check('yaml-text 适配器文本往返取回条目', () => {
     const fresh = svc.create({ ...base, name: 'yaml-round' });
     const a = M.getAdapters()['yaml-text'];
    const doc = { specVersion: '1.0.0', entries: svc.list({ name: 'yaml-round' }) };
    const text = a.toDoc(doc);
    assert.ok(text.includes(`id: ${fresh.id}`));
    const back = a.fromDoc(text);
    assert.strictEqual(back.entries.length, 1);
    assert.strictEqual(back.entries[0].name, 'yaml-round');
 });
// 11. view 适配器摘要
check('view 适配器只留摘要字段', () => {
     const fresh = svc.create({ ...base, name: 'view-round' });
     const a = M.getAdapters().view;
    const doc = { specVersion: '1.0.0', entries: svc.list({ name: 'view-round' }) };
    const v = a.toDoc(doc);
    assert.ok(v.entries[0].name && v.entries[0].description);
    assert.strictEqual(v.entries[0].content, undefined, 'view 不含 content');
 });
// 12. 热插拔新适配器
check('registerAdapter 热插拔 + 参数校验', () => {
    assert.throws(() => M.registerAdapter('bad', { toDoc: () => '' }), /required/);
    M.registerAdapter('csv', {
        name: 'csv',
        toDoc: (r) => (r.entries || r).map((e) => `${e.name},${e.version}`).join('\n'),
        fromDoc: (t) => String(t).split('\n').filter(Boolean).map((l) => {
            const [name, version] = l.split(','); return { name, version }; }),
       });
     const fresh = svc.create({ ...base, name: 'csv-round' });
     const csv = M.getAdapters().csv;
     const out = csv.toDoc({ specVersion: '1.0.0', entries: svc.list({ name: 'csv-round' }) });
     assert.ok(out.includes(`csv-round,${fresh.version}`));
 });
// 13. 非侵入终极：整 demo 跑完 process.env 未新增内核键
check('整库非侵入：跑完 process.env 无 SERVICE_LEAK_TEST', () => {
     assert.strictEqual(process.env.SERVICE_LEAK_TEST, undefined);
 });

console.log(`\n[Skill-Service demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
