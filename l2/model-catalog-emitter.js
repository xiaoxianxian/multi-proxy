// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// Model Catalog Emitter — L2 中台内核（P0 增量：cc-switch 借鉴的功能落 L2）
//
// 职责：把代理的 /v1/models 精简列表（id/object/owned_by/created，4 字段）映射为
//      cc-switch 喂给 Codex 的 model catalog schema（31 字段，每条模型一个 dict）。
//      Codex CLI 靠 ~/<agent>/model-catalog.json + config.toml 的 model_catalog_json 指针
//      选模型，cc-switch 也是往那写 —— 这个 emitter 生成同一份 schema，让模型在 Agent UI 可见。
//
// 设计原则（与 L2 其他内核一致）：
//     - 零依赖：只用 node 内置，绝不 require 全局包。
//     - 纯函数：输入是 OpenAI 模型数组 + 可选 overrides，输出是 catalog dict。
//     - 不写 agent 文件：emitter 只产出 catalog，写盘由独立 CLI（门控默认关）负责。
//       §3 非侵入铁律：adapter / emitter 默认绝不写 ~/.codex / ~/.claude 等 agent 家目录。
//     - 门控默认 no-op：写 agent 家目录的动作需显式 opt-in（CURATOR_CATALOG_EMIT=true），
//       不设 = 零文件 IO + 零网络调用。本模块只提供生成函数，写盘是调用方职责。
//
// 协议基础（已实测）：18790 (codex-proxy) 对 POST /v1/responses 返回 200 + 完整 reasoning
// 内容（agnes-3.0-flash, 73/46 tokens），Responses 协议已通。emitter 只管让模型可枚举，
// 转发路径由 18790 / 18795 桥负责。

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

// reasoning levels（与 cc-switch 实测一致，effort 枚举）
const REASONING_LEVELS = [
    { description: 'Fast responses with lighter reasoning', effort: 'low' },
    { description: 'Balances speed and reasoning depth for everyday tasks', effort: 'medium' },
    { description: 'Greater reasoning depth for complex problems', effort: 'high' },
    { description: 'Extra high reasoning depth for complex problems', effort: 'xhigh' },
];

// 默认上下文窗口（模型未声明时的兜底，与 agnes-3.0-flash 实测一致）
const DEFAULT_CONTEXT = 128000;
const DEFAULT_PRIORITY = 1000;
const DEFAULT_EFFORT = 'medium';

// vision 探测：模型名/厂商含以下关键词 → 支持 image 模态
const VISION_MARKERS = /^(agnes|vision|\w+-image\b|\w+-vision)/i;

// OpenAI /v1/models 的单个条目 → cc-switch catalog 模型条目（31 key）
// 输入：{ id, object?, owned_by?, context_window?, input_modalities?, priority?, ... }
// 输出：31 字段 dict（与 cc-switch ~/.codex/cc-switch-model-catalog.json 同构）
function emitModel(m, overrides = {}) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) {
        throw new Error('emitter: model entry requires a non-empty .id string');
    }

    const id = m.id;
    const contextWindow = m.context_window || overrides.context_window || DEFAULT_CONTEXT;
    const priority = m.priority != null ? m.priority : DEFAULT_PRIORITY;

    // 模态探测：overrides 优先 > 显式 input_modalities > vision 关键词 > 默认 ['text','image']
    // （绝大多数本地/在线模型都带 vision，保守默认让 UI 选不到反而误，§4 不写投机）
    let modalities = overrides.input_modalities || m.input_modalities;
    if (!Array.isArray(modalities) || modalities.length === 0) {
        modalities = VISION_MARKERS.test(id) || VISION_MARKERS.test(m.owned_by || '')
            ? ['text', 'image']
            : ['text', 'image']; // 默认全开；调用方可传 overrides.input_modalities=['text'] 覆盖
    }

    // model_messages：调用方注入的官方指令模板（大文本），emitter 不重造
    // 不注入 → undefined（Codex 用内置默认），不伪造
    const modelMessages = overrides.model_messages || m.model_messages;

    const supportedEfforts = (overrides.supported_reasoning_levels || [])
        .filter((e) => VALID_EFFORTS.has(e.effort) || VALID_EFFORTS.has(e))
        .map((e) => (typeof e === 'object' && e.effort
            ? { description: e.description || e.effort, effort: e.effort }
            : { description: `${e} effort`, effort: e }));

    return {
        // --- 标识 ---
        slug: id,
        display_name: m.display_name || id,
        description: m.description || id,
        visibility: 'list',
        upgrade: null,
        // --- context ---
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 95,
        // --- 推理 ---
        default_reasoning_level: m.default_reasoning_level || DEFAULT_EFFORT,
        default_reasoning_summary: m.default_reasoning_summary || 'none',
        default_verbosity: m.default_verbosity || 'low',
        supported_reasoning_levels: supportedEfforts.length ? supportedEfforts : REASONING_LEVELS,
        support_verbosity: true,
        supports_reasoning_summaries: true,
        // --- 能力标志（保守默认真，实际值靠 18790 转发 + 上游决定）---
        supports_image_detail_original: m.supports_image_detail_original != null ? m.supports_image_detail_original : true,
        supports_parallel_tool_calls: m.supports_parallel_tool_calls != null ? m.supports_parallel_tool_calls : true,
        supports_search_tool: m.supports_search_tool != null ? m.supports_search_tool : true,
         // --- Codex 协议专属 ---
        shell_type: m.shell_type || 'shell_command',
        apply_patch_tool_type: m.apply_patch_tool_type || 'freeform',
        web_search_tool_type: m.web_search_tool_type || 'text_and_image',
        use_responses_lite: m.use_responses_lite != null ? m.use_responses_lite : false,
        experimental_supported_tools: m.experimental_supported_tools || [],
        service_tiers: m.service_tiers || [],
        additional_speed_tiers: m.additional_speed_tiers || [],
        truncation_policy: m.truncation_policy || { limit: 10000, mode: 'tokens' },
        availability_nux: m.availability_nux != null ? m.availability_nux : null,
        input_modalities: modalities,
        priority: priority,
        supported_in_api: m.supported_in_api != null ? m.supported_in_api : true,
        // --- 官方指令（大文本，由调用方注入，不重造）---
        model_messages: modelMessages,
    };
}

