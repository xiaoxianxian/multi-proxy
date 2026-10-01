'use strict';
// skill-ledger-diff · 页面（skills.html）基线 diff 的真点击路径验证
//   node tools/skill-ledger-diff-ui.demo.js
//
// 为什么要这个：diff 的纯函数已经由 skill-ledger.demo.js 盖住了，但「点按钮 → 存 localStorage
// → 再扫一次 → 页面标红」这条路径任何纯函数测试都碰不到。上次账本 --diff 就是先有 CLI、页面一直没接，
// 结果 CLI 好使、页面上 buttons 点了没反应也没人发现。这里用最小 DOM 沙箱把 skills.html 的内联脚本
// 真跑起来（fetch 桩返回构造账本），点真按钮、看真 innerHTML。不启动 server、不碰本机任何 agent 目录。
//
// 覆盖：设基线 / 装新 skill 标红 / 条目消失 / 净减少 / 完全持平 / 清基线 / diff 模块没加载上不白屏。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const HTML = path.join(REPO, 'multi-proxy-manager', 'public', 'skills.html');
const MODULE = path.join(REPO, 'multi-proxy-manager', 'public', 'skill-ledger-diff.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log(`PASS  ${name}`); }
    catch (e) { fail++; console.log(`FAIL  ${name}    -- ${e.message}`); }
};

// ---- 造三份账本：A 基线 / B 装了新 skill + 老的变贵 / C 又删了一条 ----
const mk = (entries, tokens, at) => ({
    generatedAt: at,
    hosts: [],
    totals: { entries: entries.length, measured: entries.length, skipped: 0, tokens },
    entries,
});
const E = (host, name, category, estTokens) => ({ host, name, category, estTokens, disabled: false });

const A = mk([E('hermes', 'a-one', '', 500), E('hermes', 'b-one', 'devops', 300), E('codex', 'c-one', '', 200)], 1000, '2026-10-01T00:00:00.000Z');
// 新装 workbuddy/new-one(400)，a-one 从 500 涨到 900 → 总量 1800
const B = mk([E('hermes', 'a-one', '', 900), E('hermes', 'b-one', 'devops', 300), E('codex', 'c-one', '', 200), E('workbuddy', 'new-one', '', 400)], 1800, '2026-10-01T09:00:00.000Z');
// 相对 A：c-one 没了（消失）→ 900+300+400 = 1600
const C = mk([E('hermes', 'a-one', '', 900), E('hermes', 'b-one', 'devops', 300), E('workbuddy', 'new-one', '', 400)], 1600, '2026-10-01T18:00:00.000Z');

const flush = () => new Promise((r) => setTimeout(r, 5));

