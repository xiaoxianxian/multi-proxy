'use strict';

// executor-bind.js —— 生产 executor 接线（runbook §4.4 的欠账兑现）。
//
// 背景（2026-10-01 Step 2 canary 实测）：
//   manager 侧从未给 McpServer / Orchestrator 注入 executor → PROXY_ADAPTER_REAL=1 时
//   _realExecutor 走「仅路由」退化分支：真路由、记录 routedAdapterId，**但不触下游**。
//   结果就是「门控开了也不干活」——不扣费不外发，但也拿不到真实结果。
//   本模块把最后一公里补上：路由选中哪个 adapterId，就真的去调那个 adapter。
//
// ⚠️ 这是全项目第一个「会真花钱 / 真外发数据」的接线，因此三重门控，缺一不可：
//   ① PROXY_EXECUTOR_BIND=1（**默认 0**）→ 不开 = 调用方拿到 undefined，逐字维持现状。
//   ② PROXY_ADAPTER_REAL=1（既有二级门控）→ 不开 = orchestrate 恒 shadow，executor 不被调用。
//   ③ per-call shadowMode:true → 单次回退。
//   任一不开 → 零外发。回退成本为零（unset env 即可，无需改代码）。
//
// 绑定表（只绑有真实 adapter 类的 adapterId；绑不上的一律**显式抛错**，绝不静默降级）：
//   h3web  → H3webAdapter.run()      POST /api/gen + GET /api/status（任务队列型，异步轮询）
//   codex  → L1AgentAdapter.invoke() POST /v1/chat/completions（chat 型，x-proxy-auth 鉴权）
//   claude → ClaudeAdapter.invoke()  POST /v1/messages（chat 型，x-api-key 鉴权）
//   ⚠️ 未绑定：agnes / deepseek / qwen（三档 text-tier profile）——它们是 complexity 档位落点，
//      目前**没有对应 adapter 类**，下游是谁未定。真执行撞上会抛 UnboundAdapterError（硬失败），
//      而不是假装成功。这是已知缺口，不是 bug（见 runbook §4.5 待办 6）。
//
// 非侵入铁律（与全项目一致）：
//   - 构造期**不触网**：只 new adapter 实例（端口探测发生在首次 invoke，非构造）。
//   - 不写任何 agent 文件、不改 adapter 源码、不改路由行为（路由仍是 route-engine 的活）。
//   - 端口全部走 env 注入 + 探测候选，绝不写死（adapter-protocol.md §五 ②）。

const { H3webAdapter } = require('./adapters/h3web-adapter.js');
const { L1AgentAdapter } = require('./adapters/l1-agent-adapter.js');
const { ClaudeAdapter } = require('./adapters/claude-adapter.js');
// 共享底座（质量工程 §三）：三档 text-tier 的下游绑定（tier → {ports, model, auth}）唯一事实源
const { resolveTierBindings, resolveExecutorDefault } = require('./knowledge-base/routing-base.js');

// env 端口解析：'18790,18791' → [18790, 18791]；空 → 用默认候选
function envPorts(name, fallback) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) return fallback;
    const ports = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    return ports.length ? ports : fallback;
}

