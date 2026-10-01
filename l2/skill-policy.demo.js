'use strict';
// 账本 → token-policy 控制面 · 真跑验证 demo（node l2/skill-policy.demo.js）
// 断言分两组：①构造 ledger（确定性，任何机器都能过）②本机真账本（软断言，只报不断言失败）。
const M = require('./skill-policy.js');
const TP = require('./token-policy.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}    -- ${e.message}`); } };

// 构造账本：最贵 28,547 / 中 8,000 / 小 1,000 / 量不了的 null / 已禁用的
const mkLedger = () => ({
    entries: [
        { host: 'hermes', name: 'proxy-rebuild-dev', kind: 'skill', estTokens: 28547, category: null, disabled: false },
        { host: 'hermes', name: 'nested-one', kind: 'skill', estTokens: 8000, category: 'devops', disabled: false },
        { host: 'workbuddy', name: 'small-one', kind: 'skill', estTokens: 1000, category: null, disabled: false },
        { host: 'workbuddy', name: 'loose-md', kind: 'loose-md', estTokens: null, category: null, disabled: false },
        { host: 'codex', name: 'off-one', kind: 'skill', estTokens: 9999, category: null, disabled: true },
    ],
});

// 1. candidates：disabled 与量不了的（null）都不进预算；null 绝不按 0 算
check('candidates 排除 disabled 与 estTokens=null（null 不是 0）', () => {
    const cs = M.candidates(mkLedger(), {});
    assert.strictEqual(cs.length, 3, '只剩 3 条真能参与预算的');
    assert.ok(!cs.some((s) => s.estTokens == null), 'null 条目混入预算');
    assert.ok(!cs.some((s) => s.disabled), 'disabled 条目混入预算');
    assert.strictEqual(cs.reduce((n, s) => n + s.estTokens, 0), 28547 + 8000 + 1000);
});

// 2. host 过滤
check('candidates 支持 host 过滤', () => {
    const cs = M.candidates(mkLedger(), { host: 'hermes' });
    assert.strictEqual(cs.length, 2);
});

// 3. 预算分配：塞不下的显式 excluded，且不装就不算它花钱
check('planSkillBudget：cost DESC 贪心，塞不下进 excluded', () => {
    const cs = M.candidates(mkLedger(), {});
    const p = M.planSkillBudget(cs, { budget: 10000 });
    assert.strictEqual(p.injectedCount, 2, '8,000 + 1,000 塞得进 10,000');
    assert.strictEqual(p.injectedTokens, 9000);
    assert.strictEqual(p.excludedCount, 1);
    assert.strictEqual(p.excluded[0].name, 'proxy-rebuild-dev');
    assert.strictEqual(p.excludedTokens, 28547);
});

// 4. 预算刚好等于某条 cost：边界要算进（<= 装，> 不装）
check('planSkillBudget 边界：used + cost <= budget 才装', () => {
    const cs = M.candidates(mkLedger(), {});
    const p = M.planSkillBudget(cs, { budget: 9000 });
    assert.strictEqual(p.injectedTokens, 9000, '8,000+1,000 刚好卡住 9,000');
    assert.strictEqual(p.excludedCount, 1);
    const p2 = M.planSkillBudget(cs, { budget: 8999 });
    assert.strictEqual(p2.injectedCount, 1, '少 1 tok 就只剩 1 条');
});

// 5. 预算塞得下：excluded 空，netTokenDelta 为 0（0 是诚实值：确实一条没关）
check('planSkillBudget 预算充足 → excluded 为空、netTokenDelta 0', () => {
    const p = M.planSkillBudget(M.candidates(mkLedger(), {}), { budget: 999999 });
    assert.strictEqual(p.excludedCount, 0);
    assert.ok(!p.netTokenDelta, `一条没关就该是 0/-0，实际 ${p.netTokenDelta}`);   // -0 也 falsy
});

// 6. policy 描述：hook/appliesTo/default off/priority/cost
check('createSkillBudgetPolicy 默认 enabled:false、cost=注入上限而非全量', () => {
    const pol = M.createSkillBudgetPolicy({ ledger: mkLedger(), agentType: 'coding', budget: 12000 });
    assert.strictEqual(pol.hook, 'onRequestAssemble');
    assert.strictEqual(pol.enabled, false, 'pack 默认关铁律');
    assert.strictEqual(pol.appliesTo.join(','), 'coding');
    assert.strictEqual(pol.priority, 50);
    assert.strictEqual(pol.cost, 12000, 'cost 是注入上限，不是 38k 全量');
    assert.strictEqual(pol.name, '[skill-budget]all');
});

// 7. 真挂进 token-policy 跑：handler 被调、netTokenDelta 记入 estSaved、excluded 可查
check('挂进 token-policy 实跑：estSaved 累加 = -excludedTokens', () => {
    const tp = TP.createTokenPolicy({ budget: { maxInjectTokens: 20000, perPolicyMaxRatio: 0.5 } });
    const pol = M.createSkillBudgetPolicy({ ledger: mkLedger(), agentType: 'coding', enabled: true });
    tp.registerPolicy(pol);
    const run = tp.apply('onRequestAssemble', { agentType: 'coding', skillBudget: 10000 });
    const r = run.results.find((x) => x.policy === pol.name);
    assert.ok(r, 'policy 没被跑到');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.out.excludedCount, 1);
    assert.strictEqual(r.out.netTokenDelta, -28547);
    assert.strictEqual(run.estSaved, -28547, 'estSaved 累加器吃下了 netTokenDelta');
    const rep = tp.report();
    assert.strictEqual(rep.estSavedTokens, -28547);
});

