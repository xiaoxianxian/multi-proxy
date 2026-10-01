'use strict';

// RoutingBase — L2 共享底座（质量工程 §三 / DESIGN-MEMO 落点 2）。
//
// 职责：把散落在 decomposer.js / route-engine.js / adapters/*.js 的「业务路由」硬编码
//   （需求→DAG 模板、complexity→tier 映射、adapter 默认能力/模型）收口到唯一可版本化数据源。
//
// 修订规则（铁律）：任何路由 / failover / 档位变更**只改这里**（或经 update()），
//   不许再改 decomposer.js / route-engine.js / adapters/*.js 的硬编码。
//
// 版本快照：每次 update() 自动把当前定义压入 history，rollback() 一键回上一版（只换一处）。
//
// 设计原则（与 l2 内核同构）：
//   - 零依赖：纯数据 + 小助手，不 require 任何项目模块（杜绝循环依赖）。
//   - 零行为变更：初始值与原各文件硬编码**逐字一致**（迁移即搬运，不改一个值）。
//   - 消费方实时读：templates/fallback 经 ROUTING_BASE 引用实时取值，update() 后即刻生效。

const ROUTING_BASE = {
    version: 1,
    updatedAt: '2026-09-30',
    note: '初始收口：从 decomposer.js / route-engine.js / claude-adapter.js / l1-agent-adapter.js 逐字迁移，零行为变更；2026-10-01 无候选默认策略 observe→reject（观察态真跑归零后拍板）',

    // ---- 需求 → DAG 模板（原 l2/decomposer.js BUILTIN_TEMPLATES，逐字迁移）----
    templates: [
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
    ],

    // ---- 兜底模板（原 l2/decomposer.js FALLBACK_TEMPLATE，逐字迁移）----
    fallback: {
        name: 'single',
        match: () => true,
        build: (input) => [{ id: 'main', type: 'code', complexity: 'medium', prompt: String(input).slice(0, 80), deps: [] }],
    },

    // ---- complexity → modelTier（原 l2/route-engine.js _mapTier，逐字迁移）----
    complexityTierMap: { low: 'small', medium: 'medium', high: 'large' },

    // ---- adapter 默认能力/模型（原 claude-adapter.js:87/:213、l1-agent-adapter.js:78/:183，逐字迁移）----
    adapterDefaults: {
        claude: { capabilities: ['code', 'writing'], defaultModel: 'claude-3-5-sonnet-latest' },
        'l1-agent': { capabilities: ['code', 'writing'], defaultModel: 'default' },
    },

    // ---- 档位 → 下游绑定（tierBindings，2026-10-01 新增；runbook §4.5 待办 6 的落点）----
    // 三档 text-tier profile（agnes=small / deepseek=medium / qwen=large，见 mcp-default-seed.js
    // TIER_PROFILES）此前只有**路由落点**、没有**执行落点** → 真执行抛 UnboundAdapterError。
    // 三档的下游收口在这里，理由（2026-10-01 curl 真探，非代码推断）：
    //   ① 三档**协议完全相同**（OpenAI 兼容 chat），差异只有 {port, model} → 不需要三个 adapter 类；
    //   ② agnes / deepseek 的下游现成：`codex-proxy :18790` 已按 model 名转发到
    //      apihub.agnes / api.deepseek（实测 chat 端点可用、鉴权开放）；
    //   ③ qwen 的下游现成：本地 `Ollama :11434`（实测 /v1/chat/completions 无鉴权可用）。
    // 端口可被 env 覆盖（逗号分隔）：PROXY_AGNES_PORTS / PROXY_DEEPSEEK_PORTS / PROXY_QWEN_PORTS。
    // ⚠️ agnes/deepseek 经 codex-proxy 打**付费外网**；qwen 走本地，**0 成本**。
    //   `PROXY_TIER_LOCAL_ONLY=1` → 三档全指本地 qwen 端口/模型（0 成本演练，绝不碰付费上游）。
    tierBindings: {
        small: {
            adapterId: 'agnes', defaultPorts: [18790], model: 'agnes-2.0-flash',
            envName: 'PROXY_AGNES_PORTS', auth: 'proxy-auth', maxTokens: 2048, timeoutMs: 120000,
            desc: 'Agnes（small · 免费档；经 codex-proxy 转发 apihub.agnes-ai.com）',
        },
        medium: {
            adapterId: 'deepseek', defaultPorts: [18790], model: 'deepseek-v4-pro',
            envName: 'PROXY_DEEPSEEK_PORTS', auth: 'proxy-auth',
            // 同 codex：推理模型会拿 thinking 吃掉整个预算，2048 实测必以
            // finish_reason=length 收场且正文为空。see executorDefaults.codex 注释。
            maxTokens: 8192, timeoutMs: 180000,
            desc: 'DeepSeek（medium · 中档；经 codex-proxy 转发 api.deepseek.com）',
        },
        // 本地档 timeoutMs 给到 300s：实测 2048 token 上限下约 57s 完成，但**超时必须大于真实生成
        // 耗时**——否则客户端断开、Ollama 侧继续跑完，runner 串行会把后续请求全堵住（雪崩）。
        // 宁可把超时放宽，也不要制造僵尸请求。
        large: {
            adapterId: 'qwen', defaultPorts: [11434], model: 'qwen3.8:27b-mlx',
            envName: 'PROXY_QWEN_PORTS', auth: 'none', maxTokens: 2048, timeoutMs: 300000,
            desc: 'Qwen3.8-27B（large · 本地 Ollama，无鉴权，0 成本）',
        },
    },

    // ---- 执行落点默认参数（executorDefaults，2026-10-01 真开暴露的同类坑）----
    // 教训同 tierBindings.maxTokens：**底座声明了 ≠ 出口透出了**。这次缺的是 model：
    //   BINDING_DEFS.codex 的 invoke 从不传 model → L1AgentAdapter 用 adapterDefaults 的
    //   兜底名 'default' → mock-l1 不校验模型名（所以 canary 64 个 mock 场景全绿），
    //   真 (:18790) 立刻 `{"error":"Unsupported model: default","code":"UNSUPPORTED_MODEL"}` HTTP 400。
    // 一句话：mock 全绿 ≠ 真能跑，缺的东西只在真账单那一步才现形。
    // 与 tierBindings 同构收口在底座（可被 update()/rollback() 管），env 可覆盖。
    executorDefaults: {
        // ⚠️ 上游实测现状（2026-10-01 真开当天 curl 逐个探，非推断）：
        //   :18790 背后 deepseek / kimi / moonshot / agnes **全部**回 401 或 429 且统一包一层
        //   {"error":"Upstream error","code":"UPSTREAM_ERROR"} —— 即代理本身活着，**上游 provider 的
        //   key / 额度 / 限流出了问题**。本地 :11434 的 qwen（large 档）稳定 200。
        //   → 默认 model 只保证「名字真实存在」；能不能真出内容取决于上游配额，两者别混为一谈。
        //   恢复后可用 env PROXY_CODEX_MODEL 临时改档，不必改代码。
        // ⚠️ 模型名只认官方 `/v1/models` 实测（2026-10-01 核对，别信代理自己吐的列表）：
        //   codex-proxy 的 UPSTREAM_MODELS 是**硬编码的过期名**（deepseek-v4-flash / moonshot-v1-*），
        //   官方早就没了 —— 照它配只会得到一个假存在、真转发必炸的模型名。
        //   DeepSeek 官方现役只有两个：deepseek-flash(V4.1-Flash) / deepseek-v4-pro(V4-Pro)。
        codex: {
            model: 'deepseek-flash',        // DeepSeek 官方 V4.1-Flash（实测 /v1/models 真存在）
            envName: 'PROXY_CODEX_MODEL',
            // ⚠️ maxTokens 是被实测证伪后调上来的（2026-10-01，DeepSeek 官方真跑）：
            //   给 2048 时复杂子任务必踩 `finish_reason=length` —— usage 显示
            //   **completion_tokens 2048 全部进了 reasoning_tokens**，模型还在想，正文一个字没写，
            //   而外层 status 仍是 done（静默空结果）。给到 8192 才有预算走完 thinking 再出正文。
            //   一句话：推理模型的 maxTokens 不是"回答长度上限"，是"思考 + 回答的总预算"。
            maxTokens: 8192,
            timeoutMs: 180000,     // 8192 预算下生成更久，超时必须跟着放宽（防僵尸请求堵队列）
            desc: 'Codex L1 chat 默认落点（经 codex-proxy :18790 转付费上游）',
        },
        claude: {
            model: 'claude-3-5-sonnet-latest',
            envName: 'PROXY_CLAUDE_MODEL',
            maxTokens: 2048,
            timeoutMs: 120000,
            desc: 'Claude chat 默认落点（需 ANTHROPIC_API_KEY）',
        },
    },

    // ---- 无候选兜底策略（质量工程 §四 待办②）----
    // route() 选不出 adapter 时怎么办。此前是**隐式行为**：chosen=null 却照样执行，
    // 最终表现为 executor 拿到 adapterId=null 的静默降级（无人报错、无从复盘）。
    //   'observe'：保持 chosen=null，只在 decision 上补诊断字段
    //            （noCandidate / noCandidateReason / noCandidatePolicy），便于事后审计。
    //   'fallback-default'：退到 defaultAdapterId（该 adapter 必须已在 registry 注册），
    //            decision.degraded=true —— 明示这不是能力匹配的结果，而是兜底。
    //   'reject'：decision.rejected=true，执行器据此硬失败，不再「无路由也执行」。
    //
    // ⚠️ 默认策略 2026-10-01 由 'observe' 切为 'reject'（维护者拍板）。前置条件已满足：
    //    观察态真跑（l2/OBSERVE-REPORT-2026-10-01.md）在补齐 compose owner 与 h3web 模态声明后
    //    error / warn / 无候选 **全部归零**（31 子任务 0 告警）——即「正常路径不会误伤」已被实测。
    //    切 reject 的语义代价：registry 未 seed / 能力缺失的环境里，子任务由「静默执行」变为
    //    「显式 hard fail」。这是刻意的（宁可显式失败，不要无路由也执行），且随时可回退：
    //    env PROXY_L2_NOCANDIDATE=observe 即可，无需改代码。
    // 运行时可用 env PROXY_L2_NOCANDIDATE 覆盖同一组取值（非法值报错，fail-fast）。
    noCandidatePolicy: { strategy: 'reject', defaultAdapterId: 'codex' },
};

