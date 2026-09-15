'use strict';
const M = require('../../../l2/skill-service.js');

describe('skill-service', () => {
  const newSvc = () => M.createSkillService({ clock: () => '2026-09-15T00:00:00Z' });
  const base = { name: 'lark-shared', trigger: 'setup', description: 'd', content: 'c', tags: ['auth'] };
  let svc;
  beforeEach(() => { svc = newSvc(); });

  test('CRUD: create defaults version 1.0.0 / enabled true; get/update/remove', () => {
    const c = svc.create(base);
    expect(c.version).toBe('1.0.0');
    expect(c.enabled).toBe(true);
    expect(c.id).toMatch(/^skill-lark/);
    expect(svc.get(c.id).version).toBe('1.0.0');
    expect(svc.update(c.id, { description: 'x' }).version).toBe('1.0.1');
    expect(svc.remove(c.id)).toBe(true);
    expect(() => svc.get(c.id)).toThrow(/not found/);
  });

  test('market: registerBuiltin / upload stamp source', () => {
    svc.registerBuiltin({ ...base, name: 'b1' });
    svc.upload({ ...base, name: 'b2' });
    expect(svc.list({ source: 'builtin' })).toHaveLength(1);
    expect(svc.list({ source: 'custom' })).toHaveLength(1);
  });

  test('bump preserves history (old disabled / new enabled)', () => {
    svc.create({ ...base, name: 'v' });
    svc.bump('v'); svc.bump('v');
    const vs = svc.versions('v');
    expect(vs).toHaveLength(3);
    expect(vs[0].version).toBe('1.0.2');
    expect(vs[0].enabled).toBe(true);
    expect(vs[1].enabled).toBe(false);
  });

  test('rollback flips enable to old version', () => {
    svc.create({ ...base, name: 'rk' });
    svc.bump('rk'); svc.bump('rk');
    svc.rollback('rk', '1.0.0');
    expect(svc.toCapabilities().find((c) => c.name === 'rk').version).toBe('1.0.0');
  });

  test('validate rejects bad version / missing fields', () => {
    expect(() => svc.create({ ...base, version: 'bad' })).toThrow(/X\.Y\.Z/);
    expect(() => svc.create({ name: 'z' })).toThrow(/missing/);
    expect(() => svc.create({ name: 'z2', description: 'd', trigger: 't' })).toThrow(/content/);
  });

  test('list filters by source/tags/enabled + default latest collapses', () => {
    svc.create({ ...base, name: 'm', version: '1.0.0', source: 'custom', tags: ['x'] });
    svc.bump('m', { version: '1.2.0' });
    expect(svc.list({ source: 'custom' })).not.toHaveLength(0);
    expect(svc.list({ tags: ['x'] })).toHaveLength(1);
    expect(svc.list({ name: 'm' })).toHaveLength(1); // latest fold
  });

  test('search matches case-insensitive substring', () => {
    svc.create({ ...base, name: 'search' });
    expect(svc.search('SEARCH').length).toBe(1);
   });

  test('non-invasive: no process.env / no fs', () => {
    const before = process.env.SKILL_LEAK_TEST;
    svc.create({ ...base, name: 'ni1' });
    svc.create({ ...base, name: 'ni2' });
    expect(process.env.SKILL_LEAK_TEST).toBeUndefined();
    expect(before).toBeUndefined();
    expect(svc._store.entries.length).toBe(2);
   });

  test('json adapter roundtrip', () => {
    svc.create(base);
    const doc = { specVersion: '1.0.0', entries: svc.list() };
    expect(M.getAdapters().json.fromDoc(M.getAdapters().json.toDoc(doc)).entries.length).toBe(1);
  });

  test('yaml-text adapter roundtrip', () => {
    svc.create({ ...base, name: 'y' });
    const doc = { specVersion: '1.0.0', entries: svc.list() };
    const text = M.getAdapters()['yaml-text'].toDoc(doc);
    expect(text).toContain('id: skill-y');
    expect(M.getAdapters()['yaml-text'].fromDoc(text).entries).toHaveLength(1);
  });

  test('view adapter omits content', () => {
    svc.create({ ...base, name: 'v' });
    const doc = { specVersion: '1.0.0', entries: svc.list() };
    expect(M.getAdapters().view.toDoc(doc).entries[0]).not.toHaveProperty('content');
  });

  test('registerAdapter validation + hotplug csv', () => {
    expect(() => M.registerAdapter('x', {})).toThrow(/required/);
    M.registerAdapter('csvtest', {
      name: 'csvtest',
      toDoc: (r) => (r.entries || r).map((e) => `${e.name},${e.version}`).join('\n'),
      fromDoc: (t) => String(t).split('\n').filter(Boolean).map((l) => {
        const [name, version] = l.split(','); return { name, version };
      }),
    });
    svc.create({ ...base, name: 'csvr' });
    expect(M.getAdapters().csvtest.toDoc({ specVersion: '1.0.0', entries: svc.list() })).toContain('csvr,1.0.0');
   });

  test('toCapabilities projects latest enabled version', () => {
    svc.create({ ...base, name: 'cap' });
    svc.bump('cap', { version: '1.1.0' });
    expect(svc.toCapabilities().find((c) => c.name === 'cap').version).toBe('1.1.0');
  });
});
