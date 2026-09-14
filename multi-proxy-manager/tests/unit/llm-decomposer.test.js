'use strict';

// L2 P2.2 LLM 拆解内核单测：真 http 传输 + 全路径降级。
// 纪律：不起真 LLM/不触真实上游——用本地 http.server 当假 LLM；transport 可注入。

const http = require('http');
const {
    makeLlmDecomposer, extractJson, normalizeLlmDag, classifyErr,
} = require('../../../l2/llm-decomposer.js');
const { hasCycle } = require('../../../l2/decomposer.js');

const LLM_DAG_JSON = JSON.stringify({
    subtasks: [
          { id: 'design', type: 'plan', complexity: 'low', prompt: '设计接口', deps: [] },
          { id: 'impl', type: 'code', complexity: 'high', prompt: '实现核心', deps: ['design'] },
          { id: 'test', type: 'test', complexity: 'medium', prompt: '写测试', deps: ['impl'] },
      ],
});

function startMockLlm(handler) {
    const server = http.createServer((req, res) => {
        let buf = '';
        req.on('data', (c) => { buf += c; });
        req.on('end', () => {
            const out = handler(JSON.parse(buf || '{}'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'x', model: 'default', choices: [{ message: { content: out } }] }));
           });
       });
    return new Promise((res) => server.listen(0, '127.0.0.1', () => {
        res({ port: server.address().port, close: () => server.close() });
      }));
}

describe('l2/llm-decomposer (P2.2 LLM 拆解)', () => {
    it('真 http 传输：解析 LLM DAG → 3 子任务无环、meta.source=llm', async () => {
        const llm = await startMockLlm(() => LLM_DAG_JSON);
        try {
            const decompose = makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${llm.port}`, model: 'qwen3.8:27b-mlx' });
            const dag = await decompose('帮我做带测试的 API');
            expect(dag.subtasks.length).toBe(3);
            expect(dag.template).toBe('llm');
            expect(dag.edges.length).toBe(2);            // 按 deps 推导
            expect(dag.meta).toEqual({ llm: true, source: 'llm', llmError: null });
            expect(hasCycle(dag)).toBe(false);
          } finally { llm.close(); }
       });

    it('非法 JSON 输出 → 降级 template，恒产合法 DAG', async () => {
        const llm = await startMockLlm(() => '这不是 JSON');
        try {
            const decompose = makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${llm.port}` });
            const dag = await decompose('随便搞点啥');
            expect(/template/.test(dag.meta.source)).toBe(true);
            expect(dag.subtasks.length).toBeGreaterThan(0);
            expect(hasCycle(dag)).toBe(false);
           } finally { llm.close(); }
       });

    it('自环 DAG → normalize 复算环拒收 → 降级', async () => {
        const cyclic = JSON.stringify({ subtasks: [
            { id: 'a', prompt: 'a', deps: ['b'] },
            { id: 'b', prompt: 'b', deps: ['a'] },
         ] });
        const llm = await startMockLlm(() => cyclic);
        try {
            const decompose = makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${llm.port}` });
            const dag = await decompose('jwt fastapi');
            expect(/template/.test(dag.meta.source)).toBe(true);
            expect(hasCycle(dag)).toBe(false);
            expect(dag.subtasks.length).toBe(4);         // 视频/jwt 模板兜底
          } finally { llm.close(); }
       });

    it('LLM 宕机 → ECONNREFUSED 吞掉降级，归类 llm-down', async () => {
        const closed = await startMockLlm(() => LLM_DAG_JSON);
        closed.close();
        const decompose = makeLlmDecomposer({ baseUrl: `http://127.0.0.1:${closed.port}`, timeoutMs: 1500 });
        const dag = await decompose('做一个短片 视频创作');
        expect(dag.subtasks.length).toBe(5);
        expect(/llm-down/.test(dag.meta.source)).toBe(true);
       });

    it('注入 transport：超时归类 llm-down；成功时收到 prompt+model', async () => {
        const t1 = makeLlmDecomposer({ transport: async () => { throw new Error('llm chat timeout'); } });
        expect(/llm-down/.test((await t1('x')).meta.source)).toBe(true);

        let seen;
        const t2 = makeLlmDecomposer({ transport: async (c) => { seen = c; return { content: LLM_DAG_JSON }; } });
        const dag = await t2('需求', { model: 'injected-model' });
        expect(seen.prompt.length).toBeGreaterThan(0);
        expect(seen.model).toBe('injected-model');
        expect(dag.meta.source).toBe('llm');
        expect(dag.subtasks.length).toBe(3);
       });

    it('extractJson：去围栏 / 夹文字 / 纯非 JSON 返 null', () => {
        expect(extractJson('```json\n' + LLM_DAG_JSON + '\n```').subtasks.length).toBe(3);
        expect(extractJson('当然可以：' + LLM_DAG_JSON).subtasks.length).toBe(3);
        expect(extractJson('就这些')).toBeNull();
       });

    it('normalizeLlmDag：空返 null / 未知 dep+自指删边 / 合法 3 节点推导 2 边', () => {
        expect(normalizeLlmDag({ subtasks: [] }, 'x')).toBeNull();
        const bad = normalizeLlmDag({ subtasks: [{ id: 'a', prompt: 'a', deps: ['ghost', 'a'] }] }, 'x');
        expect(bad.subtasks[0].deps.length).toBe(0);
        expect(bad.edges.length).toBe(0);
        const ok = normalizeLlmDag({ subtasks: [
            { id: 'a', prompt: 'a' }, { id: 'b', prompt: 'b', deps: ['a'] }, { id: 'c', prompt: 'c', deps: ['b'] },
         ] }, 'x');
        expect(ok.subtasks.length).toBe(3);
        expect(ok.edges.length).toBe(2);
        expect(hasCycle(ok)).toBe(false);
       });

    it('classifyErr：错误信息归类', () => {
        expect(classifyErr(new Error('llm chat timeout'))).toBe('llm-down');
        expect(classifyErr(new Error('ECONNREFUSED 127.0.0.1:11434'))).toBe('llm-down');
        expect(classifyErr(new Error('llm chat HTTP 503'))).toBe('llm-http-error');
        expect(classifyErr(new Error('boom'))).toBe('llm-error');
       });
});