const ALLOWED_NO_CANDIDATE = ['observe', 'fallback-default', 'reject'];

// 快照历史（仅内存；单进程语义，与 agent-registry 默认内存同构）
const _history = [];

function _snapshotCurrent() {
    return {
        version: ROUTING_BASE.version,
        updatedAt: ROUTING_BASE.updatedAt,
        note: ROUTING_BASE.note,
        templates: ROUTING_BASE.templates,
        fallback: ROUTING_BASE.fallback,
        complexityTierMap: ROUTING_BASE.complexityTierMap,
        adapterDefaults: ROUTING_BASE.adapterDefaults,
        noCandidatePolicy: ROUTING_BASE.noCandidatePolicy,
        tierBindings: ROUTING_BASE.tierBindings,
        executorDefaults: ROUTING_BASE.executorDefaults,
    };
}

// 复杂度 → 档位（消费方：route-engine._mapTier 委托到此；未知 complexity 归 medium）
function mapTier(complexity) {
    const m = ROUTING_BASE.complexityTierMap || {};
    return m[complexity] || 'medium';
}

// 无候选兜底策略解析：优先级 = 显式 override > env PROXY_L2_NOCANDIDATE > 底座默认值。
// 非法取值直接抛错（fail-fast）：宁可显式失败，也不要静默退回不可预期的行为。
function resolveNoCandidatePolicy(override) {
    const base = ROUTING_BASE.noCandidatePolicy || {};
    const raw = String(override || process.env.PROXY_L2_NOCANDIDATE || base.strategy || 'observe').toLowerCase();
    if (!ALLOWED_NO_CANDIDATE.includes(raw)) {
        throw new Error(`routing-base.resolveNoCandidatePolicy: unknown strategy "${raw}" (allowed: ${ALLOWED_NO_CANDIDATE.join(' | ')})`);
    }
    return { strategy: raw, defaultAdapterId: base.defaultAdapterId || null };
}

