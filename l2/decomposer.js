'use strict';

// Decomposer — L2 P2 编排引擎的「任务拆解」层。
// 职责：把一个复杂用户请求拆成子任务 DAG（节点 + 依赖边），供 Orchestrator 调度。
//
// 设计原则（与 l2/ 既有内核同构：agent-registry / plugin-runtime / route-engine）：
//    - 非侵入④：拆解只产数据，不写任何文件、不改 agent 任何配置。
//    - 可注入：默认走内置规则模板（templateDecompose，零 LLM、零副作用、demo 可确定性跑）；
//      真实 LLM 拆解通过 opts.llmDecompose 注入（接口预留，本次不实现，留 P2.2）。
//    - 零依赖：仅 node 内置。
//    - 只产「节点 + 依赖」，拓扑/调度由 Orchestrator 负责（关注点分离）。
//
// 子任务节点形状：{ id, type, complexity, prompt, deps: [subtaskId], when?(ctx), retry?, fallback? }
// 拆解结果：{ template, input, subtasks: [...], edges: [[a,b],...] }

// ---- 内置模板（规则拆解）：从一句话需求映射到子任务 DAG ----
// 每个模板：match（判定是否命中）+ build(input)（产出 DAG）。
const BUILTIN_TEMPLATES = [
    {
        // 5.1 蓝图样例：FastAPI + JWT + 数据库 + 测试 —— 4 子任务线性依赖
        name: 'fastapi-jwt',
        match: (input) => /jwt|认证|fastapi/i.test(input),
        build: (input) => [
            { id: 'design-api', type: 'code', complexity: 'low', prompt: `设计 API 接口（${input.slice(0, 40)}）`, deps: [] },
            { id: 'db-model', type: 'code', complexity: 'medium', prompt: '实现数据库模型', deps: ['design-api'] },
            { id: 'auth-jwt', type: 'code', complexity: 'medium', prompt: '实现 JWT 认证', deps: ['db-model'] },
            { id: 'unit-test', type: 'test', complexity: 'low', prompt: '写单元测试', deps: ['auth-jwt'] },
        ],
    },
    {
        // 视频创作工作流（蓝图 4.8 指定 case）：理解诉求 → 拆镜 → 生成 → 合成
        name: 'video-workflow',
        match: (input) => /视频|短片|视频创作|video/i.test(input),
        build: (input) => [
            { id: 'understand', type: 'plan', complexity: 'low', prompt: `理解视频诉求（${input.slice(0, 40)}）`, deps: [] },
            { id: 'storyboard', type: 'plan', complexity: 'medium', prompt: '分镜脚本', deps: ['understand'] },
            { id: 'gen-clip-a', type: 'video', complexity: 'high', prompt: '生成片段 A', deps: ['storyboard'] },
            { id: 'gen-clip-b', type: 'video', complexity: 'high', prompt: '生成片段 B', deps: ['storyboard'] },
            { id: 'compose', type: 'compose', complexity: 'high', prompt: '合成 + 音频', deps: ['gen-clip-a', 'gen-clip-b'] },
        ],
    },
];

// 兜底模板：单节点（无法识别为已知模式时，整包交给一个 agent）
const FALLBACK_TEMPLATE = {
    name: 'single',
    match: () => true,
    build: (input) => [{ id: 'main', type: 'code', complexity: 'medium', prompt: String(input).slice(0, 80), deps: [] }],
};

// 内置规则拆解器（默认路径，确定性、零 LLM）。
// 可注入 templates（opts.templates）：与 registry/pluginRuntime 同构的可注入缝，
// 便于测试 + 让消费方注册自定义模板，内核不做全局可变状态。
function templateDecompose(input, opts = {}) {
    const req = input == null ? '' : String(input);
    const templates = Array.isArray(opts.templates) ? opts.templates : BUILTIN_TEMPLATES;
    const tpl = templates.find((t) => t.match(req)) || FALLBACK_TEMPLATE;

    const subtasks = tpl.build(req).map((st) => ({
        id: st.id,
        type: st.type,
        complexity: st.complexity || 'medium',
        prompt: st.prompt,
        deps: Array.isArray(st.deps) ? st.deps : [],
        // 可选字段透传（条件分支 / 重试 / 降级）
        when: st.when || undefined,
        retry: st.retry != null ? st.retry : undefined,
        fallback: st.fallback || undefined,
        template: tpl.name,
    }));

    // 边 = 子任务依赖对；同时校验依赖 id 存在
    const ids = new Set(subtasks.map((s) => s.id));
    const edges = [];
    for (const st of subtasks) {
        for (const dep of st.deps) {
            if (!ids.has(dep)) throw new Error(`decompose: subtask ${st.id} deps on unknown id ${dep}`);
        }
        for (const dep of st.deps) edges.push([dep, st.id]);
    }

    return { template: tpl.name, input: req, subtasks, edges };
}

// LLM 拆解接口（预留，本次不实现）：由调用方注入 async (input, opts) => DAG
// 设计：内核不内置任何 LLM 调用，非侵入 + 零外部依赖；生产接入时注入 llmDecompose。
async function decompose(input, opts = {}) {
    if (opts.llmDecompose && typeof opts.llmDecompose === 'function') {
        return opts.llmDecompose(input, { ...opts, input });
    }
    return templateDecompose(input, opts);
}

// 校验 DAG 是否存在环（Kahn 算法剩余节点数判定）——供 Orchestrator 前置断言
function hasCycle(dag) {
    const indeg = {};
    const adj = {};
    for (const s of dag.subtasks) { indeg[s.id] = 0; adj[s.id] = []; }
    for (const [a, b] of dag.edges) { adj[a].push(b); indeg[b]++; }
    const queue = Object.keys(indeg).filter((id) => indeg[id] === 0);
    let seen = 0;
    while (queue.length) {
        const n = queue.shift();
        seen++;
        for (const m of adj[n]) if (--indeg[m] === 0) queue.push(m);
    }
    return seen !== dag.subtasks.length;
}

module.exports = { templateDecompose, decompose, hasCycle, BUILTIN_TEMPLATES, FALLBACK_TEMPLATE };
