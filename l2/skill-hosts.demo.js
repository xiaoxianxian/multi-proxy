'use strict';
// 宿主 adapter · 真跑验证 demo（node l2/skill-hosts.demo.js）
// 全部断言基于本机真实目录（~/.hermes / ~/.workbuddy / ~/.codex / ~/.cursor），非构造数据。
// 写操作一律落 os.tmpdir()，绝不碰 agent 自身目录（非侵入④）。
const M = require('./skill-hosts.js');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}    -- ${e.message}`); } };
const HOME = os.homedir();

// 1. 宿主表：7 个，hermes/workbuddy 是 SkillSwitch 认不到的那两个
check('宿主表 7 个；hermes/workbuddy 标 skillSwitch:false', () => {
    const hs = M.listHosts();
    assert.strictEqual(hs.length, 7);
    assert.strictEqual(hs.filter((h) => h.skillSwitch).length, 5, 'SkillSwitch 五件套');
    assert.strictEqual(M.getHost('hermes').skillSwitch, false);
    assert.strictEqual(M.getHost('workbuddy').skillSwitch, false);
    assert.throws(() => M.getHost('nope'), /unknown host/);
 });

// 2. 真扫 hermes：嵌套分类目录（skills/<category>/<name>/SKILL.md）必须被下探到
check('扫描 hermes：含 SKILL.md 的顶层 + 分类目录嵌套都能扫到', () => {
    const r = M.scan('hermes', { home: HOME });
    assert.strictEqual(r.exists, true, `${r.dir} 存在`);
    const withEntry = r.skills.filter((s) => s.kind === 'skill');
    const nested = r.skills.filter((s) => s.category);
    assert.ok(withEntry.length >= 26, `顶层+嵌套 skill >= 26，实际 ${withEntry.length}`);
    assert.ok(nested.length > 0, `分类目录里有嵌套 skill（不下探就漏），实际 ${nested.length}`);
 });

// 3. 真扫 workbuddy / codex / cursor
check('扫描 workbuddy >= 26 个标准 skill', () => {
    const r = M.scan('workbuddy', { home: HOME });
    assert.ok(r.skills.filter((s) => s.kind === 'skill').length >= 26);
 });
check('扫描 codex = 2 个（autonomous-continuity / ian-xiaohei-illustrations）', () => {
    const r = M.scan('codex', { home: HOME });
    assert.strictEqual(r.skills.length, 2, `实际 ${r.skills.length}`);
 });
check('扫描 cursor：平铺 md 报 loose-md，不假装是标准 skill', () => {
    const r = M.scan('cursor', { home: HOME });
    assert.strictEqual(r.skills.length, 1);
    assert.strictEqual(r.skills[0].kind, 'loose-md');
    assert.strictEqual(r.skills[0].entry, null);
 });

// 4. 未安装的宿主 = exists:false，不报错
check('未安装宿主（gemini）→ exists:false 且不抛', () => {
    const r = M.scan('gemini', { home: HOME });
    assert.strictEqual(r.exists, false);
    assert.deepStrictEqual(r.skills, []);
 });

// 5. planInstall 纯计算，零写盘
check('planInstall 只算不写（dry-run）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-plan-'));
    const p = M.planInstall({ name: 'demo' }, 'codex', { home: tmp });
    assert.strictEqual(p.host, 'codex');
    assert.strictEqual(p.exists, false);
    assert.strictEqual(p.wouldOverwrite, false);
    assert.strictEqual(fs.readdirSync(tmp).length, 0, 'plan 之后目录仍为空');
 });

// 6. 非侵入守卫：写操作不传 home/project 必须抛
check('非侵入守卫：install / setEnabled 不传 home|project 抛错', () => {
    assert.throws(() => M.install({ name: 'x', content: 'c' }, 'codex'), /never defaults to home/);
    assert.throws(() => M.setEnabled('codex', 'x', false), /never defaults to home/);
 });

// 7. install 真写到显式传入的 dir，产出带 frontmatter 的 SKILL.md
check('install 落盘：SKILL.md 带 YAML frontmatter', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-inst-'));
    const r = M.install({ name: 'demo-skill', description: 'd', content: 'body' }, 'codex', { home: tmp });
    assert.strictEqual(r.written, true);
    const md = fs.readFileSync(r.entryFile, 'utf8');
    assert.ok(md.startsWith('---\nname: demo-skill'), 'frontmatter 开头');
    assert.ok(md.includes('body'));
    const re = M.scan('codex', { home: tmp });
    assert.strictEqual(re.skills.length, 1, '装完能被扫回来');
 });

// 8. setEnabled：.disabled 后缀往返（约定抄自 skills-switch，未逐宿主验证 → 标 unverified）
check('setEnabled 用 .disabled 后缀往返，并标 unverified', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-dis-'));
    M.install({ name: 'demo-skill', content: 'c' }, 'codex', { home: tmp });
    const off = M.setEnabled('codex', 'demo-skill', false, { home: tmp });
    assert.strictEqual(off.ok, true);
    assert.strictEqual(off.unverified, true, '如实标注未验证');
    assert.ok(fs.existsSync(path.join(tmp, '.codex/skills/demo-skill.disabled')));
    const on = M.setEnabled('codex', 'demo-skill', true, { home: tmp });
    assert.strictEqual(on.ok, true);
    assert.ok(fs.existsSync(path.join(tmp, '.codex/skills/demo-skill')));
 });

// 9. 项目级作用域：落到 <project>/.codex/skills
check('项目级作用域 resolveDir 落 <project>/.codex/skills', () => {
    const d = M.resolveDir('codex', { project: '/tmp/proj' });
    assert.strictEqual(d, path.join('/tmp/proj', '.codex/skills'));
 });

// 10. ② skill token 计价：量的是与 install 同源的那份 SKILL.md 文本
check('measureSkillTokens：正整数，且与 install 写出的文本同源', () => {
    const s = { name: 'tk', description: 'd', content: 'x'.repeat(300) };
    const n = M.measureSkillTokens(s);
    assert.ok(Number.isInteger(n) && n > 0, `正整数，实际 ${n}`);
    const longer = M.measureSkillTokens({ ...s, content: 'x'.repeat(900) });
    assert.ok(longer > n, '内容更长 → token 更多');
    // 同源校验：拿 install 真写出来的文件量一遍，数字必须一致
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-tok-'));
    const r = M.install(s, 'codex', { home: tmp });
    const onDisk = fs.readFileSync(r.entryFile, 'utf8');
    assert.strictEqual(M.toSkillMd(s), onDisk, '量的和装的是同一份文本');
 });

check('estTokens 语义：null=没量过，绝不拿 0 冒充', () => {
    const { validateSkill } = require('./skill-service.js');
    const base = { name: 'n', trigger: 't', description: 'd', content: 'c', version: '1.0.0' };
    assert.strictEqual(validateSkill({ ...base, estTokens: null }), null, 'null 合法');
    assert.strictEqual(validateSkill({ ...base, estTokens: 42 }), null, '整数合法');
    assert.ok(validateSkill({ ...base, estTokens: -1 }), '负数被拒');
    assert.ok(validateSkill({ ...base, estTokens: 1.5 }), '非整数被拒');
    assert.ok(validateSkill({ ...base, estTokens: '42' }), '字符串被拒');
 });

console.log(`\n[Skill-Hosts demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