// adapter 默认声明（消费方：claude-adapter / l1-agent-adapter 构造与 invoke 默认值）
function adapterDefaults(adapterId) {
    return (ROUTING_BASE.adapterDefaults && ROUTING_BASE.adapterDefaults[adapterId]) || null;
}

// env 端口解析：'18790,18791' → [18790, 18791]；空 → 用默认候选（与 executor-bind 同款语义）
function envPorts(name, fallback) {
    const raw = String((process.env && process.env[name]) || '').trim();
    if (!raw) return fallback || [];
    const ports = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    return ports.length ? ports : (fallback || []);
}

// 三档下游绑定解析（消费方：executor-bind 的三档 binding）。
// 返回 { [tier]: { adapterId, model, ports, envName, auth, desc, localOnly } }。
// PROXY_TIER_LOCAL_ONLY=1 → 三档的 ports/model/auth 全部改用 large（本地 qwen）档：
//   语义是「0 成本演练」——验证三档链路都通，而不是验证档位分流（分流验证必须走真端口）。
function resolveTierBindings() {
    const raw = ROUTING_BASE.tierBindings || {};
    const v = String((process.env && process.env.PROXY_TIER_LOCAL_ONLY) || '').toLowerCase();
    const localOnly = v === '1' || v === 'true' || v === 'on';
    const local = raw.large || null;
    const out = {};
    for (const [tier, b] of Object.entries(raw)) {
        const src = localOnly && local ? local : b;
        out[tier] = {
            adapterId: b.adapterId,                    // adapterId 恒按原档位（绑定表三条仍在）
            model: src.model,
            ports: envPorts(src.envName, src.defaultPorts || []),
            envName: src.envName,
            auth: src.auth,
            desc: b.desc,
            // ⚠️ maxTokens / timeoutMs 必须一并透出（2026-10-01 真跑踩坑）：
            //   漏了 maxTokens → adapter 不传 max_tokens → 本地 27B 推理模型无上限生成 →
            //   单次调用轻松超过 adapter 超时；而**超时断开后 Ollama 侧仍在继续跑完**，
            //   runner 串行 → 后续请求全部排队，形成雪崩（实测一个超时请求能堵死整条队列数分钟）。
            maxTokens: src.maxTokens,
            timeoutMs: src.timeoutMs,
            localOnly,
        };
    }
    return out;
}

