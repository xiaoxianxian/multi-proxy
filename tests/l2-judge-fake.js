// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * 假 Clef /v1/systemone 后端 —— l2-judge 自跑测试的 hermetic 替身（2026-10-06）。
 *
 * 为什么有它：l2-llm-judge / l2-risk-gate 两个 self-runner 的「门控开」用例原本是
 * 真·e2e，POST 到 :18793 的 `clef_mlx.py serve`（12GB MLX 多模态模型）。但起这个后端
 * 要完整 mlx 环境（mlx+mlx_vlm 同一 venv），本机 mlx/mlx_vlm 分装在两个 python、起不来，
 * 于是不起后端就跑不动门控开——这是 E2E 的固有问题，不是 judge 代码 bug。
 *
 * 这个假后端按 tests/l2-judge-fake.js 复现 clef_mlx.py:520-539 的 systemone 响应形状
 * （choice 题回 {type, choice, confidence, probabilities}，usage 带 latency_ms），
 * 给两个 runner 默认的 hermetic 后端：跑的是同一个客户端代码路径（URL 注入 / 响应解析 /
 * 门控 / fail-open / await* 收口），只是后端换成确定性替身，不依赖 12GB 模型。
 *
 * 真模型数字不走这里——以 10-03 实测为准（Clef-flash-4bit_本机实测-2026-10-03.md），
 * 门控开 + 后端在的 case 仍保留：`JUDGE_E2E=1` 时 runner 改连 :18793 真后端。
 *
 * 用法：
 *   const { startJudgeFake } = require('./l2-judge-fake');
 *   const fake = await startJudgeFake();   // { url, close() }
 *   process.env.L2_LLM_JUDGE_URL = fake.url; // 客户端按 env 注入口
 *   ...
 *   await fake.close();
 */

const http = require('node:http');

// 假答案：按题型确定性回。criteria 是 {key: 描述} dict（对齐 decision-judge 的
// TIER/RISK/CAT_CRITERIA），options 取 key。pick 取各题最贴合的固定答案，
// 让「门控开」断言确定通过——tier=1(media)、risk=unsafe、cat=Sexual Content(∈ CONFIRM_CATS)，
// confidence 0.9 高于 DEFAULT_MIN_CONF(0.55)，不落保守兜底，断言稳定。
function buildAnswer(qid, q) {
    const criteria = q && q.criteria;
    const keys = (criteria && typeof criteria === 'object')
        ? Object.keys(criteria)
        : ['0', '1'];
    let pick;
    if (qid === 'tier') pick = '1';
    else if (qid === 'risk') pick = 'unsafe';
    else if (qid === 'cat') pick = 'Sexual Content';
    else pick = keys[keys.length - 1];
    if (!keys.includes(pick)) pick = keys[0];

    const probs = {};
    const others = keys.filter((k) => k !== pick);
    const each = others.length ? 0.1 / others.length : 0;
    for (const k of keys) {
        probs[k] = k === pick ? 0.9 : Math.round(each * 10000) / 10000;
    }
    return {
        type: q && q.type ? q.type : 'choice',
        choice: pick,
        confidence: 0.9,
        probabilities: probs,
    };
}

/**
 * 起一个 ephemeral-port 的假 /v1/systemone 服务器。
 * @returns {Promise<{url:string, close:()=>Promise<void>}>}
 */
function startJudgeFake() {
    return new Promise((resolve, reject) => {
        const srv = http.createServer((req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('ok');
                return;
            }
            let data = '';
            req.on('data', (c) => {
                data += c;
                if (data.length > 5e6) req.destroy();
            });
            req.on('end', () => {
                let questions = {};
                try {
                    questions = JSON.parse(data || '{}').questions || {};
                } catch {
                    questions = {};
                }
                const answers = {};
                for (const qid of Object.keys(questions)) {
                    answers[qid] = buildAnswer(qid, questions[qid]);
                }
                const body = JSON.stringify({
                    model: 'clef-fake',
                    answers,
                    usage: { input_tokens: 5, output_tokens: 0, latency_ms: 5 },
                });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(body);
            });
            req.on('error', () => {
                res.writeHead(500);
                res.end('err');
            });
        });
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${srv.address().port}/v1/systemone`,
                // eslint-disable-next-line no-console
                server: srv,
                close: () => new Promise((r) => srv.close(r)),
            });
        });
    });
}

module.exports = { startJudgeFake, buildAnswer };
