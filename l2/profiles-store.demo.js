// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 profiles-store demo — 验证 P2-new：配置快照 + 原子切换
// （原子写 / 写前命名备份 / 写前外部改动检测 sha256 / 失败回滚 / 门控默认关 no-op）
// 注：只写 demo 自己的 tmp 文件，绝不碰任何 agent 配置（~/.codex / ~/.cursor / ~/.hermes 等）。

const { createProfilesStore } = require('./profiles-store.js');
const os = require('os');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log(`✓ ${name}`); }
    catch (e) { fail++; console.log(`✗ ${name}     -- ${e.message}`); }
};

console.log('[Profiles-Store Demo] Starting...');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `profiles-store-demo-${process.pid}-`));
const tmpFile = path.join(dir, 'profiles.json');
const bakFiles = () => fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } };

// T1 门控关（默认）：save / switchTo 全 no-op，不落任何文件
check('T1 门控关 → save / switchTo 全 no-op，零副作用', () => {
    const s = createProfilesStore({ file: tmpFile, enabled: false });
    const r1 = s.save('default', { providers: ['a'] });
    if (r1.written !== false || r1.reason !== 'gate-closed') throw new Error('save 未 no-op');
    const r2 = s.switchTo('default');
    if (r2.switched !== false || r2.reason !== 'gate-closed') throw new Error('switchTo 未 no-op');
    if (fs.existsSync(tmpFile)) throw new Error('门控关却落了文件');
    if (bakFiles().length !== 0) throw new Error('门控关却写了 .bak');
});

// T2 保存 + 读回 + list（门控开）
let s2;
check('T2 门控开 → save 落盘 + load(name) 读回 + list 可见', () => {
    s2 = createProfilesStore({ file: tmpFile, enabled: true });
    const r = s2.save('default', { providers: ['codex'], current: 'codex' });
    if (r.written !== true) throw new Error('save 失败: ' + r.reason);
    const got = s2.load('default');
    if (!got || got.snapshot.current !== 'codex') throw new Error('load 读回不一致');
    if (got.active !== true) throw new Error('首个 profile 未自动成为当前');
    const l = s2.list();
    if (l.names.join(',') !== 'default' || l.active !== 'default') throw new Error('list 不符: ' + JSON.stringify(l));
    if (s2.load('nope') !== null) throw new Error('不存在的 profile 应 null');
});

// T3 切换原子性：写前备份 + 原子替换，切换前后两份快照都能读回
check('T3 切换原子性 → 写前 .bak 备份 + from/to 正确 + 前后都能读回', () => {
    const rA = s2.save('alpha', { providers: ['alpha'] });
    if (rA.written !== true) throw new Error('save alpha 失败');
    if (s2.switchTo('alpha').switched !== true) throw new Error('switchTo alpha 失败');
    const rB = s2.save('beta', { providers: ['beta'] });
    if (rB.written !== true || rB.backedUp !== true) throw new Error('save beta 应写前备份');
    if (bakFiles().length < 1) throw new Error('.bak-<ts> 备份文件未生成');
    const sw = s2.switchTo('beta');
    if (sw.switched !== true || sw.from !== 'alpha' || sw.to !== 'beta') throw new Error('switchTo 结果不符: ' + JSON.stringify(sw));
    if (sw.backedUp !== true) throw new Error('切换前未备份');
    const now = s2.load();                          // 当前 = beta
    if (!now || now.name !== 'beta' || now.snapshot.providers[0] !== 'beta') throw new Error('切换后当前 profile 不是 beta');
    const old = s2.load('alpha');                   // 切换前的仍可读回
    if (!old || old.snapshot.providers[0] !== 'alpha' || old.active !== false) throw new Error('切换前 profile 读不回');
    const l = s2.list();
    if (l.names.join(',') !== 'alpha,beta,default' || l.active !== 'beta') throw new Error('list 不符: ' + JSON.stringify(l));
});

// T4 切换失败 → 回滚（自检不通过视为落盘失败）：盘上 active 不变、内容哈希还原
check('T4 切换失败 → 回滚，盘上 active 与内容哈希还原', () => {
    const before = fs.readFileSync(tmpFile, 'utf8');
    const bad = createProfilesStore({ file: tmpFile, enabled: true, verifyWrite: () => false });
    const sw = bad.switchTo('alpha');
    if (sw.switched !== false || sw.reason !== 'verify-failed' || sw.rolledBack !== true) throw new Error('未按预期回滚: ' + JSON.stringify(sw));
    if (fs.readFileSync(tmpFile, 'utf8') !== before) throw new Error('回滚后内容不一致');
    if (s2.active() !== 'beta') throw new Error('回滚后 active 被改成了 ' + s2.active());
});

// T5 外部改动检出：盘上被外部改写 → save 拒绝（不静默覆盖）+ load 报 externalModified
check('T5 外部改动被检出 → save 拒写 external-change，load 报 externalModified', () => {
    const doc = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    doc.profiles.beta = { providers: ['手写改过'] };
    fs.writeFileSync(tmpFile, JSON.stringify(doc, null, 2)); // 模拟外部进程/人手改
    const r = s2.save('gamma', { providers: ['gamma'] });
    if (r.written !== false || r.reason !== 'external-change') throw new Error('未检出外部改动: ' + JSON.stringify(r));
    if (r.hash === r.expected) throw new Error('哈希比对逻辑错');
    const sw = s2.switchTo('gamma');
    if (sw.switched !== false || sw.reason !== 'external-change') throw new Error('切换也须拒: ' + JSON.stringify(sw));
    const got = s2.load('beta');
    if (!got || got.externalModified !== true) throw new Error('load 未报 externalModified');
    if (got.snapshot.providers[0] !== '手写改过') throw new Error('外部改动内容未读到');
    // 读到即「已知」，之后可正常写入（外部改动已报过一次，不永久挡路）
    const r2 = s2.save('gamma', { providers: ['gamma'] });
    if (r2.written !== true) throw new Error('已确认后仍拒写: ' + JSON.stringify(r2));
});

// T6 新进程 / 未知哈希不误报：lastHash 为 null 时首个 save 正常落盘
check('T6 新实例未知哈希 → 不误报外部改动，save 正常', () => {
    const fresh = createProfilesStore({ file: tmpFile, enabled: true });
    if (fresh.lastKnownHash() !== null) throw new Error('新实例不该带已知哈希');
    const r = fresh.save('delta', { providers: ['delta'] });
    if (r.written !== true) throw new Error('新实例误报 external-change: ' + JSON.stringify(r));
    if (fresh.switchTo('delta').switched !== true) throw new Error('新实例切换失败');
});

// T-cleanup
check('T-cleanup demo 临时目录已清理', () => {
    cleanup();
    if (fs.existsSync(dir)) throw new Error('临时目录未清理');
});

console.log(`\n[Profiles-Store Demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