function resolveTierBinding(tier) {
    return resolveTierBindings()[tier] || null;
}

function resolveExecutorDefaults() {
    const raw = ROUTING_BASE.executorDefaults || {};
    const out = {};
    for (const [adapterId, d] of Object.entries(raw)) {
        const envModel = String((process.env && process.env[d.envName]) || '').trim();
        out[adapterId] = {
            adapterId,
            model: envModel || d.model,
            maxTokens: d.maxTokens,
            timeoutMs: d.timeoutMs,
            desc: d.desc,
        };
    }
    return out;
}

function resolveExecutorDefault(adapterId) {
    return resolveExecutorDefaults()[adapterId] || null;
}

// 修订：浅合并 patch → version+1，旧版自动进快照历史。返回新 version。
function update(patch, note) {
    if (!patch || typeof patch !== 'object') throw new Error('routing-base.update: patch object required');
    _history.push(_snapshotCurrent());
    for (const k of ['templates', 'fallback', 'complexityTierMap', 'adapterDefaults', 'noCandidatePolicy', 'tierBindings', 'executorDefaults']) {
        if (patch[k] !== undefined) ROUTING_BASE[k] = patch[k];
    }
    ROUTING_BASE.version += 1;
    ROUTING_BASE.updatedAt = new Date().toISOString().slice(0, 10);
    ROUTING_BASE.note = note || ROUTING_BASE.note;
    return ROUTING_BASE.version;
}

// 回滚：恢复到最近一次 update 前的定义。无历史返回 null。
function rollback() {
    if (!_history.length) return null;
    const prev = _history.pop();
    ROUTING_BASE.templates = prev.templates;
    ROUTING_BASE.fallback = prev.fallback;
    ROUTING_BASE.complexityTierMap = prev.complexityTierMap;
    ROUTING_BASE.adapterDefaults = prev.adapterDefaults;
    ROUTING_BASE.noCandidatePolicy = prev.noCandidatePolicy;
    ROUTING_BASE.tierBindings = prev.tierBindings;
    ROUTING_BASE.executorDefaults = prev.executorDefaults;
    ROUTING_BASE.version = prev.version;
    ROUTING_BASE.updatedAt = prev.updatedAt;
    ROUTING_BASE.note = prev.note;
    return ROUTING_BASE.version;
}

// 历史概览（版本/日期/备注，不含全量数据）
function history() {
    return _history.map((h) => ({ version: h.version, updatedAt: h.updatedAt, note: h.note }));
}

module.exports = {
    ROUTING_BASE, mapTier, adapterDefaults, resolveNoCandidatePolicy,
    resolveTierBindings, resolveTierBinding, envPorts,
    resolveExecutorDefaults, resolveExecutorDefault,
    update, rollback, history,
};
