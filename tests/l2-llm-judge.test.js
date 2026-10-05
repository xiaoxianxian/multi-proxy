'use strict';

/**
 * l2 LLM judge 旁路（Clef SystemOne 复判复杂度档位）的验收测试。
 *
 * 为什么存在：judge 是「同步发起、异步落地」的旁路，route() 返回时它多半还没回来。
 * 上一版直接读 decision.judge 永远是 undefined，看着像 bug、其实只是没等。
 * 这里用 awaitJudges() 收口，把「没等」和「真失败」分开。
 *
 * 三条成功标准：
 *   1. 门控关（默认）：decision.judge === undefined，零行为变更。
 *   2. 门控开 + judge 可用：await 后 decision.judge.tier 是 0/1/2 之一。
 *   3. judge 不可用（URL 指到没人监听的端口）：不抛错、路由照样返回候选、judge 为 null。
 *
 * 跑法：
 *   1) 起 judge 服务（Photos-Audit-Demo 侧的权重自带脚本）：
 *      python clef_mlx.py serve --model <clef-flash-4bit> --host 127.0.0.1 --port 18793
 *   2) node tests/l2-llm-judge.test.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const { RouteEngine } = require(path.join(__dirname, '..', 'l2', 'route-engine.js'));
const { DEFAULT_JUDGE_URL, judgeComplexity } = require(path.join(__dirname, '..', 'l2', 'decision-judge.js'));

const DEAD_URL = 'http://127.0.0.1:18799'; // 没人监听的端口

/**
 * 预热 judge 服务。
 * clef_mlx.py serve 空闲后首请求要 8-12s（mlx 权重换入），热态才 ~1s。
 * 热路径超时设的 1500ms，撞上冷启动必然被掐成 null——这是设计内的降级，不是 bug，
 * 但测试要排除它，否则测的是冷启动不是门控。
 */
async function warmUpJudge() {
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
        await judgeComplexity('预热', { timeoutMs: 30000 });
    }
    console.log(`[预热] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function makeEngine(opts = {}) {
    return new RouteEngine({
        registry: { list: () => [] },
        pluginRuntime: { listCapabilities: () => [] },
        llmJudge: opts.llmJudge || false,
    });
}

const TASK = { id: 't1', type: 'text.generate', complexity: 'medium', prompt: '把这段话翻译成英文：今天天气不错。' };

const results = [];
function check(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { results.push([true, name]); console.log(`  PASS  ${name}`); })
        .catch((e) => { results.push([false, name]); console.log(`  FAIL  ${name}\n        ${e.message}`); });
}

async function main() {
    console.log(`[judge url] ${DEFAULT_JUDGE_URL}`);

    await warmUpJudge();

    await check('1. 门控关时 decision.judge 为 undefined（零行为变更）', async () => {
        const e = makeEngine({ llmJudge: false });
        const d = e.route({ ...TASK });
        assert.equal(d.judge, undefined);
        assert.equal(d.judgePending, undefined);
    });

    await check('2. 门控开时 await 后能拿到 tier', async () => {
        const e = makeEngine({ llmJudge: true });
        const d = e.route({ ...TASK });
        assert.equal(d.judgePending, true, '同步即在途标记应为真');
        await e.awaitJudges();
        assert.equal(d.judgePending, false, '落地后应清标记');
        assert.ok(d.judge, 'judge 应回填，拿到：' + JSON.stringify(d.judge));
        assert.ok(['0', '1', '2'].includes(String(d.judge.tier)), `tier 非法: ${d.judge.tier}`);
    });

    await check('3. judge 不可用时降级：不抛错、路由照常、judge 为 null', async () => {
        process.env.L2_LLM_JUDGE_URL = DEAD_URL;
        const e = makeEngine({ llmJudge: true });
        const d = e.route({ ...TASK });
        await e.awaitJudges();
        delete process.env.L2_LLM_JUDGE_URL;
        assert.equal(d.judge, null, '降级时 judge 必须为 null 而不是抛错');
        assert.ok(Array.isArray(d.candidates) && d.action, '路由结果不受影响');
    });

    const bad = results.filter(([ok]) => !ok).length;
    console.log(`\n[结果] ${results.length - bad}/${results.length} 通过`);
    process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
