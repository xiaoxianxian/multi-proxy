// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * l2 LLM judge 旁路（Clef SystemOne 复判复杂度档位）的验收测试。
 *
 * 为什么存在：judge 是「同步发起、异步落地」的旁路，route() 返回时它多半还没回来。
 * 上一版直接读 decision.judge 永远是 undefined，看着像 bug、其实只是没等。
 * 这里用 awaitJudges() 收口，把「没等」和「真失败」分开。
 *
 * 三条成功标准：
 *    1. 门控关（默认）：decision.judge === undefined，零行为变更。
 *    2. 门控开 + judge 可用：await 后 decision.judge.tier 是 0/1/2 之一。
 *    3. judge 不可用（URL 指到没人监听的端口）：不抛错、路由照常返回候选、judge 为 null。
 *
 * 模式（2026-10-06 双模，跟 in-house mcp-server "不 spawn 子进程，调纯函数" 同构）：
 *   - JUDGE_E2E=1 且有 :18793 真后端：跑真模型 e2e（预热后）。
 *   - 默认：起 tests/l2-judge-fake.js 的确定性 /v1/systemone 替身（照 clef_mlx.py:520-539
 *     复现选择题响应形状，ephemeral port 不占 18793），跑门控开逻辑而不依赖 12GB MLX 模型。
 *   - 真模型数字以 10-03 实测（Clef-flash-4bit_本机实测-2026-10-03.md）为准，不走这条。
 *
 * 跑法：
 *   1) hermetic（默认，CI 友好）：node tests/l2-llm-judge.test.js
 *   2) 真模型 e2e：
 *        python clef_mlx.py serve --model <clef-flash-4bit> --host 127.0.0.1 --port 18793
 *        JUDGE_E2E=1 node tests/l2-llm-judge.test.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const { RouteEngine } = require(path.join(__dirname, '..', 'l2', 'route-engine.js'));
const { DEFAULT_JUDGE_URL, judgeComplexity } = require(path.join(__dirname, '..', 'l2', 'decision-judge.js'));
const { startJudgeFake } = require(path.join(__dirname, 'l2-judge-fake.js'));

const DEAD_URL = 'http://127.0.0.1:18799'; // 没人监听的端口

// 真模型 e2e 预热：clef_mlx.py serve 空闲后首请求要 8-12s（mlx 权重换入），热态才 ~1s。
// 热路径超时设的 1500ms，撞上冷启动必然被掐成 null——这是设计内的降级，不是 bug，
// 但 e2e 要排除它，否则测的是冷启动不是门控。
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
         .then(() => { results.push([true, name]); console.log(`  PASS   ${name}`); })
         .catch((e) => { results.push([false, name]); console.log(`  FAIL   ${name}\n      ${e.message}`); });
}

async function main() {
    const e2e = process.env.JUDGE_E2E === '1';
    console.log(`[judge url] ${DEFAULT_JUDGE_URL}  [模式] ${e2e ? 'E2E(真后端 :18793)' : 'hermetic(fake)'}`);

    // 门控开用例的后端：默认 fake；JUDGE_E2E=1 用真 :18793 并预热排除冷启。
    let fake = null;
    let fakeUrl = null;
    if (e2e) {
        await warmUpJudge();
     } else {
        fake = await startJudgeFake();
        fakeUrl = fake.url;
     }

    await check('1. 门控关时 decision.judge 为 undefined（零行为变更）', async () => {
        const e = makeEngine({ llmJudge: false });
        const d = e.route({ ...TASK });
        assert.equal(d.judge, undefined);
        assert.equal(d.judgePending, undefined);
     });

    await check('2. 门控开时 await 后能拿到 tier', async () => {
        if (fakeUrl) process.env.L2_LLM_JUDGE_URL = fakeUrl; // hermetic 注入假后端
        const e = makeEngine({ llmJudge: true });
        const d = e.route({ ...TASK });
        assert.equal(d.judgePending, true, '同步即在途标记应为真');
        await e.awaitJudges(5000);
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

    if (fake) await fake.close();

    const bad = results.filter(([ok]) => !ok).length;
    console.log(`\n[结果] ${results.length - bad}/${results.length} 通过`);
    process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
