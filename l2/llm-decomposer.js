'use strict';

// llm-decomposer.js — L2 P2.2「LLM 拆解」：填补 decomposer.js 预留的 `llmDecompose` 注入缝。
//
// 职责：把「用 LLM 把一个复杂需求拆成子任务 DAG」实现成一个可注入的
//   `async (input, opts) => DAG` 工厂产物——形状与 decomposer.js 的 `decompose(input, { llmDecompose })`
//   完全一致，直接喂给 `decompose` / `Orchestrator.runFromInput` 的拆解缝即可。
//
// 设计原则（与 l2/ 既有内核 agent-registry / plugin-runtime / route-engine / decomposer / orchestrator 同构）：
//   ① 非侵入：只产 DAG（数据），不写任何文件、不改任何 agent 配置、不触真实上游——除非显式开启。
//   ② 零依赖：仅 node 内置（http 用于默认 LLM 传输）。传输**可注入**（cfg.transport），
//     测试用内存替身，不起真 LLM、不触网络。
//   ③ 容错优先（关键纪律）：LLM 不可达 / 返回非法 JSON / 产出自环 DAG / 退化为空，
//     一律**降级回内置规则拆解**（decomposer.templateDecompose），绝不把异常冒泡给调用方。
//     —— 拆解发生在编排热路径前置，一次 LLM 抖动不能拖垮整条编排链。
//   ④ 可观测：每次走 LLM 在结果上打 `meta`（llm:true / 失败原因 source），降级标 `meta.source='template'`。
//
// LLM 输出契约（DAG）：{ subtasks: [{ id, type?, complexity?, prompt, deps?[], when?, retry?, fallback? }], edges?[] }
//   - edges 缺省时按各 node.deps 自动推导（与 templateDecompose 同构）。
//   - hasCycle(dag) 复算一遍：LLM 可能产出自环 → 直接判非法 → 降级，绝不把环喂给 Orchestrator。
//
// 默认 LLM 传输 = OpenAI 兼容 `/v1/chat/completions`（POST { model, messages } →
//   { choices:[{ message:{ content } }] }），用 node 内置 http 实现；与 l1-agent-adapter.js 一致
//   （只读转发、x-proxy-auth 头、零额外依赖）。生产接入时由调用方注入 baseUrl/model/token。

const http = require('http');
const { templateDecompose, decompose, hasCycle } = require('./decomposer.js');

// LLM 调用超时（毫秒）——LLM 抖动不该无限阻塞编排；超时即降级。
const DEFAULT_TIMEOUT_MS = 60000;
// 默认拆解 prompt：要求 LLM 输出**纯 JSON DAG**，并明令 deps 指向已声明 id、不得自环。
const DEFAULT_PROMPT = (input) => [
    '你是任务拆解器。把下面的用户请求拆成一个子任务有向无环图(DAG)。',
    '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块包裹。',
    '结构: { "subtasks": [ { "id": "唯一短标识", "type": "code|plan|video|test|compose 之一",',
    '  "complexity": "low|medium|high", "prompt": "给该子任务的执行指令", "deps": ["依赖的 subtask id，可为空"],',
    '  "retry": 可选重试用, "fallback": 可选备用 subtask id } ] }。',
    '严格约束：deps 只能引用同一数组里已声明的 id；图必须无环（不能 A→B→A）；',
    '无依赖的子任务 deps 留空数组；尽量让可并行的子任务互不依赖。',
    '',
    `用户请求：${input}`,
].join('\n');

