'use strict';
// skill-ledger CLI · 账本 diff 真跑验证（node tools/skill-ledger.demo.js → 全 PASS）
//
// 为什么要这个：账本只存不比，等于每次都是孤例 —— 装了 3 个新 skill 之后涨了多少、哪条最贵变贵了，
// 全靠人肉对两份 json。diff 让「本机上下文资产」变成**有基线的可追踪量**。
// 这里只测纯函数（parseArgs / diffLedger），不扫本机目录、不写任何文件。
const M = require('./skill-ledger.js');
const assert = require('assert');

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log(`PASS  ${name}`); }
    catch (e) { fail++; console.log(`FAIL  ${name}    -- ${e.message}`); }
};

const base = {
    generatedAt: '2026-10-01T00:00:00.000Z',
    hosts: [],
    totals: { entries: 3, measured: 3, skipped: 0, tokens: 1000 },
    entries: [
        { host: 'hermes', name: 'a-one', category: null, estTokens: 500, disabled: false },
        { host: 'hermes', name: 'b-one', category: 'devops', estTokens: 300, disabled: false },
        { host: 'codex', name: 'c-one', category: null, estTokens: 200, disabled: true },
    ],
};
const cur = {
    generatedAt: '2026-10-01T12:00:00.000Z',
    hosts: [],
    totals: { entries: 4, measured: 4, skipped: 0, tokens: 1600 },
    entries: [
        { host: 'hermes', name: 'a-one', category: null, estTokens: 900, disabled: false },   // 变贵
        { host: 'hermes', name: 'b-one', category: 'devops', estTokens: 300, disabled: false },// 没变
        { host: 'codex', name: 'new-one', category: null, estTokens: 400, disabled: false },   // 新增
        { host: 'workbuddy', name: 'gone-one', category: null, estTokens: 0, disabled: false },// 占位（应被扫掉）
    ].filter((e) => e.name !== 'gone-one'),
};

check('keyOf：host/category/name 三段拼，跟明细表路径一致', () => {
    assert.strictEqual(M.keyOf({ host: 'hermes', category: 'devops', name: 'b-one' }), 'hermes/devops/b-one');
    assert.strictEqual(M.keyOf({ host: 'codex', category: null, name: 'c-one' }), 'codex/c-one');
});

check('diffLedger：新增 / 消失 / 变动 三类分清，且互不重', () => {
    const d = M.diffLedger(cur, base);
    assert.deepStrictEqual(d.added.map((x) => x.key), ['codex/new-one']);
    assert.deepStrictEqual(d.removed.map((x) => x.key), ['codex/c-one']);
    assert.deepStrictEqual(d.changed.map((x) => x.key), ['hermes/a-one']);
    assert.strictEqual(d.addedCount + d.removedCount + d.changedCount, 3, '三类合计 3，别漏别重');
});

check('diffLedger：token 变动带 from/to/delta/倍率', () => {
    const d = M.diffLedger(cur, base);
    const c = d.changed[0];
    assert.strictEqual(c.from, 500);
    assert.strictEqual(c.to, 900);
    assert.strictEqual(c.delta, 400);
    assert.strictEqual(c.ratio, 1.8);
});

