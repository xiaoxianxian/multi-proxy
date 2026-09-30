'use strict';

// L2 P3 · MCP Bridge 默认能力 seed（单一来源）
// 把「管理台/stdio 默认注册哪些 agent profile」收敛到一处，
// 避免 mcp.js（manager 接线）与 mcp-server.js（stdio 入口）各自内联、各改其半导致漂移。
//
// 含两类 profile：
//   1. 真实 adapter 能力（h3web / codex）：让 routeTask / tools/call 路由到真实 adapter。
//   2. 三档 text-tier profile（agnes / deepseek / qwen）：complexity 路由的生产落点（see ③）。
//      COMPLEXITY-MODE.md §2.1 的 cost 梯度映射——把 complexity 难度映射到档位：
//        low(简单)→small / medium(默认·未知)→medium / high(复杂)→large。
//      三档文本 agent capabilityTags 含 'plan'（D2 解法①，09-29 维护者拍板）：decomposer 文本
//      stage（understand/storyboard 等）产出 type='plan'，档位路由 tagMatch 需 capabilityTags
//      含 task.type，故三档补 'plan' 以承接文本 stage；原 'text' 保留，向后兼容。
//      与 h3web(video/image)/codex(code/review) 能力标签不冲突，plan 任务此前无 agent 承接
//      （纯增量，不夺现有路由）。
//
// 非侵入：纯函数，只写注入的 registry（中枢自己的内存注册表），不写任何 agent 文件。
// 幂等：create 对重复 id 抛错。调用方在「每个 server 实例构造一次」的语义下用，无重复 seed 风险；
//        若 id 已存在，跳过该 id（容错，不抛）—— 便于同一 registry 多次 seed / 测试重置复用。

// 三档 text-tier profile（complexity 路由落点，见 COMPLEXITY-MODE.md §2.1 cost 梯度）
const TIER_PROFILES = [
   { id: 'agnes',    name: 'Agnes (small)',  type: 'custom', adapterId: 'agnes',
    modelTier: 'small',  modelType: 'text', capabilityTags: ['text', 'plan'],
    description: 'complexity 档位：small —— 简单/高频文本任务，最低成本档' },
   { id: 'deepseek', name: 'DeepSeek (medium)', type: 'custom', adapterId: 'deepseek',
    modelTier: 'medium', modelType: 'text', capabilityTags: ['text', 'plan'],
    description: 'complexity 档位：medium —— 常规文本任务，默认档' },
   { id: 'qwen',     name: 'Qwen3.8 (large)', type: 'custom', adapterId: 'qwen',
    modelTier: 'large',  modelType: 'text', capabilityTags: ['text', 'plan'],
    description: 'complexity 档位：large —— 复杂/高要求文本任务，最高质量档' },
];

// 真实 adapter 能力（与 mcp-server.js require.main 历史 seed 对齐）
const ADAPTER_PROFILES = [
   { id: 'h3web', name: 'H3Web', type: 'custom', adapterId: 'h3web',
    // 模态/档位声明（2026-10-01 补，观察态真跑 §4.2 缺口 B）：
    //   此前只有 capabilityTags、没写 modelType → route-engine 算 modelTypeMatch=(undefined==='multimodal')=false
    //   → 2.2 语义审阅把「视频任务派给 h3web」判成 error「h3web is text-only」。这是**假阳性**：
    //   h3web 是本地视频引擎，缺的是声明不是能力。补 modelType:'multimodal' 后误报消失。
    //   modelTier:'large' 同理：视频生成属重活，期望档位即 large，补上后 tier gap warn 一并归零。
    //   ⚠️ 影响面：这两个字段参与候选排序（modelTypeMatch → tierMatch → confidence），
    //   属业务路由声明变更，由维护者 2026-10-01 拍板后才动。
    modelType: 'multimodal', modelTier: 'large',
    // 'compose'（同日补，§4.2 缺口 A）：video-workflow 的合成节点（compose: 合成+音频）
    //   此前无任何 profile 承接 → 路由无候选（切 reject 会硬失败）。拍板归 h3web 承接
    //   （视频合成属视频域；与 adapter 自身 capabilities 同步补，见 h3web-adapter.js:78）。
    capabilityTags: ['video', 'text2video', 'image', 'compose'],
    description: 'H3Web 文/图/视频本地引擎（含视频合成 compose）' },
   { id: 'codex', name: 'Codex', type: 'codex',  adapterId: 'codex',
    // 'test'（2026-10-01 补）：decomposer 模板产出的 unit-test 子任务 type='test'，
    // 此前无 profile 承接 → route() 无候选、却仍被 executor 执行（routedAdapterId=null）。
    // 与三档 tier 补 'plan' 属同一类问题（见文件头 12-16 行）：写单测归 code 能力族，
    // 故由声明 'code' 的 profile 承接（codex + claude），纯增量、不夺现有路由。
    capabilityTags: ['code', 'review', 'test'],     description: 'Codex 代码 agent' },
     // v2-M5 R3-b：Claude 全家桶（Anthropic Messages API / claude-code / claude-desktop）。
     // type='custom' 而非 'claude'——AGENT_TYPES 封闭白名单 = codex/hermes/cursor/custom
     //（改 core 违反 0 副作用），语义区分靠 id/adapterId='claude'，同 h3web/三档 tier 惯例。
     // 门控关：dormant，经 PROXY_L2_MCP 门控关闭时不进入路由决策面，不改变现有行为。
    { id: 'claude', name: 'Claude', type: 'custom', adapterId: 'claude',
     // 'test' 同上：Claude 亦属 code 能力族，一并承接 'test'（门控关时 dormant，不影响现有行为）。
     capabilityTags: ['code', 'writing', 'test'],   description: 'Claude 全家桶（code/writing 能力，anthropic 协议，见 l2/adapters/claude-adapter.js）' },
];

// 全部默认 profile（adapter + 三档 tier）。单一来源，两处共用。
const DEFAULT_PROFILES = [...ADAPTER_PROFILES, ...TIER_PROFILES];

// 把默认 profile seed 进 registry。容错：已存在的 id 跳过（不抛），保证幂等/可复用。
function seedDefaultProfiles(registry, profiles = DEFAULT_PROFILES) {
   const seeded = [];
   for (const p of profiles) {
    if (registry.list().some((x) => x.id === p.id)) continue;   // 已存在 → 跳过（幂等）
    registry.create(p);
    seeded.push(p.id);
   }
   return seeded;
}

module.exports = {
   seedDefaultProfiles,
   DEFAULT_PROFILES,
   ADAPTER_PROFILES,
   TIER_PROFILES,
};