// ---- 最小 DOM：够把 skills.html 内联脚本跑完就行 ----
function boot(opts) {
    const o = opts || {};
    let cur = o.ledger;
    const store = {};
    const els = new Map();

    function elem(id) {
        const el = {
            id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, handlers: {},
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            appendChild() {}, remove() {}, addEventListener(ev, fn) { this.handlers[ev] = fn; },
            querySelectorAll() { return []; },
        };
        el.click = function () { const h = this.handlers.click; if (h) { h.call(this, { preventDefault() {} }); } };
        return el;
    }

    const doc = {
        documentElement: elem('html'),
        getElementById(id) { if (!els.has(id)) { els.set(id, elem(id)); } return els.get(id); },
        createElement() {
            const t = { textContent: '' };
            Object.defineProperty(t, 'innerHTML', {
                get() { return String(t.textContent || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
            });
            return t;
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };

    const sandbox = {
        console, setTimeout, clearTimeout, document: doc,
        sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        // localStorage 桩挂在真 store 上：用例直接读 store 就能断言「清基线真的清了」
        localStorage: {
            getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        location: { href: '' },
        fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(cur) }),
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    if (o.withModule !== false) { vm.runInContext(fs.readFileSync(MODULE, 'utf8'), sandbox, { filename: 'skill-ledger-diff.js' }); }
    const code = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/.exec(fs.readFileSync(HTML, 'utf8'))[1];
    vm.runInContext(code, sandbox, { filename: 'skills.html-inline' });

    return {
        doc,
        store,
        setLedger(v) { cur = v; },
        el: (id) => doc.getElementById(id),
        diffHtml: () => doc.getElementById('diffResult').innerHTML,
        skillHtml: () => doc.getElementById('skillTable').innerHTML,
        meta: () => doc.getElementById('baselineMeta').textContent,
    };
}

(async function main() {
    // ===== 场景 1：设基线 → 装新 skill → 页面标红 =====
    const b = boot({ ledger: A });
    await flush();

    check('开局无基线：面板老实说「还没基线」，不编一个数', () => {
        const h = b.diffHtml();
        assert.ok(h.indexOf('还没基线') >= 0, '没看到「还没基线」：' + h);
        assert.ok(h.indexOf('多涨') < 0, '没基线就不该出现涨跌幅');
    });

    b.el('setBaselineBtn').click();
    await flush();

    check('设为基线：落进 localStorage，且只留 diff 字段（不塞整棵账本）', () => {
        const raw = b.store['mp.skill-ledger.baseline'];
        assert.ok(raw, 'localStorage 里没基线');
        const o = JSON.parse(raw);
        assert.strictEqual(o.entries.length, 3);
        assert.strictEqual(o.entries[0].path, undefined, 'path 这类大字段不该进快照');
        assert.strictEqual(o.entries[0].host + '/' + o.entries[0].name, 'hermes/a-one');
        assert.ok(b.meta().indexOf('2026-10-01') >= 0, 'meta 该显示基线时间，实际：' + b.meta());
    });

    b.setLedger(B);
    b.el('refreshBtn').click();
    await flush();

    check('装了新 skill：面板标红「比上次多涨 800 token」', () => {
        const h = b.diffHtml();
        assert.ok(h.indexOf('比上次多涨') >= 0, '没看到「比上次多涨」：' + h);
        assert.ok(h.indexOf('800') >= 0, '没出现 +800：' + h);
        assert.ok(/diff-net up/.test(h), '净增必须走 up（红）样式，实际：' + h.slice(0, 200));
    });

    check('明细表给新增条目打「新增」标，且只打在这条上', () => {
        const h = b.skillHtml();
        assert.ok(h.indexOf('新增') >= 0, '明细表没有新增标记');
        assert.ok(h.indexOf('new-one') >= 0, '新增条目没出现在明细表');
        const badges = h.split('新增').length - 1;
        assert.strictEqual(badges, 1, '新增标打了 ' + badges + ' 处（应只有 1 处标 + 1 处表头？）');
    });

    check('token 变动按增减排到最前，且带 500 → 900 的旧值（溯源用）', () => {
        const h = b.diffHtml();
        assert.ok(h.indexOf('500') >= 0 && h.indexOf('900') >= 0, '变动条目没带旧值：' + h);
    });

    // ===== 场景 2：条目消失 =====
    b.setLedger(C);
    b.el('refreshBtn').click();
    await flush();

    check('有条目消失：照基线算增减，并把消失的那条列出来（不是只报个总数）', () => {
        const h = b.diffHtml();
        // C(1600) − 基线 A(1000) = +600；c-one 从账本里没了
        assert.ok(h.indexOf('600') >= 0, '增减没算对（应相对基线 +600）：' + h);
        assert.ok(/消失 1 条/.test(h), '没列消失条目：' + h);
        assert.ok(h.indexOf('codex/c-one') >= 0, '消失的 codex/c-one 没列出：' + h);
    });

    // ===== 场景 2.5：净减少（脚本没跑到的「比上次少」分支） =====
    const D = mk([E('hermes', 'a-one', '', 300), E('hermes', 'b-one', 'devops', 300)], 600, '2026-10-02T00:00:00.000Z');
    b.setLedger(D);
    b.el('refreshBtn').click();
    await flush();

    check('净变少：文案走「比上次少」，且走 down（绿）样式不标红', () => {
        const h = b.diffHtml();
        // D(600) − 基线 A(1000) = −400
        assert.ok(h.indexOf('比上次少') >= 0, '没走「少」分支：' + h);
        assert.ok(h.indexOf('400') >= 0, '少的数量不对：' + h);
        assert.ok(/diff-net down/.test(h), '净减必须走 down（绿）样式，别一上来就标红吓人');
    });

    // ===== 场景 3：清基线 =====
    b.el('clearBaselineBtn').click();
    await flush();

    check('清除基线：localStorage 清空，面板回到「还没基线」', () => {
        assert.strictEqual(b.store['mp.skill-ledger.baseline'], undefined);
        assert.ok(b.diffHtml().indexOf('还没基线') >= 0);
        assert.ok(b.skillHtml().indexOf('新增') < 0, '清了基线不该还挂着新增标');
    });

    // ===== 场景 4：完全持平 =====
    b.setLedger(C);
    b.el('refreshBtn').click();          // 先让页面拉到 C（页面里的 ledger 是异步填的）
    await flush();
    b.el('setBaselineBtn').click();      // 基线就设成这一份
    await flush();
    b.setLedger(C);                      // 啥也没装、啥也别删
    b.el('refreshBtn').click();
    await flush();

    check('与基线完全一致：显示持平，不是「涨 0」也不是空白', () => {
        const h = b.diffHtml();
        assert.ok(h.indexOf('与基线完全一致') >= 0, '没显示完全一致：' + h);
        assert.ok(/diff-net flat/.test(h), '持平必须走 flat 样式');
    });

    // ===== 场景 5：diff 模块没加载上（缓存旧页面）不能静默说「没涨」 =====
    const nb = boot({ ledger: A, withModule: false });
    await flush();
    nb.el('setBaselineBtn').click();
    await flush();
    nb.setLedger(B);
    nb.el('refreshBtn').click();
    await flush();

    check('diff 模块没加载上：照实提示「skill-ledger-diff.js 没加载上」，不白屏不谎报', () => {
        const h = nb.diffHtml();
        assert.ok(h.indexOf('skill-ledger-diff.js 没加载上') >= 0, '没给出口：' + h);
        assert.ok(nb.doc.getElementById('skillTable').innerHTML.indexOf('new-one') >= 0, '模块缺失时明细表也该照常渲染');
    });

    // ===== 场景 6：总量持平但条目有变化（新增一条 + 删掉一条差不多大的） =====
    // 真浏览器验证时撞出来的：头部说「与基线持平」、下面列「新增 2 条」，页面自相矛盾。
    const A2 = mk([E('hermes', 'a-one', '', 500), E('codex', 'old-one', '', 200)], 700, '2026-10-02T01:00:00.000Z');
    const A3 = mk([E('hermes', 'a-one', '', 500), E('workbuddy', 'new-one', '', 200)], 700, '2026-10-02T02:00:00.000Z');
    const m = boot({ ledger: A2 });
    await flush();
    m.el('setBaselineBtn').click();
    await flush();
    m.setLedger(A3);
    m.el('refreshBtn').click();
    await flush();

    check('总量持平但条目有变：不许只说「与基线持平」把条目变化盖掉', () => {
        const h = m.diffHtml();
        assert.ok(/diff-net flat/.test(h), '总量没变就该走 flat 样式');
        assert.ok(h.indexOf('与基线完全一致') < 0, '还有条目变化时不许说「完全一致」：' + h);
        assert.ok(h.indexOf('token 总量持平') >= 0, '没点明「总量持平」：' + h);
        assert.ok(h.indexOf('新增 1 条') >= 0 && h.indexOf('消失 1 条') >= 0, '没列出条目变化：' + h);
    });

    // ===== 场景 7：一边没量过（null）不能画成 0 =====
    const N1 = mk([E('hermes', 'q-one', '', 800)], 800, '2026-10-02T03:00:00.000Z');
    const N2 = mk([E('hermes', 'q-one', '', null)], 0, '2026-10-02T04:00:00.000Z');
    const n = boot({ ledger: N2 });
    await flush();
    n.el('setBaselineBtn').click();
    await flush();
    n.setLedger(N1);
    n.el('refreshBtn').click();
    await flush();

    check('一边没量过：变动行画「—」而不是「0」，且说清无法比较', () => {
        const h = n.diffHtml();
        assert.ok(h.indexOf('>—<') >= 0, 'null 该渲染成 —，实际：' + h);
        assert.ok(h.indexOf('无法比较') >= 0, 'delta 无从算起时要说明，别编数字');
        assert.ok(h.indexOf('估算口径：— → 800') >= 0, '基线一份都没量出来时，头部不许印「0 → 800」：' + h);
        assert.ok(!/lang->0<\/span> 0 →/.test(h), '不许把「量不了」印成 0 token');
    });

    console.log(`\n[skill-ledger-diff ui demo] PASS ${pass} / ${pass + fail}`);
    process.exit(fail === 0 ? 0 : 1);
}());