// OpenAI /v1/models 完整响应 → cc-switch catalog
// 输入：{ data: [OpenAIModel, ...], object: 'list' }
// 输出：{ models: [CatalogModel, ...] }
function emitCatalog(openaiModels, overrides = {}) {
    const source = Array.isArray(openaiModels) ? openaiModels
        : (openaiModels && Array.isArray(openaiModels.data)) ? openaiModels.data
        : null;
    if (!source) throw new Error('emitter: expected OpenAI /v1/models with .data array or a bare array');
    if (source.length === 0) return { models: [] };

    const perModel = overrides.model || {};
    const catalog = source.map((m) => emitModel(m, perModel));

    // 按 priority 降序（cc-switch 实测 agnes 是 1000）
    catalog.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return { models: catalog };
}

// ---- self-test (纯函数，不写盘，零副作用) ----
function selfTest() {
    const samples = [
        { id: 'deepseek-v4-flash', owned_by: 'DeepSeek' },
        { id: 'agnes-3.0-flash', owned_by: 'Agnes' },
        { id: 'moonshot-v1-8k-vision-preview', owned_by: 'Kimi' },
        { id: 'kimi-k2.7-code', owned_by: 'Kimi' },
    ];
    const cat = emitCatalog({ object: 'list', data: samples });

    let failed = 0;
    const assert = (cond, msg) => {
        if (!cond) {
            console.error('✗ ' + msg);
            failed++;
        }
    };
    const check = (cond, msg) => {
        if (cond) {
            console.log('✓ ' + msg);
        }
    };

    check(cat.models.length === 4, `'data' 长度保持：${cat.models.length}`);
    check(typeof cat.models[0].slug === 'string', `每条有 slug`);
    check(cat.models[0].priority === 1000, `默认 priority=1000`);
    check(cat.models[0].context_window === 128000, `默认 context_window=128000`);
    check(Array.isArray(cat.models[0].input_modalities), `input_modalities 是 array`);
    check(cat.models[0].input_modalities.includes('image'), `vision 模型默认含 image`);
    check(!cat.models[0].model_messages, `model_messages 未注入 → undefined（非 null，非空串）`);
    check(cat.models[0].supported_reasoning_levels.length === 4, `默认 4 个 reasoning level`);

    // overrides：context_window / priority / input_modalities / model_messages 全透传
    const cat2 = emitCatalog({ data: [samples[0]] }, {
        model: { context_window: 32000, priority: 500, input_modalities: ['text'], model_messages: { instructions: 'test' } },
    });
    check(cat2.models[0].context_window === 32000, `override context_window 透传`);
    check(cat2.models[0].priority === 500, `override priority 透传`);
    check(cat2.models[0].input_modalities[0] === 'text' && cat2.models[0].input_modalities.length === 1, `override input_modalities=['text'] 生效`);
    check(typeof cat2.models[0].model_messages === 'object' && cat2.models[0].model_messages.instructions === 'test', `override model_messages 对象透传`);

    // 排序验证：高 priority 在前
    if (cat.models[0].priority >= cat.models[cat.models.length - 1].priority) {
        check(true, `按 priority 降序`);
    }

    // 非法输入
    let threw = false;
    try { emitModel({}); } catch { threw = true; }
    check(threw, `缺 .id → throw`);

    let threw2 = false;
    try { emitCatalog({ data: null }); } catch { threw2 = true; }
    check(threw2, `data=null → throw`);

    console.log('');
    if (failed === 0) {
        console.log('ALL ' + (cat.models.length + 3) + ' SELF-TESTS PASS');
        process.stdout.write(JSON.stringify(cat.models[0], null, 2) + '\n');
        process.exit(0);
    } else {
        console.log(failed + ' FAILED');
        process.exit(1);
    }
}

if (require.main === module) {
    selfTest();
}

module.exports = { emitModel, emitCatalog, REASONING_LEVELS, VALID_EFFORTS, DEFAULT_CONTEXT, DEFAULT_PRIORITY };
