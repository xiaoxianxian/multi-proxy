// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// G4 demo：把治理能力登记成可版本化 / 可 eval / 可回滚的技能
const { createSkillVersioning } = require('./skill-versioning.js');

(async () => {
    const sv = createSkillVersioning();

    // 模拟各治理能力的 eval（真实接入时，这里跑各自回归测试套件）
    const evalG1 = async () => ({ pass: 7, total: 7, failed: [] });   // cost-watchdog G1 用例
    const evalG6 = async () => ({ pass: 8, total: 8, failed: [] });   // access-control 用例
    let g6Disabled = false;
    const rollbackG6 = () => { g6Disabled = true; };

    sv.register('cost-watchdog', { version: '1.0.0', evalFn: evalG1 });
    sv.register('cost-watchdog', { version: '1.1.0', evalFn: evalG1 });
    sv.register('access-control', { version: '1.0.0', evalFn: evalG6, rollback: rollbackG6 });

    console.log('== 登记后 list ==');
    console.log(JSON.stringify(sv.list(), null, 2));

    console.log('\n== eval cost-watchdog (current=1.1.0) ==');
    console.log(await sv.evalSkill('cost-watchdog'));

    console.log('\n== eval access-control ==');
    console.log(await sv.evalSkill('access-control'));

    console.log('\n== 回滚 access-control 到 1.0.0 并触发 rollback 钩子 ==');
    sv.rollback('access-control', '1.0.0');
    console.log('g6Disabled after rollback =', g6Disabled);
    console.log('current =', sv.list().find((s) => s.id === 'access-control').current);

    console.log('\n== snapshot（门控关时不落盘，仅返回内存态）==');
    console.log(JSON.stringify(sv.snapshot(), null, 2));
})();