// 🔴 「没量过」必须留 null，不能折算成 0 —— 0 会被读成「这条不占 token」，
//    真浏览器验证时这条口径打脸过一次（面板打出「1 → 0 (-1)」，其实是「基线量不了→现在量得了」）。
check('diffLedger：没量过留 null，绝不折算成 0', () => {
    const mLedger = {
        generatedAt: 't', hosts: [], totals: { entries: 3, measured: 2, skipped: 1, tokens: 1200 },
        entries: [
            { host: 'hermes', name: 'x-one', category: null, estTokens: null },   // 基线量不了
            { host: 'hermes', name: 'y-one', category: null, estTokens: 100 },
            { host: 'codex', name: 'z-one', category: null, estTokens: 1100 },
        ],
    };
    const d = M.diffLedger(mLedger, {
        generatedAt: 't', hosts: [], totals: { entries: 3, measured: 2, skipped: 1, tokens: 1200 },
        entries: [
            { host: 'hermes', name: 'x-one', category: null, estTokens: null },
            { host: 'hermes', name: 'y-one', category: null, estTokens: 100 },
            { host: 'codex', name: 'z-one', category: null, estTokens: 1100 },
        ],
    });
    assert.strictEqual(d.changed.length, 0, '两边都没量过时不该被判成「变动」');

    // 一边量得了、一边没有 → delta 只能是 null，谁也不许编数字
    const half = M.diffLedger(
        { hosts: [], totals: { tokens: 1000 }, entries: [{ host: 'hermes', name: 'x-one', category: null, estTokens: 800 }] },
        { hosts: [], totals: { tokens: 1000 }, entries: [{ host: 'hermes', name: 'x-one', category: null, estTokens: null }] },
    );
    assert.strictEqual(half.changedCount, 1, '一边 null 一边有值时仍要报「变动」，否则「现在量得了」这件事会静默掉');
    assert.strictEqual(half.changed[0].from, null);
    assert.strictEqual(half.changed[0].to, 800);
    assert.strictEqual(half.changed[0].delta, null, 'delta 无法确定就必须 null，不能瞎算');

    // 新增/消失条目同样不许把 null 变 0
    const add = M.diffLedger(
        { hosts: [], totals: { tokens: 0 }, entries: [{ host: 'codex', name: 'loose', category: null, estTokens: null }] },
        { hosts: [], totals: { tokens: 0 }, entries: [] },
    );
    assert.strictEqual(add.added[0].estTokens, null, '新增条目量不了也要是 null，不是 0');
});

check('diffLedger：总量口径与端点一致（别用 totals 之外的混算）', () => {
    const d = M.diffLedger(cur, base);
    assert.strictEqual(d.tokensFrom, 1000);
    assert.strictEqual(d.tokensTo, 1600);
    assert.strictEqual(d.tokensDelta, 600);
    // 逐条核对：新增 +400、消失 -200、变动 +400
    assert.strictEqual(d.addedTokens - Math.abs(d.removedTokens) + d.changed.reduce((n, x) => n + x.delta, 0), 600);
});

check('diffLedger：基线生成时间如实带回（溯源用）', () => {
    assert.strictEqual(M.diffLedger(cur, base).baselineAt, '2026-10-01T00:00:00.000Z');
});

check('diffLedger：账本一样就三类全 0（不是「没 diff」）', () => {
    const d = M.diffLedger(base, base);
    assert.strictEqual(d.addedCount + d.removedCount + d.changedCount, 0);
    assert.strictEqual(d.tokensDelta, 0);
});

check('双用模块：浏览器分支（无 module）能挂出全局 SkillLedgerDiff', () => {
    // 页面只 <script src>，环境里没有 module/CJS → 必须走 root.SkillLedgerDiff 那条分支。
    // 用 vm 造一个「没有 module」的沙箱真跑一遍，别只信注释。
    const fs = require('fs');
    const vm = require('vm');
    const code = fs.readFileSync(require.resolve('../multi-proxy-manager/public/skill-ledger-diff.js'), 'utf8');
    const sandbox = { self: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const g = sandbox.Self || sandbox.self.SkillLedgerDiff;
    assert.ok(g, '浏览器分支没挂出 SkillLedgerDiff');
    assert.strictEqual(g.keyOf({ host: 'hermes', category: 'devops', name: 'x' }), 'hermes/devops/x');
    assert.strictEqual(typeof g.diffLedger, 'function');
});

check('双用模块：CLI 复用的是同一份真源（不是复制出来的第二份）', () => {
    const LD = require('../multi-proxy-manager/public/skill-ledger-diff.js');
    assert.strictEqual(M.keyOf, LD.keyOf);
    assert.strictEqual(M.diffLedger, LD.diffLedger);
});

check('parseArgs：--diff / --out / --host 都认，host 可重复', () => {
    const a = M.parseArgs(['--host', 'hermes', '--host', 'codex', '--out', '/tmp/x.json', '--diff', '/tmp/base.json', '--top', '5']);
    assert.deepStrictEqual(a.hosts, ['hermes', 'codex']);
    assert.strictEqual(a.out, '/tmp/x.json');
    assert.strictEqual(a.diff, '/tmp/base.json');
    assert.strictEqual(a.top, 5);
});

check('parseArgs：--help 只是标记，不打断主流程', () => {
    assert.strictEqual(M.parseArgs(['--help']).help, true);
    assert.strictEqual(M.parseArgs([]).help, undefined);
});

console.log(`\n[skill-ledger demo] PASS ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
