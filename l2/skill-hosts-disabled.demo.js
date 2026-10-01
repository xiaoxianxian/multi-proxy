'use strict';

// 逐宿主验证 `.disabled` 后缀到底管不管用（2026-10-01）。
// 背景：l2/skill-hosts.js 早期注释只有一句「抄自 whale2002/skills-switch，未逐宿主验证」。
// 这轮把它坐实：hermes **后缀无效**（源码证据见 DISABLE_MECHANISM），其余 6 个宿主无源码可查。
//
// 口径声明：
//   - 「有效」= 禁用后该宿主的加载器不再把它读进 prompt。
//   - hermes 这种有**原生通道**的，拒绝走后缀（setEnabled 直接 return host-uses-native-disabled），
//     改用 setConfigDisabled() 写 config.yaml 的 skills.disabled —— 按 skill 名生效（skill_utils.py:703）。
//   - 全 7 宿主都在 **tmp fixture** 上跑，绝不碰 ~/.hermes / ~/.workbuddy。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SH = require('./skill-hosts.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-disabled-'));
const check = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); }
    catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// fixture：每个宿主造「标准 skill + 嵌套分类 skill + 平铺 md」，只在 tmp 里
const home = path.join(tmp, 'home');
const proj = path.join(tmp, 'proj');
const mkSkill = (dir, name) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n# ${name}\n\nbody\n`, 'utf8');
};
for (const h of Object.values(SH.HOSTS)) {
    const g = path.join(home, h.globalDir);
    mkSkill(g, 'flat-one');
    mkSkill(path.join(g, 'devops'), 'nested-one');          // hermes/workbuddy 用分类目录（下探一层）
    fs.mkdirSync(path.join(g, 'loose'), { recursive: true });
    fs.writeFileSync(path.join(g, 'loose', 'loose.md'), '# loose\n', 'utf8');
}
const P = path.join(proj, '.hermes/skills');
mkSkill(path.join(P, 'devops'), 'proj-nested');

console.log('逐宿主禁用通道（fixture，不碰真实目录）');

check('机制表：hermes 显式标成 native-config 且有源码证据', () => {
    const m = SH.disableMechanismOf('hermes');
    assert.strictEqual(m.strategy, 'native-config');
    assert.strictEqual(m.verified, true);
    assert.ok(m.files.some((f) => f.startsWith('agent/skill_utils.py:22-26')), '缺 EXCLUDED_SKILL_DIRS 证据');
});

check('机制表：其余 6 个宿主仍是 unverified（不拿推测当结论）', () => {
    for (const id of ['workbuddy', 'claude', 'codex', 'cursor', 'gemini', 'windsurf']) {
        const m = SH.disableMechanismOf(id);
        assert.strictEqual(m.verified, false, `${id} 不该被标成已验证`);
        assert.strictEqual(m.strategy, 'suffix');
        assert.ok(m.reason, `${id} 没有 unverified 理由`);
    }
});

check('hermes 拒绝后缀通道，直接指路 setConfigDisabled', () => {
    const r = SH.setEnabled('hermes', 'flat-one', false, { home });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'host-uses-native-disabled');
    assert.ok(/setConfigDisabled/.test(r.hint), '没给出替代通道');
    assert.strictEqual(fs.existsSync(path.join(home, '.hermes/skills/flat-one.disabled')), false, '不许偷偷改名');
});

check('有原生通道的宿主，setEnabled 挂上 native-config 才走配置（默认 dry-run）', () => {
    const cfg = path.join(home, '.hermes/config.yaml');
    fs.writeFileSync(cfg, 'skills:\n  external_dirs: []\n  template_vars: true\nmodel: qwen\ntools: []\n', 'utf8');
    const dry = SH.setConfigDisabled('hermes', ['flat-one'], { home });
    assert.strictEqual(dry.ok, false);
    assert.strictEqual(dry.dryRun, true);
    assert.deepStrictEqual(dry.before, []);
    assert.deepStrictEqual(dry.after, ['flat-one']);
    assert.strictEqual(fs.readFileSync(cfg, 'utf8'), 'skills:\n  external_dirs: []\n  template_vars: true\nmodel: qwen\ntools: []\n', 'dry-run 不许改文件');
});

check('setConfigDisabled：apply 写配置 + 备份，且 skills: 块被就地补上 disabled 行', () => {
    const cfg = path.join(home, '.hermes/config.yaml');
    const r = SH.setConfigDisabled('hermes', ['flat-one'], { home, apply: true });
    assert.strictEqual(r.ok, true);
    assert.ok(r.backup !== cfg && r.backup.startsWith(cfg) && /\.bak-/.test(r.backup), `备份路径不对：${r.backup}`);
    assert.ok(fs.existsSync(r.backup), '备份文件是纸面的？');
    assert.ok(fs.readFileSync(r.backup, 'utf8').includes('external_dirs'), '备份没保住原文');
    assert.ok(fs.existsSync(cfg), '配置被删了？');
    const txt = fs.readFileSync(cfg, 'utf8');
    assert.ok(/^skills:/m.test(txt) && /disabled: \[flat-one\]/m.test(txt), `没写进去：${txt}`);
    assert.ok(/model: qwen/.test(txt), '把别的内容弄丢了');
    assert.ok(/tools: \[\]/.test(txt), '块后的顶层键丢了');
});

