// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

const W = require('../../../l2/skill-versioning/skill-versioning.js');

describe('G4 skill-versioning', () => {
    test('register + list 基础登记', () => {
        const sv = W.createSkillVersioning();
        sv.register('cost-watchdog', { version: '1.0.0', evalFn: async () => ({ pass: 7, total: 7, failed: [] }) });
        const list = sv.list();
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('cost-watchdog');
        expect(list[0].current).toBe('1.0.0');
        expect(list[0].versions[0].hasEval).toBe(true);
    });

    test('同 id 同 version 重复登记抛错', () => {
        const sv = W.createSkillVersioning();
        sv.register('a', { version: '1.0.0' });
        expect(() => sv.register('a', { version: '1.0.0' })).toThrow();
    });

    test('tagVersion 切换 current + 校验版本存在', () => {
        const sv = W.createSkillVersioning();
        sv.register('a', { version: '1.0.0' });
        sv.register('a', { version: '2.0.0' });
        sv.tagVersion('a', '2.0.0');
        expect(sv.list().find((s) => s.id === 'a').current).toBe('2.0.0');
        expect(() => sv.tagVersion('a', '9.9.9')).toThrow();
    });

    test('evalSkill 跑当前版本 eval 返回 pass/total', async () => {
        const sv = W.createSkillVersioning();
        sv.register('a', { version: '1.0.0', evalFn: async () => ({ pass: 3, total: 4, failed: ['x'] }) });
        const r = await sv.evalSkill('a');
        expect(r.evaluated).toBe(true);
        expect(r.pass).toBe(3);
        expect(r.total).toBe(4);
        expect(r.failed).toEqual(['x']);
    });

    test('evalSkill 无 eval fn 返回 evaluated:false', async () => {
        const sv = W.createSkillVersioning();
        sv.register('a', { version: '1.0.0' });
        const r = await sv.evalSkill('a');
        expect(r.evaluated).toBe(false);
        expect(r.reason).toBe('no eval fn');
    });

    test('evalSkill 异常被捕获为 failed', async () => {
        const sv = W.createSkillVersioning();
        sv.register('a', { version: '1.0.0', evalFn: async () => { throw new Error('boom'); } });
        const r = await sv.evalSkill('a');
        expect(r.error).toBe(true);
        expect(r.failed[0]).toContain('boom');
    });

    test('rollback 切版本并触发 rollback 钩子', () => {
        const sv = W.createSkillVersioning();
        let rolled = false;
        sv.register('a', { version: '1.0.0', rollback: () => { rolled = true; } });
        sv.register('a', { version: '2.0.0' });
        sv.tagVersion('a', '2.0.0');
        sv.rollback('a', '1.0.0');
        expect(sv.list().find((s) => s.id === 'a').current).toBe('1.0.0');
        expect(rolled).toBe(true);
    });

    test('rollback 默认回最早版本', () => {
        const sv = W.createSkillVersioning();
        sv.register('a', { version: '1.0.0' });
        sv.register('a', { version: '2.0.0' });
        sv.rollback('a');
        expect(sv.list().find((s) => s.id === 'a').current).toBe('1.0.0');
    });

    test('未注册技能 eval/rollback 报错', async () => {
        const sv = W.createSkillVersioning();
        await expect(sv.evalSkill('nope')).resolves.toMatchObject({ registered: false });
        expect(() => sv.rollback('nope')).toThrow();
    });
});