// ---- 默认 LLM 传输：OpenAI 兼容 /v1/chat/completions（仅 node 内置 http）----
// 镜像 l1-agent-adapter 的 httpPostJson 风格（只读、可选鉴权头、带超时）。
// 入参 { baseUrl, model, token?, prompt, timeoutMs? } → 解析出 { content, raw }。
async function openAiCompatibleChat(cfg) {
    const { baseUrl, model, prompt, token, timeoutMs = DEFAULT_TIMEOUT_MS } = cfg;
    const url = new URL((baseUrl || 'http://127.0.0.1:11434') + '/v1/chat/completions');
    const body = JSON.stringify({
        model: model || 'default',
        messages: [{ role: 'user', content: prompt }],
        // 拆解是结构化任务：温度压低更稳，减少幻觉出的环/坏 JSON
        temperature: 0,
    });
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
              timeout: timeoutMs, headers },
            (res) => {
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { buf += c; });
                res.on('end', () => {
                    const status = res.statusCode || 0;
                    if (status !== 200) { reject(new Error(`llm chat HTTP ${status}`)); return; }
                     // 解 OpenAI 信封：取 choices[0].message.content（助手消息文本）；
                    // 非信封形态（直接回文本）则原样透传——与注入 transport 契约一致
                     // （resp.content = 助手消息文本，可能是被 ```json 包裹的 DAG JSON）。
                    let content = buf;
                    try {
                        const env = JSON.parse(buf);
                        if (Array.isArray(env.choices) && env.choices[0]) {
                            const m = env.choices[0].message || env.choices[0].delta;
                            content = (m && typeof m.content === 'string') ? m.content : buf;
                        }
                    } catch { /* 非 JSON 信封 → 原样当文本 */ }
                    resolve({ content, raw: buf });
                 });
            },
        );
        req.on('error', (e) => reject(e));
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('llm chat timeout')); });
        req.write(body);
        req.end();
    });
}

// 从 LLM 文本输出里抠出 JSON DAG（容错：允许被 ```json 包裹、前后夹带说明文字）。
function extractJson(text) {
    if (!text || typeof text !== 'string') return null;
    let t = text.trim();
    // 去掉 ```json ... ``` / ``` ... ``` 代码块围栏
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    // 退而求其次：抓第一个平衡的 { ... } 块
    if (t[0] !== '{') {
        const start = t.indexOf('{');
        const end = t.lastIndexOf('}');
        if (start >= 0 && end > start) t = t.slice(start, end + 1);
        else return null;
    }
    try { return JSON.parse(t); } catch { return null; }
}

// 把 LLM 原始输出归一化成合法 DAG；非法（无 subtasks / 缺 id / 未知 dep / 自环）→ 返 null（触发降级）。
function normalizeLlmDag(raw, input) {
    if (!raw || typeof raw !== 'object') return null;
    const rawSub = Array.isArray(raw.subtasks) ? raw.subtasks : null;
    if (!rawSub || rawSub.length === 0) return null;

    const subtasks = rawSub.filter((s) => s && typeof s === 'object');
    const ids = new Set(subtasks.map((s) => String(s.id)).filter(Boolean));
    if (ids.size === 0) return null;
    // 依赖必须引用已声明 id（LLM 可能引用不存在的节点 → 删边，不抛）
    const subtasksClean = subtasks.map((s) => ({
        id: String(s.id),
        type: typeof s.type === 'string' ? s.type : 'code',
        complexity: ['low', 'medium', 'high'].includes(s.complexity) ? s.complexity : 'medium',
        prompt: typeof s.prompt === 'string' ? s.prompt : 'subtask ' + s.id,
        deps: Array.isArray(s.deps)
            ? s.deps.map(String).filter((d) => ids.has(d)).filter((d) => d !== String(s.id))
            : [],
        when: typeof s.when === 'function' ? s.when : undefined,
        retry: s.retry != null ? Number(s.retry) : undefined,
        fallback: typeof s.fallback === 'string' ? s.fallback : undefined,
        template: 'llm',
    }));

    // edges：LLM 显式给则用之，缺省按 deps 推导（与 templateDecompose 同构）
    let edges;
    if (Array.isArray(raw.edges)) {
        edges = raw.edges.filter((e) => e && e.length === 2 && ids.has(String(e[0])) && ids.has(String(e[1])));
        edges = edges.map((e) => [String(e[0]), String(e[1])]);
    } else {
        edges = [];
        for (const s of subtasksClean) for (const d of s.deps) edges.push([d, s.id]);
    }

    const dag = { template: 'llm', input: String(input), subtasks: subtasksClean, edges };
    // 复算环探测：LLM 可能产出自环 → 判非法 → 降级
    if (hasCycle(dag)) return null;
    return dag;
}

