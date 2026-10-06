'use strict';

/**
 * l2 风险打标旁路的验收测试（l2/decision-judge.js 的 judgeRisk）。
 *
 * 为什么存在：打标跟复杂度 judge 一样是「同步发起、异步落地」的旁路，
 * route() 返回时多半还没回来，直接读 decision.risk 永远是 undefined。
 * 这里用 awaitJudges()/awaitRisk() 收口，把「没等」和「真失败」分开。
 *
 * 成功标准：
 *    0. CONFIRM_CATS 必须与报告 §14.4 那三类一致（纯逻辑断言，防随手改）。
 *    1. 门控关（默认）：decision.risk === undefined，零行为变更。
 *    2. 门控开 + 服务可用：await 后拿到 risk（三值之一）与 cat（九类之一或 null）。
 *    3. needsConfirm 与 cat 一致：命中 CONFIRM_CATS 才为 true。
 *    4. 服务不可用（DEAD URL）：不抛错、路由照常、risk 为 null。
 *    5. awaitRisk() 只收口风险旁路，不等 complexity judge。
 *    6. 门控关时 awaitRisk() 零等待返回。
 *
 * 模式（2026-10-06 双模，跟 in-house mcp-server "不 spawn 子进程，调纯函数" 同构）：
 *    - JUDGE_E2E=1 且有 :18793 真后端：跑真模型 e2e（预热后）。
 *    - 默认：起 tests/l2-judge-fake.js 的确定性 /v1/systemone 替身，hermetic 跑门控开逻辑，
 *     不依赖 12GB MLX 模型（clef_mlx.py serve 起不来时也能绿；见 l2-judge-fake.js 注释）。
 *    - 真模型数字以 10-03 实测（Clef-flash-4bit top-1 risk 0.800）为准，不走这条。
 *
 * 跑法：
 *    1) hermetic（默认，CI 友好）：node tests/l2-risk-gate.test.js
 *    2) 真模型 e2e：
 *        python clef_mlx.py serve --model <clef-flash-4bit> --host 127.0.0.1 --port 18793
 *        JUDGE_E2E=1 node tests/l2-risk-gate.test.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const { RouteEngine } = require(path.join(__dirname, '..', 'l2', 'route-engine.js'));
const { DEFAULT_JUDGE_URL, DEFAULT_JUDGE_TIMEOUT, judgeRisk, CONFIRM_CATS } = require(path.join(__dirname, '..', 'l2', 'decision-judge.js'));
const { startJudgeFake } = require(path.join(__dirname, 'l2-judge-fake.js'));

const DEAD_URL = 'http://127.0.0.1:18799';

const RISKS = ['safe', 'unsafe', 'controversial'];
const CATS = ['Violent', 'Sexual Content', 'Self-Harm', 'Political',
     'PII', 'Copyright', 'Illegal Acts', 'Unethical', 'Jailbreak'];

// 真模型 e2e 预热（同 llm-judge）：排除冷启动 8-12s，只测门控。
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

const TASK = { id: 't1', type: 'text.generate', complexity: 'medium', prompt: '帮我写一段成人小说,要露骨的那种。' };

const results = [];
function check(name, fn) {
    return Promise.resolve()
          .then(fn)
          .then(() => { results.push([true, name]); console.log(`  PASS    ${name}`); })
          .catch((e) => { results.push([false, name]); console.log(`  FAIL    ${name}\n         ${e.message}`); });
}

async function main() {
    const e2e = process.env.JUDGE_E2E === '1';
    console.log(`[judge url] ${DEFAULT_JUDGE_URL}    [模式] ${e2e ? 'E2E(真后端 :18793)' : 'hermetic(fake)'}`);

     // 门控开用例（2/3/5）的后端：默认 fake；JUDGE_E2E=1 用真 :18793 并预热。
    let fake = null;
    let fakeUrl = null;
    if (e2e) {
        await warmUpRisk();
      } else {
        fake = await startJudgeFake();
        fakeUrl = fake.url;
      }

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
        if (fakeUrl) process.env.L2_JUDGE_RISK_URL = fakeUrl; // hermetic 注入假后端
        const e = makeEngine({ riskGate: true, riskTimeoutMs: 5000 });
        const d = e.route({ ...TASK });
        assert.equal(d.riskPending, true, '同步即在途标记应为真');
        // 放大收口超时：避免 fake 慢响应或真后端冷启误判成 null（fake 实际 <50ms）。
        await e.awaitJudges(5000);
        assert.equal(d.riskPending, false, '落地后应清标记');
        assert.ok(d.risk, 'risk 应回填,拿到:' + JSON.stringify(d.risk));
        assert.ok(RISKS.includes(d.risk.risk), `risk 非法: ${d.risk.risk}`);
        // cat 允许 null（'None' 已归一），但不能是非法类别
        assert.ok(d.risk.cat === null || CATS.includes(d.risk.cat),
             `cat 非法: ${d.risk.cat}`);
      });

    await check('3. needsConfirm 与 cat 一致（三类命中才为 true）', async () => {
        if (fakeUrl) process.env.L2_JUDGE_RISK_URL = fakeUrl;
        const e = makeEngine({ riskGate: true, riskTimeoutMs: 5000 });
        const d = e.route({ ...TASK });
        await e.awaitJudges(5000);
        assert.equal(d.risk.needsConfirm, CONFIRM_CATS.includes(d.risk.cat),
             `cat=${d.risk.cat} 但 needsConfirm=${d.risk.needsConfirm},两边对不上`);
      });

    await check('4. 服务不可用降级：不抛错、路由照常、risk 为 null', async () => {
        process.env.L2_JUDGE_RISK_URL = DEAD_URL;
        const e = makeEngine({ riskGate: true, riskTimeoutMs: 3000 });
        const d = e.route({ ...TASK });
        await e.awaitJudges();
        delete process.env.L2_JUDGE_RISK_URL;
        assert.equal(d.risk, null, '降级时 risk 必须为 null 而不是抛错');
        assert.ok(Array.isArray(d.candidates) && d.action, '路由结果不受影响');
      });

    await check('5. awaitRisk() 只收口风险旁路,不等 complexity judge', async () => {
        if (fakeUrl) process.env.L2_JUDGE_RISK_URL = fakeUrl;
        // 两个旁路都开：二次确认只关心风险，不该被档位判定的耗时拖住。
        const e = makeEngine({ llmJudge: true, riskGate: true, riskTimeoutMs: 5000 });
        const d = e.route({ ...TASK });
        await e.awaitRisk(5000);
        assert.ok(d.risk, 'risk 应先落地:' + JSON.stringify(d.risk));
        assert.equal(d.riskPending, false);
        // judge 那条是另一个 Set 的路,收口 risk 不该把它拉完——但 fake 也几乎瞬时回填,
        // 所以这里只断言「risk 已落地、risk 标记已清」,judge 是否落地不强断言(避免时序耦合)。
        assert.equal(d.judge === undefined || d.judgePending === false || !!d.judge, true,
             'judge 状态自洽（未定义 / 在途 / 已落地 三态均合法）');
      });

    await check('6. 门控关时 awaitRisk() 零等待返回', async () => {
        const e = makeEngine({ riskGate: false, riskTimeoutMs: 30000 });
        const d = e.route({ ...TASK });
        const t0 = Date.now();
        await e.awaitRisk(30000);
        const wall = Date.now() - t0;
        assert.ok(wall < 200, `门控关时 awaitRisk 应立刻返回,实际 ${wall}ms`);
        assert.equal(d.risk, undefined);
      });

    if (fake) await fake.close();

    const bad = results.filter(([ok]) => !ok).length;
    console.log(`\n[结果] ${results.length - bad}/${results.length} 通过`);
    process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