// 8. ctx.skillBudget 是请求级覆盖：不传就用 policy 的 cost 上限
check('ctx.skillBudget 请求级覆盖，缺省回落 DEFAULT_BUDGET', () => {
    const tp = TP.createTokenPolicy({ budget: { maxInjectTokens: 200000, perPolicyMaxRatio: 1 } });
    const pol = M.createSkillBudgetPolicy({ ledger: mkLedger(), agentType: 'coding', enabled: true });
    tp.registerPolicy(pol);
    const a = tp.apply('onRequestAssemble', { agentType: 'coding', skillBudget: 10000 });
    const b = tp.apply('onRequestAssemble', { agentType: 'coding' });
    assert.strictEqual(a.results[0].out.excludedTokens, 28547);
    assert.strictEqual(b.results[0].out.budget, M.DEFAULT_BUDGET, '不传就用默认 12,000');
});

// 9. 诚实约束：token-policy 的 maxInjectTokens 小于 policy.cost → 被 §3.5 贪心判 skipped
//    注意 handler **仍会被调用**（出来的是 applied=false），别误读成「策略没生效」。
check('诚实约束：maxInjectTokens < policy.cost 时 applied=false（handler 仍跑）', () => {
    const tp = TP.createTokenPolicy();                       // 默认 maxInjectTokens=1000 < 12000
    const pol = M.createSkillBudgetPolicy({ ledger: mkLedger(), agentType: 'coding', enabled: true });
    tp.registerPolicy(pol);
    const run = tp.apply('onRequestAssemble', { agentType: 'coding', skillBudget: 10000 });
    const r = run.results[0];
    assert.strictEqual(r.skipped, true, '默认预算下确实被判超预算');
    assert.strictEqual(r.out.excludedTokens, 28547, '但 handler 照跑，裁剪结果仍正确');
});

// 10. appliesTo 不对口的 agentType 不参与该次 apply
check('appliesTo 不对口的 agentType 被 token-policy 过滤掉', () => {
    const tp = TP.createTokenPolicy({ budget: { maxInjectTokens: 200000, perPolicyMaxRatio: 1 } });
    tp.registerPolicy(M.createSkillBudgetPolicy({ ledger: mkLedger(), agentType: 'aigc', enabled: true }));
    const run = tp.apply('onRequestAssemble', { agentType: 'coding' });
    assert.strictEqual(run.results.length, 0, 'coding 不该跑到 aigc 的 policy');
});

// 11. explainSkillBudget dry-run：纯算不注册不落盘，数字与 plan 一致
check('explainSkillBudget dry-run 与 plan 口径一致', () => {
    const ex = M.explainSkillBudget({ ledger: mkLedger(), budget: 10000 });
    assert.strictEqual(ex.candidates, 3);
    assert.strictEqual(ex.excludedTokens, 28547);
    assert.strictEqual(ex.netTokenDelta, -28547);
    assert.strictEqual(ex.excluded[0].host, 'hermes');
    assert.ok(ex.at, '带时间戳');
});

// 12. 本机真账本（软断言）：不硬断言具体条数，机器不一样就跳过
check('本机真账本：能出候选、且不把量不了的当 0', () => {
    const ex = M.explainSkillBudget({ budget: 12000 });
    assert.ok(ex.candidates > 0, '本机至少扫出候选');
    assert.ok(ex.excludedTokens > ex.injectedTokens, '12k 预算在本机装不全整本账');
    assert.ok(!ex.excluded.some((s) => s.estTokens == null), 'excluded 里不许有量不了的');
    const nulled = ex.injected.concat(ex.excluded).filter((s) => s.estTokens == null);
    assert.strictEqual(nulled.length, 0, '候选里本来就不该有 null');
    console.log(`      （本机真账本：候选 ${ex.candidates} 条 / 装 ${ex.injectedCount} 条 ${ex.injectedTokens} tok / 关 ${ex.excludedCount} 条 ${ex.excludedTokens} tok）`);
});

