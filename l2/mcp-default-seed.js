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
//      三者 capabilityTags 全为 ['text']，与 h3web(video/image)/codex(code/review) 能力标签
//      不冲突：text 任务按档位分档，非 text 任务仍走 h3web/codex，向后兼容零破坏。
//
// 非侵入：纯函数，只写注入的 registry（中枢自己的内存注册表），不写任何 agent 文件。
// 幂等：create 对重复 id 抛错。调用方在「每个 server 实例构造一次」的语义下用，无重复 seed 风险；
//        若 id 已存在，跳过该 id（容错，不抛）—— 便于同一 registry 多次 seed / 测试重置复用。

// 三档 text-tier profile（complexity 路由落点，见 COMPLEXITY-MODE.md §2.1 cost 梯度）
const TIER_PROFILES = [
   { id: 'agnes',    name: 'Agnes (small)',  type: 'custom', adapterId: 'agnes',
     modelTier: 'small',  modelType: 'text', capabilityTags: ['text'],
     description: 'complexity 档位：small —— 简单/高频文本任务，最低成本档' },
   { id: 'deepseek', name: 'DeepSeek (medium)', type: 'custom', adapterId: 'deepseek',
     modelTier: 'medium', modelType: 'text', capabilityTags: ['text'],
     description: 'complexity 档位：medium —— 常规文本任务，默认档' },
   { id: 'qwen',     name: 'Qwen3.8 (large)',  type: 'custom', adapterId: 'qwen',
     modelTier: 'large',  modelType: 'text', capabilityTags: ['text'],
     description: 'complexity 档位：large —— 复杂/高要求文本任务，最高质量档' },
];

// 真实 adapter 能力（与 mcp-server.js require.main 历史 seed 对齐）
const ADAPTER_PROFILES = [
   { id: 'h3web', name: 'H3Web', type: 'custom', adapterId: 'h3web',
     capabilityTags: ['video', 'text2video', 'image'], description: 'H3Web 文/图/视频本地引擎' },
   { id: 'codex', name: 'Codex', type: 'codex',  adapterId: 'codex',
     capabilityTags: ['code', 'review'],              description: 'Codex 代码 agent' },
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
