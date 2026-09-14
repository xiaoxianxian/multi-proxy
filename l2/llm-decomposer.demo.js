'use strict';

// llm-decomposer.demo.js — L2 P2.2「LLM 拆解」真跑验证。
// 纪律（与 l2/ 其它 demo 同构，且遵守本仓库「mock 掩盖不了真缺陷」铁律）：
//   - 真起一个 node http 服务当「假 LLM」，走**真 http 传输**（openAiCompatibleChat），
//     不是只测注入替身——真跑才暴露传输/超时/解析/降级的真实行为。
//   - 全程零副作用：假 LLM 是本 demo 内的 http.server，绑 127.0.0.1:0（随机端口），不触真实上游、不写文件。
//   - 覆盖：LLM 成功拆解 / 非法 JSON 降级 / 自环 DAG 降级 / LLM 宕机降级 / 注入传输缝 /
//     接 Orchestrator.runFromInput / extractJson+normalize 边界。
const assert = require('assert');
const http = require('http');
const {
    makeLlmDecomposer, extractJson, normalizeLlmDag, classifyErr,
} = require('./llm-decomposer.js');
const { templateDecompose } = require('./decomposer.js');
const { Orchestrator } = require('./orchestrator.js');

let n = 0;
const ok = (m, a) => { assert(a, m); n += 1; console.log(`PASS ${m}`); };

// LLM 返回的合法 DAG（一个需求 → 3 子任务：design→(code|test 并行)→...，无环）
const LLM_DAG_JSON = JSON.stringify({
    subtasks: [
        { id: 'design', type: 'plan', complexity: 'low', prompt: '设计接口', deps: [] },
        { id: 'impl', type: 'code', complexity: 'high', prompt: '实现核心', deps: ['design'] },
        { id: 'test', type: 'test', complexity: 'medium', prompt: '写测试', deps: ['impl'] },
     ],
});

// 起一个假 LLM /v1/chat/completions 服务；handler 可注入以模拟不同返回。
function startMockLlm(handler) {
    const server = http.createServer((req, res) => {
        let buf = '';
        req.on('data', (c) => { buf += c; });
        req.on('end', () => {
            let parsed; try { parsed = JSON.parse(buf); } catch { parsed = {}; }
            const out = handler(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'chatcmpl-x', model: parsed.model || 'default',
                choices: [{ message: { content: out } }] }));
         });
     });
    return new Promise((res) => server.listen(0, '127.0.0.1', () => {
        res({ server, port: server.address().port, close: () => server.close() });
      }));
}