// ---- veto 真生效：在 tmp 的 project fixture 上真落盘（绝不碰 ~/.hermes 之类）----
const fs = require('fs');
const os = require('os');
const path = require('path');

// host 可选：'workbuddy' = 走后缀通道（未验证但会改名），'hermes' = 走原生 skills.disabled（有源码依据）。
// 2026-10-01 改：fixture 不能再一律当 hermes —— hermes 的 `.disabled` 后缀**无效**，
// 落盘断言会挂。两条路径各用各的 fixture，正好把机制分派也测了。
function mkFixture(host = 'workbuddy') {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-veto-'));
    const mkHost = (h, withTiny) => {
        const d = path.join(proj, `.${h}`, 'skills');
        fs.mkdirSync(path.join(d, 'fat-one'), { recursive: true });
        fs.writeFileSync(path.join(d, 'fat-one', 'SKILL.md'), 'x'.repeat(3000), 'utf8');
        if (withTiny) {
            fs.mkdirSync(path.join(d, 'tiny-one'), { recursive: true });
            fs.writeFileSync(path.join(d, 'tiny-one', 'SKILL.md'), 'x'.repeat(300), 'utf8');
        }
        return d;
    };
    // 'both' = 每个宿主只放一条 fat，用来验证机制分组：hermes → 配置，workbuddy → 后缀
    const dir = host === 'both' ? mkHost('workbuddy', false) : mkHost(host === 'hermes' ? 'hermes' : 'workbuddy', true);
    if (host === 'both') { mkHost('hermes', false); }
    if (host === 'hermes' || host === 'both') {
        const cfgDir = path.join(proj, '.hermes');
        fs.mkdirSync(cfgDir, { recursive: true });
        // 真实 ~/.hermes/config.yaml 就是这么写的（skills: 块 + 若干子项，没有 disabled 行）
        fs.writeFileSync(path.join(cfgDir, 'config.yaml'),
            'model: qwen\nskills:\n  external_dirs: []\n  guard_agent_created: false\ntimezone: \'\'\n', 'utf8');
    }
    return { proj, dir };
}

check('disableExcluded：不显式给 home|project 就抛错（非侵入④）', () => {
    assert.throws(() => M.disableExcluded({ budget: 1, apply: true }), /must pass explicit/);
});