// 失败原因归一（给 meta.source / 日志用，绝不冒泡）
function classifyErr(e) {
    const msg = String((e && e.message) || e || 'unknown');
    if (/timeout|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'llm-down';
    if (/HTTP \d+/i.test(msg)) return 'llm-http-error';
    if (/json/i.test(msg)) return 'llm-bad-json';
    return 'llm-error';
}

// makeLlmDecomposer(cfg)：返回一个 `async (input, opts) => DAG`，形状即 decompose 的 llmDecompose 缝。
//   cfg:
//     - transport: 可选注入 `(cfg2) => { content, raw }`（测试替身；缺省走 openAiCompatibleChat）
//     - baseUrl / model / token / timeoutMs: 默认 LLM 传输连接信息
//     - prompt: 可选 `(input) => string` 覆盖默认 prompt
//     - allowNetwork: 是否允许默认 http 传输；缺省 true。测试传 false + 注入 transport。
//   行为：先尝试 LLM；任何失败 → 降级 templateDecompose(input, opts)（绝不抛）。
function makeLlmDecomposer(cfg = {}) {
    const transport = (typeof cfg.transport === 'function')
        ? cfg.transport
        : (cfg.allowNetwork === false ? null : openAiCompatibleChat);
    const buildPrompt = (typeof cfg.prompt === 'function') ? cfg.prompt : DEFAULT_PROMPT;

    return async function llmDecompose(input, opts = {}) {
        const req = (input == null ? '' : String(input));
        // 调用方可逐次覆盖 model（opts.model 优先于 cfg.model）
        const tcfg = {
            transport,
            baseUrl: cfg.baseUrl,
            model: opts.model || cfg.model || 'default',
            token: cfg.token,
            timeoutMs: cfg.timeoutMs,
            prompt: buildPrompt(req),
        };

        // (1) 尝试 LLM 拆解——任何异常都吞掉走降级
        let dag = null;
        let source = 'llm';
        let error = null;
        if (!transport) {
            error = 'transport-disabled';
        } else {
            try {
                const resp = await transport(tcfg);
                const content = (resp && resp.content != null) ? resp.content
                    : (resp && resp.raw != null ? resp.raw : null);
                const rawDag = extractJson(content);
                dag = rawDag ? normalizeLlmDag(rawDag, req) : null;
                if (!dag) { source = 'llm-degraded-json'; error = 'parse-or-cycle-fail'; }
            } catch (e) {
                dag = null;
                source = classifyErr(e);
                error = String((e && e.message) || e);
            }
        }

        // (2) 降级：LLM 未产出合法 DAG → 回内置规则拆解（保证调用方永远拿到 DAG）
        if (!dag) {
            const fb = await templateDecompose(req, opts);
            // 标记走了模板（供观测），但形状仍是标准 DAG
            fb.template = (fb.template || 'single');
            fb.meta = { llm: true, source: 'template(' + source + ')', llmError: error || null };
            return fb;
        }

        // (3) LLM 成功：打观测标，原样返回（形状与 templateDecompose 一致，可直喂 Orchestrator）
        dag.meta = { llm: true, source: 'llm', llmError: null };
        return dag;
    };
}

module.exports = {
    makeLlmDecomposer,
    openAiCompatibleChat,
    extractJson,
    normalizeLlmDag,
    classifyErr,
    DEFAULT_PROMPT,
    DEFAULT_TIMEOUT_MS,
    // 便利：把 makeLlmDecomposer 的产物接到 decompose 缝（语义演示 / 测试）
    makeDecomposeWithLlm: (cfg) => (input, opts = {}) =>
        decompose(input, { ...opts, llmDecompose: makeLlmDecomposer(cfg) }),
};