(async () => {
     // 1. LLM 成功：真 http 传输 → 解析出 3 子任务无环 DAG，meta.source='llm'
     {
        const llm = await startMockLlm(() => LLM_DAG_JSON);
        const decompose = makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${llm.port}`, model: 'qwen3.8:27b-mlx' });
        const dag = await decompose('帮我做一个有测试的 API 服务');
        ok('LLM: 真 http 传输解析出 3 子任务', dag.subtasks.length === 3 && dag.template === 'llm');
        ok('LLM: 边按 deps 推导 = Σdeps', dag.edges.length === 2 &&
             JSON.stringify(dag.edges).includes(JSON.stringify(['design', 'impl'])));
        ok('LLM: meta.source=llm', dag.meta && dag.meta.llm === true && dag.meta.source === 'llm');
        llm.close();
     }

     // 2. 非法 JSON 输出 → 降级回内置规则模板（不抛、始终有 DAG）
     {
        const llm = await startMockLlm(() => '这不是 JSON，抱歉。');
        const decompose = makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${llm.port}` });
        const dag = await decompose('随便搞点啥');
        ok('降级: 非法 JSON → template', dag.meta && /template/.test(dag.meta.source));
        ok('降级: 仍产出合法单节点 DAG', dag.subtasks.length >= 1 && dag.subtasks[0].id);
        llm.close();
     }

     // 3. 自环 DAG（LLM 幻觉出 design↔test 环）→ normalize 复算环拒收 → 降级
     {
       const cyclic = JSON.stringify({
           subtasks: [
                 { id: 'a', prompt: 'a', deps: ['b'] },
                 { id: 'b', prompt: 'b', deps: ['a'] },
             ],
         });
       const llm = await startMockLlm(() => cyclic); // a→b→a 形成环
       const decompose = makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${llm.port}` });
       const dag = await decompose('jwt fastapi'); // 触发模板兜底为 4 节点
       ok('自环: 被复算环探测拒收 → 降级 template', /template/.test(dag.meta.source));
       ok('自环: 降级后 DAG 无环(可喂 Orchestrator)', require('./decomposer.js').hasCycle(dag) === false);
       llm.close();
     }

     // 4. LLM 宕机（连不上）→ ECONNREFUSED 吞掉 → 降级，meta.source 归类 llm-down
     {
        const closed = await startMockLlm(() => LLM_DAG_JSON);
        closed.close(); // 关服务，制造连接拒绝
        const decompose = makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${closed.port}`, timeoutMs: 2000 });
        const dag = await decompose('做一个短片 视频创作');
        ok('降级: LLM 宕机 → template(视频 5 节点)', dag.subtasks.length === 5 && /llm-down/.test(dag.meta.source));
     }

     // 5. 注入传输缝（不起 http，直接喂函数）——测注入路径本身 + 超时归类
     {
        const decompose = makeLlmDecomposer({
            transport: async () => { throw new Error('llm chat timeout'); },
         });
        const dag = await decompose('搞点啥');
        ok('注入: transport 超时被归类 llm-down 并降级', /llm-down/.test(dag.meta.source));

        const decompose2 = makeLlmDecomposer({
            transport: async (c) => {
                 // 验证传输收到 prompt + model
                assert(/任务拆解器/.test(c.prompt), 'transport 收到 prompt');
                assert(c.model === 'injected-model', 'transport 收到 model');
                return { content: LLM_DAG_JSON };
             },
         });
        const dag2 = await decompose2('x', { model: 'injected-model' });
        ok('注入: transport 收到 prompt+model 且成功解析', dag2.meta.source === 'llm' && dag2.subtasks.length === 3);
     }

     // 6. 接入 Orchestrator.runFromInput：LLM 拆解 + shadow 调度
     {
        const llm = await startMockLlm(() => LLM_DAG_JSON);
        const orch = new Orchestrator({
            shadowMode: true,
            decomposer: makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${llm.port}` }),
         });
        const out = await orch.runFromInput('带测试的 API 服务');
        ok('编排: LLM 拆解后 shadow 全 done', Object.values(out.results).every((r) => r.status === 'done'));
        ok('编排: 协作历史记 template=llm', orch.getHistory()[0].template === 'llm');
        llm.close();
     }

     // 7. extractJson 容错：代码块围栏 + 前后夹带文字
     {
        ok('extractJson: 去 ```json 围栏', extractJson('```json\n' + LLM_DAG_JSON + '\n```').subtasks.length === 3);
        ok('extractJson: 夹带说明文字也能抠', extractJson('当然可以：' + LLM_DAG_JSON).subtasks.length === 3);
        ok('extractJson: 纯非 JSON 返 null', extractJson('就这些') === null);
     }

     // 8. normalizeLlmDag 边界：空 / 未知 dep 删边 / 自指去重 / 合法 DAG edges 推导
     {
      ok('normalize: 空 {subtasks:[]} 返 null', normalizeLlmDag({ subtasks: [] }, 'x') === null);
      // (a) 未知 dep(ghost) 删边 + 自指(a 依赖自身 a) 去重 → 全空、无环
      const dBad = normalizeLlmDag({ subtasks: [
            { id: 'a', prompt: 'a', deps: ['ghost', 'a'] },
        ] }, 'x');
      ok('normalize: 未知 dep(ghost)+自指(a→a)都被剔、edges 空',
           dBad.subtasks[0].deps.length === 0 && dBad.edges.length === 0 && dBad.template === 'llm');
      // (b) 合法 3 节点 a←b←c（c→b→a 无环）：edges 按 deps 推导为 2 条
      const dOk = normalizeLlmDag({ subtasks: [
            { id: 'a', prompt: 'a' },
            { id: 'b', prompt: 'b', deps: ['a'] },
            { id: 'c', prompt: 'c', deps: ['b'] },
        ] }, 'x');
      ok('normalize: 合法 3 节点 edges 按 deps 推导为 2 条且无环',
           dOk.subtasks.length === 3 && dOk.edges.length === 2 &&
           require('./decomposer.js').hasCycle(dOk) === false);
     }

     // 9. 降级始终产出一个 Orchestrator 能跑的 DAG（不破坏热路径）
     {
        const decompose = makeLlmDecomposer({ transport: null }); // 无传输即必降级
        const dag = await decompose('jwt fastapi');
        const hasCycle = require('./decomposer.js').hasCycle;
        ok('容错: 无传输降级后 DAG 仍无环可喂', hasCycle(dag) === false && dag.subtasks.length === 4);
     }

    console.log(`\nllm-decomposer demo: ${n} checks PASS`);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
