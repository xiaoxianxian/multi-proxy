'use strict';

// decomposer.demo.js — L2 P2 任务拆解器真跑验证（与 l2/ 既有 demo 同风格：node l2/<module>.demo.js）。
// 零副作用：纯计算，不起服务、不写文件、不触网络。
const assert = require('assert');
const { decompose, templateDecompose, hasCycle, BUILTIN_TEMPLATES } = require('./decomposer.js');

let n = 0;
const ok = (m, a) => { assert(a, m); n += 1; console.log(`PASS ${m}`); };

// 1. FastAPI/JWT 模板：4 子任务线性依赖
{
    const dag = templateDecompose('帮我写一个 FastAPI 服务，支持 JWT 认证 + 数据库');
    ok('fastapi: 命中 4 子任务', dag.subtasks.length === 4);
    ok('fastapi: 3 条依赖边线性链', JSON.stringify(dag.edges) === JSON.stringify([
         ['design-api', 'db-model'], ['db-model', 'auth-jwt'], ['auth-jwt', 'unit-test'],
     ]));
    ok('fastapi: 无环', hasCycle(dag) === false);
    ok('fastapi: 首个子任务无依赖', dag.subtasks.find((s) => s.id === 'design-api').deps.length === 0);
}

// 2. 视频工作流（蓝图 4.8 指定 case）：5 子任务含并行片段
{
    const dag = templateDecompose('做一个 30 秒的短视频');
    ok('video: 命中 5 子任务', dag.subtasks.length === 5);
    ok('video: 片段 A/B 都依赖 storyboard（并行）',
         dag.subtasks.find((s) => s.id === 'gen-clip-a').deps[0] === 'storyboard' &&
         dag.subtasks.find((s) => s.id === 'gen-clip-b').deps[0] === 'storyboard');
    ok('video: compose 依赖 A+B', JSON.stringify(dag.subtasks.find((s) => s.id === 'compose').deps) ===
         JSON.stringify(['gen-clip-a', 'gen-clip-b']));
    ok('video: 无环', hasCycle(dag) === false);
}

// 3. 兜底模板：未知需求 → 单节点
{
    const dag = templateDecompose('随便搞点啥');
    ok('fallback: 未知需求单节点', dag.subtasks.length === 1 && dag.subtasks[0].id === 'main' && dag.edges.length === 0);
    ok('fallback: 记录 input 原文 + 模板名', dag.input === '随便搞点啥' && dag.template === 'single');
}

// 4. hasCycle 真能检出环（1→2→1）
{
    const cyclic = {
        subtasks: [
             { id: 'a', type: 'code', complexity: 'low', prompt: 'a', deps: ['b'] },
             { id: 'b', type: 'code', complexity: 'low', prompt: 'b', deps: ['a'] },
        ],
        edges: [['b', 'a'], ['a', 'b']],
     };
    ok('hasCycle: 检出环', hasCycle(cyclic) === true);
    ok('hasCycle: 合法 DAG 不报环', hasCycle(templateDecompose('jwt fastapi')) === false);
}

// 5. 兜底模板默认不注入 retry/fallback（字段存在性靠可选透传）
ok('fallback: 默认不注入 retry/fallback', (() => {
    const fb = templateDecompose('搞点啥');
    return fb.subtasks[0].retry === undefined && fb.subtasks[0].fallback === undefined;
})());

// 6. 边数量 = Σ依赖项数
{
    const dag = templateDecompose('视频短片创作');
    ok('edges: 总边数 = Σdeps', dag.edges.length === dag.subtasks.reduce((s, x) => s + x.deps.length, 0));
}

// 7. 模板元信息
ok('templates: 内置 2 条含 fastapi-jwt + video-workflow',
     BUILTIN_TEMPLATES.length === 2 &&
     BUILTIN_TEMPLATES.map((t) => t.name).includes('fastapi-jwt') &&
     BUILTIN_TEMPLATES.map((t) => t.name).includes('video-workflow'));

// 8. 空/null 输入走兜底不崩
ok('empty: 空输入走兜底', templateDecompose('').subtasks.length === 1 && templateDecompose(null).subtasks.length === 1);

// 9. 可选字段（retry/when/fallback）透传不被吞（经可注入 templates 缝，不碰全局）
ok('透传: 可选字段不被吞', (() => {
    const customTpls = [{
          name: 'x',
          match: () => true,
          build: () => [
               { id: 's1', type: 'code', complexity: 'low', prompt: 'p', retry: 2, fallback: 'backup-agent', when: () => true },
          ],
      }];
    const dag = templateDecompose('whatever', { templates: customTpls });
    const s = dag.subtasks[0];
    return s.retry === 2 && s.fallback === 'backup-agent' && typeof s.when === 'function';
})());

// 10. 异步：LLM 注入路径被委托（本次不实现 LLM，仅验证接口可注入）
(async () => {
    let called = false;
    const dag = await decompose('anything', {
        llmDecompose: async (input, opts) => {
            called = true;
            return { template: 'llm', input, subtasks: [{ id: 'x', type: 'code', complexity: 'low', prompt: input, deps: [] }], edges: [] };
        },
     });
    ok('llm: 注入 llmDecompose 被调用且返回其 DAG', called && dag.template === 'llm');
    const dag2 = await decompose('jwt fastapi');
    ok('builtin: 无 LLM 时走内置规则（awaitable）', dag2.subtasks.length === 4);
    console.log(`\ndecomposer demo: ${n} checks PASS`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