check('disableExcluded：默认 dry-run，一个字节都不写', () => {
    const { proj, dir } = mkFixture();
    try {
        const r = M.disableExcluded({ project: proj, budget: 50 });   // 两条都超（76 / 765）→ 都该被否决
        assert.strictEqual(r.dryRun, true, '默认应是 dry-run');
        assert.strictEqual(r.wouldDisable, 2, '该动 2 条');
        assert.strictEqual(r.actionDisabled, false);
        assert.strictEqual(fs.readdirSync(dir).filter((d) => d.endsWith('.disabled')).length, 0, 'dry-run 不许改名');
        assert.ok(r.skipped.every((s) => s.reason === 'dry-run'), 'skipped 要说明是 dry-run');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

check('disableExcluded（workbuddy 后缀通道）：apply 后真打上 .disabled，且重新扫描就看不见它了', () => {
    const { proj, dir } = mkFixture('workbuddy');
    try {
        const r = M.disableExcluded({ project: proj, budget: 50, apply: true });
        assert.strictEqual(r.apply, true);
        assert.strictEqual(r.applied.length, 2, '两条都被关掉');
        assert.strictEqual(r.failed.length, 0, '不应有失败');
        assert.ok(r.applied[0].to.endsWith('.disabled'), '落点必须是 .disabled 后缀');
        assert.strictEqual(fs.existsSync(path.join(dir, 'fat-one')), false, 'fat-one 应改名走');
        assert.strictEqual(fs.existsSync(path.join(dir, 'fat-one.disabled')), true);
        // 复审：条目还在账本里（便于追溯），但全部带 disabled 标记，且不再算进活跃 token
        const after = M.SK.scan('workbuddy', { project: proj, tokens: true });
        assert.strictEqual(after.skills.length, 2, '禁用 ≠ 消失，账本要能追溯它去哪了');
        assert.strictEqual(after.skills.filter((s) => s.disabled).length, 2, '两条都带 disabled 标记');
        assert.strictEqual(after.skills.filter((s) => !s.disabled).length, 0, '不该还有活跃条目');
        assert.strictEqual(after.tokens, 0, '禁用后活跃 token 应为 0');
        assert.ok(after.disabledTokens > 0, '被关掉的 token 记在 disabledTokens');
        assert.deepStrictEqual(M.candidates({ entries: after.skills }, { budget: 1e9 }), [], 'candidates 必须排除已禁用的');
        assert.strictEqual(r.mechanism.suffix, 2, '两条都该归到后缀通道');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

check('disableExcluded（hermes 原生通道）：改 config.yaml 的 skills.disabled，不碰目录名', () => {
    const { proj, dir } = mkFixture('hermes');
    try {
        const r = M.disableExcluded({ project: proj, budget: 50, apply: true });
        assert.strictEqual(r.failed.length, 0, `不该失败：${JSON.stringify(r.failed)}`);
        assert.strictEqual(r.applied.length, 2, '两条都写进清单');
        assert.ok(r.applied.every((a) => a.mechanism === 'native-config'), '都要标原生通道');
        assert.strictEqual(r.applied[0].config, path.join(proj, '.hermes/config.yaml'));
        assert.ok(fs.existsSync(r.applied[0].backup), '备份得真落盘');
        assert.strictEqual(fs.readdirSync(dir).filter((d) => d.endsWith('.disabled')).length, 0,
            'hermes 用后缀是无效的，不许偷偷改名');
        // 复审：清单里两条 => 账本把它们标成 disabled，token 挪去 disabledTokens
        const after = M.SK.scanLedger({ project: proj, hosts: ['hermes'] });
        assert.strictEqual(after.totals.disabled, 2);
        assert.ok(after.totals.disabledTokens > 0, '被关掉的 token 要如实记在 disabledTokens');
        const cfg = fs.readFileSync(path.join(proj, '.hermes/config.yaml'), 'utf8');
        assert.ok(/disabled: \[.*fat-one.*tiny-one.*\]/s.test(cfg), `清单没写全：${cfg}`);
        assert.ok(/model: qwen/.test(cfg) && /timezone/.test(cfg), '别块外的键弄丢');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

check('disableExcluded：按机制分组落盘（workbuddy 走后缀、hermes 走配置，各走各的）', () => {
    const { proj } = mkFixture('both');
    try {
        const r = M.disableExcluded({ project: proj, budget: 50, apply: true });
        assert.strictEqual(r.mechanism.suffix, 1, 'workbuddy 那条归后缀');
        assert.strictEqual(r.mechanism['native-config'], 1, 'hermes 那条归原生（hermes 认后缀是无效的）');
        assert.strictEqual(r.failed.length, 0, JSON.stringify(r.failed));
        assert.strictEqual(r.applied.length, 2);
        assert.ok(r.applied.some((a) => a.host === 'hermes' && a.mechanism === 'native-config'));
        assert.ok(r.applied.some((a) => a.host === 'workbuddy' && a.strategy === 'suffix'));
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

check('disableExcluded：maxDisable 拦住批量误操作（默认上限 10）', () => {
    const { proj, dir } = mkFixture();
    try {
        for (let i = 0; i < 8; i += 1) {                                  // 造 8 条 + 原本 2 条 = 10
            fs.mkdirSync(path.join(dir, `f${i}`), { recursive: true });
            fs.writeFileSync(path.join(dir, `f${i}`, 'SKILL.md'), 'x'.repeat(5000), 'utf8');
        }
        const r = M.disableExcluded({ project: proj, budget: 50, apply: true, maxDisable: 3 });
        assert.strictEqual(r.excludedCount, 10, '账本口径上 10 条都被否决');
        assert.strictEqual(r.wouldDisable, 3, '真动手的只放前 3 条');
        assert.strictEqual(r.actionDisabled, true, '撞上限要如实报');
        assert.strictEqual(r.applied.length, 3, '只动前 3 条');
        assert.strictEqual(fs.readdirSync(dir).filter((d) => d.endsWith('.disabled')).length, 3);
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

check('disableExcluded：单条失败不中断（不是-found 如实记 failed）', () => {
    const { proj } = mkFixture('hermes');            // 配置存在但条目不在磁盘上 => 该报 not-found，不是别的
    try {
        const r = M.disableExcluded({ project: proj, budget: 50, apply: true,
            excluded: [{ host: 'hermes', name: 'ghost-one', estTokens: 9000 }] });   // 磁盘上没这条
        assert.strictEqual(r.applied.length, 0);
        assert.strictEqual(r.failed.length, 1, '幽灵条目应记 failed');
        assert.strictEqual(r.failed[0].reason, 'not-found');
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

console.log(`\n[Skill-Policy demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
