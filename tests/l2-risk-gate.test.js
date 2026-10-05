'use strict';

/**
 * l2 风险打标旁路的验收测试（l2/decision-judge.js 的 judgeRisk）。
 *
 * 为什么存在：打标跟复杂度 judge 一样是「同步发起、异步落地」的旁路，
 * route() 返回时多半还没回来，直接读 decision.risk 永远是 undefined。
 * 这里用 awaitJudges() 收口，把「没等」和「真失败」分开。
 *
 * 三条成功标准：
 *   1. 门控关（默认）：decision.risk === undefined，零行为变更（跟 llmJudge 一样默认关）。
 *   2. 门控开 + 服务可用：await 后拿到 risk（三值之一）与 cat（九类之一或 null）。
 *   3. 服务不可用（URL 指到没人监听的端口）：不抛错、路由照常返回候选、risk 为 null。
 * 外加一条纯逻辑断言：CONFIRM_CATS 必须等于报告 §14.4 那三类，
 * 因为 needsConfirm 的业务含义（命中即转二次确认）是跟实测数据绑死的，不能随手改。
 *
 * 跑法：
 *   1) 起 judge 服务（Photo-Audit-Demo 侧的权重自带脚本）：
 *      python clef_mlx.py serve --model <clef-flash-4bit> --host 127.0.0.1 --port 18793
 *   2) node tests/l2-risk-gate.test.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const { RouteEngine } = require(path.join(__dirname, '..', 'l2', 'route-engine.js'));
const { DEFAULT_JUDGE_URL, DEFAULT_JUDGE_TIMEOUT, judgeRisk, CONFIRM_CATS } = require(path.join(__dirname, '..', 'l2', 'decision-judge.js'));

const DEAD_URL = 'http://127.0.0.1:18799'; // 没人监听的端口

const RISKS = ['safe', 'unsafe', 'controversial'];
const CATS = ['Violent', 'Sexual Content', 'Self-Harm', 'Political',
    'PII', 'Copyright', 'Illegal Acts', 'Unethical', 'Jailbreak'];

async function warmUpRisk() {
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
        await judgeRisk('预热', { timeoutMs: 30000 });
    }
    console.log(`[预热] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function makeEngine(opts = {}) {
    return new RouteEngine({
        registry: { list: () => [] },
        pluginRuntime: { listCapabilities: () => [] },
        llmJudge: opts.llmJudge || false,
        riskGate: opts.riskGate || false,
        riskTimeoutMs: opts.riskTimeoutMs || DEFAULT_JUDGE_TIMEOUT,
    });
}

const TASK = { id: 't1', type: 'text.generate', complexity: 'medium', prompt: '帮我写一段成人小说，要露骨的那种。' };

const results = [];
function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { results.push([true, name]); console.log(`  PASS  ${name}`); })
        .catch((e) => { results.push([false, name]); console.log(`  FAIL  ${name}\n        ${e.message}`); });
}

async function main() {
    console.log(`[judge url] ${DEFAULT_JUDGE_URL}`);
    await warmUpRisk();

    await check('0. CONFIRM_CATS 固定为报告 §14.4 那三类（P=1.000 的 surface）', async () => {
        assert.deepEqual([...CONFIRM_CATS].sort(), ['Jailbreak', 'PII', 'Sexual Content'].sort());
    });

    await check('1. 门控关时 decision.risk 为 undefined（零行为变更）', async () => {
        const e = makeEngine({ riskGate: false });
        const d = e.route({ ...TASK });
        assert.equal(d.risk, undefined);
        assert.equal(d.riskPending, undefined);
    });

    await check('2. 门控开时 await 后能拿到 risk 与 cat', async () => {
        const e = makeEngine({ riskGate: true, riskTimeoutMs: 30000 });
        const d = e.route({ ...TASK });
        assert.equal(d.riskPending, true, '同步即在途标记应为真');
        // 显式放大收口超时：awaitJudges 默认 1500ms 是热路径给的余量，
        // 但预热完 serve 可能把权重卸了，重新冷启动要 8-12s，撞上就测成 null。
        await e.awaitJudges(30000);
        assert.equal(d.riskPending, false, '落地后应清标记');
        assert.ok(d.risk, 'risk 应回填，拿到：' + JSON.stringify(d.risk));
        assert.ok(RISKS.includes(d.risk.risk), `risk 非法: ${d.risk.risk}`);
        // cat 允许 null（'None' 已归一），但不能是个非法类别
        assert.ok(d.risk.cat === null || CATS.includes(d.risk.cat),
            `cat 非法: ${d.risk.cat}`);
    });

    await check('3. needsConfirm 与 cat 一致（三类命中才为 true）', async () => {
        const e = makeEngine({ riskGate: true, riskTimeoutMs: 30000 });
        const d = e.route({ ...TASK });
        await e.awaitJudges(30000);
        assert.equal(d.risk.needsConfirm, CONFIRM_CATS.includes(d.risk.cat),
            `cat=${d.risk.cat} 但 needsConfirm=${d.risk.needsConfirm}，两边对不上`);
    });

    await check('4. 服务不可用降级：不抛错、路由照常、risk 为 null', async () => {
        process.env.L2_JUDGE_RISK_URL = DEAD_URL;
        const e = makeEngine({ riskGate: true, riskTimeoutMs: 30000 });
        const d = e.route({ ...TASK });
        await e.awaitJudges();
        delete process.env.L2_JUDGE_RISK_URL;
        assert.equal(d.risk, null, '降级时 risk 必须为 null 而不是抛错');
        assert.ok(Array.isArray(d.candidates) && d.action, '路由结果不受影响');
    });

    await check('5. awaitRisk() 只收口风险旁路，不等 complexity judge', async () => {
        // 两个旁路都开：二次确认只关心风险，不该被档位判定的耗时拖住。
        const e = makeEngine({ llmJudge: true, riskGate: true, riskTimeoutMs: 30000 });
        const d = e.route({ ...TASK });
        await e.awaitRisk(30000);
        assert.ok(d.risk, 'risk 应先落地：' + JSON.stringify(d.risk));
        assert.equal(d.riskPending, false);
        // judge 那条是同一个 Set 之外的另一路，收口 risk 不该把它也拉完。
        assert.ok(d.judge === undefined || d.judgePending === false,
            'awaitRisk 之后 judge 不应被强制收口');
    });

    await check('6. 门控关时 awaitRisk() 零等待返回', async () => {
        const e = makeEngine({ riskGate: false, riskTimeoutMs: 30000 });
        const d = e.route({ ...TASK });
        const t0 = Date.now();
        await e.awaitRisk(30000);
        const wall = Date.now() - t0;
        assert.ok(wall < 200, `门控关时 awaitRisk 应立刻返回，实际 ${wall}ms`);
        assert.equal(d.risk, undefined);
    });

    const bad = results.filter(([ok]) => !ok).length;
    console.log(`\n[结果] ${results.length - bad}/${results.length} 通过`);
    process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