check('setConfigDisabled：幂等 + 回滚路径（再 enable=true 就从清单里摘掉）', () => {
    const cfg = path.join(home, '.hermes/config.yaml');
    const again = SH.setConfigDisabled('hermes', ['flat-one'], { home, apply: true });
    assert.strictEqual(again.after.filter((x) => x === 'flat-one').length, 1, '重复加进了两次');
    const on = SH.setConfigDisabled('hermes', ['flat-one'], { home, apply: true, enabled: true });
    assert.deepStrictEqual(on.after, []);
    assert.ok(/disabled: \[\]/m.test(fs.readFileSync(cfg, 'utf8')));
});

check('setConfigDisabled：没有 skills: 块就拒写（宁可让人手加，也不猜结构）', () => {
    const other = path.join(tmp, 'noskills');
    fs.mkdirSync(other, { recursive: true });
    const cfg2 = path.join(other, '.hermes/config.yaml');
    fs.mkdirSync(path.join(other, '.hermes'), { recursive: true });
    fs.writeFileSync(cfg2, 'model: qwen\n', 'utf8');
    const r = SH.setConfigDisabled('hermes', ['x'], { home: other, apply: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-skills-key');
    assert.ok(r.hint.includes('skills:'), '没给手工方案');
    assert.strictEqual(fs.readFileSync(cfg2, 'utf8'), 'model: qwen\n', '不该乱塞');
});

check('后缀通道（unverified 宿主）真的改名，且 scan 认得它是「已禁用」', () => {
    const r = SH.setEnabled('workbuddy', 'flat-one', false, { home });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.strategy, 'suffix');
    assert.strictEqual(r.effective, false, '未验证的宿主不许标 effective=true');
    const s = SH.scan('workbuddy', { home }).skills.find((x) => x.name === 'flat-one');
    assert.strictEqual(s.disabled, true, 'scan 得认出 .disabled');
    assert.strictEqual(fs.existsSync(path.join(home, '.workbuddy/skills/flat-one')), false, '原名还在？');
    assert.ok(fs.existsSync(path.join(home, '.workbuddy/skills/flat-one.disabled')));
});

check('scan：禁用条目的 token 挪进 disabledTokens，不再算进活跃总量', () => {
    const g = path.join(home, '.workbuddy/skills');
    mkSkill(g, 'live-one');
    const before = SH.scanLedger({ home, hosts: ['workbuddy'] });
    const liveTok = before.hosts[0].tokens;
    assert.ok(liveTok > 0, 'fixture 太少量不出 token');
    const r = SH.setEnabled('workbuddy', 'live-one', false, { home });
    assert.strictEqual(r.ok, true);
    const after = SH.scanLedger({ home, hosts: ['workbuddy'] });
    const beforeTotal = before.hosts[0].tokens + before.hosts[0].disabledTokens;
    assert.strictEqual(after.totals.tokens + after.totals.disabledTokens, beforeTotal, '活跃 + 禁用 应该守恒');
    assert.strictEqual(before.hosts[0].tokens - after.hosts[0].tokens,
        after.hosts[0].disabledTokens - before.hosts[0].disabledTokens, '活跃量少了多少，禁用量就得多多少');
    assert.strictEqual(after.hosts[0].disabled, 2, 'flat-one + live-one');
    assert.strictEqual(after.totals.disabled, 2);            // 前面 flat-one + 这条
});

check('嵌套条目（分类目录）走后缀必须带 category，否则 not-found', () => {
    const miss = SH.setEnabled('workbuddy', 'nested-one', false, { home });
    assert.strictEqual(miss.ok, false);
    assert.strictEqual(miss.reason, 'not-found', '不看 category 会去扫顶层，正好是这轮的坑');
    const hit = SH.setEnabled('workbuddy', 'nested-one', false, { home, category: 'devops' });
    assert.strictEqual(hit.ok, true);
    assert.ok(hit.to.endsWith('.disabled'));
    const s = SH.scan('workbuddy', { home }).skills.find((x) => x.name === 'nested-one');
    assert.strictEqual(s.disabled, true);
    assert.strictEqual(s.category, 'devops', '分类信息别丢');
});

check('非侵入④：setEnabled / setConfigDisabled 不显式给 home|project 就抛错', () => {
    assert.throws(() => SH.setEnabled('hermes', 'x', false, {}), /must pass explicit/);
    assert.throws(() => SH.setConfigDisabled('hermes', ['x'], {}), /must pass explicit/);
});

fs.rmSync(tmp, { recursive: true, force: true });