// 门控：PROXY_EXECUTOR_BIND ∈ {1,true,on} 才接线（默认关）
function isExecutorBindOpen() {
    const v = String(process.env.PROXY_EXECUTOR_BIND || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

// 三档 text-tier 门控：PROXY_TIER_BIND ∈ {1,true,on} 才绑（**默认 0**）。
// 为什么单开一个开关：三档里的 agnes/deepseek **真的会花钱**（经 codex-proxy 打付费外网），
// 与 codex/claude 一样属"真外发"性质 → 维持「默认关 = 未绑定硬失败」的既有语义，不偷偷开。
// 想 0 成本演练三档链路：PROXY_TIER_BIND=1 + PROXY_TIER_LOCAL_ONLY=1（三档全指本地 qwen）。
function isTierBindOpen() {
    const v = String(process.env.PROXY_TIER_BIND || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

// 未绑定 adapterId → 硬失败（不静默降级、不假装成功）
class UnboundAdapterError extends Error {
    constructor(adapterId, boundIds) {
        super(`executor-bind: adapterId '${adapterId}' 未绑定真实 adapter（已绑定：${boundIds.join(', ') || '无'}）` +
            '—— 真执行拒绝静默降级；请补 adapter 绑定或把该 type 的路由收口到已绑定 adapter');
        this.name = 'UnboundAdapterError';
        this.adapterId = adapterId;
    }
}

// chat 型统一调用体：把 subtask 翻译成 adapter 的 chat 请求
function chatTask(subtask) {
    return {
        model: (subtask && subtask.params && subtask.params.model) || undefined,
        // 同上：subtask 可自带 token 上限（params.maxTokens），否则由档位声明兜底（见 tierDefs）
        maxTokens: (subtask && subtask.params && subtask.params.maxTokens) || undefined,
        messages: [{ role: 'user', content: (subtask && subtask.prompt) || '' }],
    };
}

// 端口可解析性护栏：adapter 的端口来自「候选探测 + 注入端口」，两者都空时会连到 http 默认 80，
// 报错形如 ECONNREFUSED 127.0.0.1:80 —— 极难诊断（看不出是哪个 adapter、缺哪个 env）。
// 这里提前显式报错，把「缺配置」和「下游没起」分开。
function assertResolvable(adapter, adapterId, envName) {
    const hasCandidates = Array.isArray(adapter.portCandidates) && adapter.portCandidates.length > 0;
    if (!hasCandidates && adapter.injectedPort == null) {
        throw new Error(`executor-bind: adapter '${adapterId}' 无可用端口（候选为空且未注入 port）——` +
            `请设置 env ${envName}（如 ${envName}=18790）；拒绝连默认 80 端口`);
    }
}

// 绑定表：adapterId → { kind, build(), invoke(adapter, subtask, ctx) }
// 端口 env 可覆盖（PROXY_H3WEB_PORTS / PROXY_CODEX_PORTS / PROXY_CLAUDE_PORTS），格式 "8731,8732"。
const BINDING_DEFS = [
    {
        adapterId: 'h3web',
        kind: 'task-queue',
        desc: 'H3Web 本地视频引擎（/api/gen + /api/status 异步 job）',
        envName: 'PROXY_H3WEB_PORTS',
        build: () => new H3webAdapter({
            id: 'h3web',
            portCandidates: envPorts('PROXY_H3WEB_PORTS', [8731, 8732]),
            capabilities: ['video', 'text2video', 'lipsync', 'image', 'compose'],
        }),
        invoke: async (adapter, subtask) => {
            const r = await adapter.run(
                { type: subtask.type, prompt: subtask.prompt },
                { pollMs: Number(process.env.PROXY_H3WEB_POLL_MS || 2000), maxTries: Number(process.env.PROXY_H3WEB_MAX_TRIES || 600) },
            );
            return { kind: 'task-queue', taskId: r.task_id, status: r.status, output: r.output || null, raw: r };
        },
    },
    {
        adapterId: 'codex',
        kind: 'chat',
        desc: 'Codex L1 chat 代理（OpenAI 兼容 /v1/chat/completions，x-proxy-auth）',
        envName: 'PROXY_CODEX_PORTS',
        build: () => new L1AgentAdapter({
            id: 'codex',
            portCandidates: envPorts('PROXY_CODEX_PORTS', [18790, 18791]),
            chatPath: '/v1/chat/completions',
            // 超时来自底座：不显式超时 / 超时小于真实生成耗时都会制造僵尸请求
            //（客户端断开 ≠ 取消，Ollama/上游仍跑完 → 串行队列被堵，见 runbook §4.5.1）
            timeoutMs: (resolveExecutorDefault('codex') || {}).timeoutMs || undefined,
            token: process.env.PROXY_AUTH_TOKEN || undefined,
            capabilities: ['code', 'review', 'test'],
        }),
        invoke: async (adapter, subtask) => {
            // ⚠️ model 必须给（2026-10-01 真开踩坑）：不给 → adapter 用兜底名 'default'
            // → 真 :18790 回 `Unsupported model: default` HTTP 400；而 mock-l1 不校验模型名，
            //   所以这个问题在 mock 时代的全部场景里都不会现形。**这就是真跑的意义。**
            const d = resolveExecutorDefault('codex') || {};
            const t = chatTask(subtask);
            const r = await adapter.invoke({
                ...t,
                model: t.model || d.model,
                maxTokens: t.maxTokens || d.maxTokens,
            });
            return { kind: 'chat', agent: 'codex', content: r.result && r.result.content, model: r.result && r.result.model, raw: r };
        },
    },
    {
        adapterId: 'claude',
        kind: 'chat',
        desc: 'Claude 全家桶（Anthropic /v1/messages，x-api-key）',
        envName: 'PROXY_CLAUDE_PORTS',
        build: () => new ClaudeAdapter({
            id: 'claude',
            portCandidates: envPorts('PROXY_CLAUDE_PORTS', []),
            apiKey: process.env.ANTHROPIC_API_KEY || undefined,
            timeoutMs: (resolveExecutorDefault('claude') || {}).timeoutMs || undefined,
            capabilities: ['code', 'writing', 'test'],
        }),
        invoke: async (adapter, subtask) => {
            // 与 codex 同源纪律：model/maxTokens 由底座收口（真 model 名，绝不落到兜底名）
            const d = resolveExecutorDefault('claude') || {};
            const t = chatTask(subtask);
            const r = await adapter.invoke({
                ...t,
                model: t.model || d.model,
                maxTokens: t.maxTokens || d.maxTokens,
            });
            return { kind: 'chat', agent: 'claude', content: r.result && r.result.content, model: r.result && r.result.model, raw: r };
        },
    },
];

// ---- 三档 text-tier（runbook §4.5 待办 6，2026-10-01 拍板「复用 l1-agent」）----
// 为什么复用而不是各写一个 adapter：三档**协议完全相同**（OpenAI 兼容 chat），
// 实测差异只有 {port, model} → 写三个类是复制三份同款 HTTP 代码（违反 DRY，且无定制需求）。
//   agnes(small) / deepseek(medium) → codex-proxy :18790（它按 model 名转发到付费外网）
//   qwen(large)                    → 本地 Ollama :11434（qwen3.8:27b-mlx，无鉴权、0 成本）
// 端口/模型/鉴权全部来自共享底座 tierBindings，不在这里硬编码。
function tierDefs() {
    if (!isTierBindOpen()) return [];   // 默认关 → 三档仍抛 UnboundAdapterError（零行为变更）
    const tiers = resolveTierBindings();
    return Object.entries(tiers).map(([tier, b]) => ({
        adapterId: b.adapterId,
        kind: 'chat',
        desc: `text-tier ${tier}：${b.desc}`,
        envName: b.envName,
        build: () => new L1AgentAdapter({
            id: b.adapterId,
            portCandidates: b.ports,
            chatPath: '/v1/chat/completions',
            // 超时也来自底座：本地 27B 档给 300s（真实生成耗时可能上百秒，
            // 给小了会制造僵尸请求 → 串行 runner 被堵 → 后续全排队，见 routing-base 注释）
            timeoutMs: b.timeoutMs || undefined,
            // 本地档（Ollama）无鉴权概念，不带 x-proxy-auth；代理档沿用 PROXY_AUTH_TOKEN
            token: b.auth === 'none' ? undefined : (process.env.PROXY_AUTH_TOKEN || undefined),
            capabilities: ['text', 'plan'],
        }),
        invoke: async (adapter, subtask) => {
            const t = chatTask(subtask);
            // 档位默认 model 兜底：subtask.params.model 优先，否则用底座声明的档位模型。
            // maxTokens 同理（不给的话推理型模型会把预算喂给 thinking → /v1 层挂起，见 l1-agent-adapter 注释）
            const r = await adapter.invoke({
                ...t, model: t.model || b.model, maxTokens: t.maxTokens || b.maxTokens,
            });
            return {
                kind: 'chat', tier, agent: b.adapterId,
                content: r.result && r.result.content,
                contentSource: r.result && r.result.contentSource,  // 'content' | 'reasoning' | null
                model: r.result && r.result.model,
                raw: r,
            };
        },
    }));
}

// 默认绑定表 = 真实 adapter + （门控开时）三档 tier
function defaultDefs() {
    return [...BINDING_DEFS, ...tierDefs()];
}

// 造一个绑定好的 executor。
// opts.logger：可选（默认静默）；opts.defs：注入自定义绑定表（测试用）。
// 返回：
//   executor(adapterId, subtask, ctx)        → MCP 入口（McpServer 注入）用
//   forOrchestrator(routeEngine)             → REST 入口（Orchestrator 注入）用：(subtask, ctx) 形态
//   boundIds / describe()                    → 运维可见性：到底绑了谁
function createBoundExecutor(opts = {}) {
    const { logger = { log: () => {}, warn: () => {} }, defs = defaultDefs() } = opts;
    const instances = new Map();   // adapterId → adapter 实例（懒构造 + 缓存，跨任务复用）

    const bindingOf = (adapterId) => defs.find((d) => d.adapterId === adapterId);
    const boundIds = () => defs.map((d) => d.adapterId);

    // 懒构造：第一次用到才 new（构造期不触网）
    function adapterFor(adapterId) {
        if (instances.has(adapterId)) return instances.get(adapterId);
        const def = bindingOf(adapterId);
        const inst = def.build();
        instances.set(adapterId, inst);
        return inst;
    }

    // MCP 入口形态：(adapterId, subtask, ctx)
    const executor = async (adapterId, subtask, ctx) => {
        const def = bindingOf(adapterId);
        if (!def) throw new UnboundAdapterError(adapterId, boundIds());
        const adapter = adapterFor(adapterId);
        assertResolvable(adapter, adapterId, def.envName);
        logger.log && logger.log(`[executor-bind] ${adapterId}.${def.kind} ← subtask ${subtask && subtask.id}`);
        const value = await def.invoke(adapter, subtask, ctx);
        return { adapterId, bound: true, ...value };
    };

    // REST 入口形态：Orchestrator 的 executor 是 (subtask, ctx)，路由得自己做（无 McpServer 包装）。
    // 与 McpServer._realExecutor 同语义：route 选不出 → 按 decision.rejected/noCandidate 硬失败。
    const forOrchestrator = (routeEngine) => async (subtask, ctx) => {
        if (!routeEngine) throw new Error('executor-bind: forOrchestrator 需要 routeEngine');
        const decision = routeEngine.route(subtask);
        if (!decision || decision.rejected) {
            throw new Error(`executor-bind: 路由拒绝执行 subtask ${subtask && subtask.id}` +
                `（${decision && decision.noCandidateReason || 'no candidate'}）`);
        }
        const chosen = decision.chosen;
        if (!chosen || !chosen.adapterId) throw new UnboundAdapterError('(no candidate)', boundIds());
        return executor(chosen.adapterId, subtask, ctx);
    };

    const describe = () => defs.map((d) => ({ adapterId: d.adapterId, kind: d.kind, desc: d.desc }));

    return { executor, forOrchestrator, boundIds, describe, UnboundAdapterError };
}

module.exports = {
    createBoundExecutor,
    isExecutorBindOpen,
    isTierBindOpen,
    tierDefs,
    defaultDefs,
    UnboundAdapterError,
    BINDING_DEFS,
};
