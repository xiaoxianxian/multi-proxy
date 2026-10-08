// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// Curator pack handler · Capability 面（onToolOutput）· 工具执行许可门禁
//
// 为什么有这一个（跟 capability-tool.js 的分工）：
//   capability-tool.js 在同 hook 裁「工具输出长度」；本 handler 裁「工具有没有资格跑」。
//   两者同面（onToolOutput）、同粒度（ctx.toolName + ctx.rawOutput），互不冲突。
//
// 边界（诚实说明，不阉割也不夸大）：
//   - onToolOutput 阶段 ctx.toolName 是真实可用的（capability-tool.js 已经在用它），
//     所以本 handler 是「真实挂点」，不是读不到 tools 的空过滤。
//   - 但 onToolOutput 是「工具已执行、输出回写前」这一刻 —— 它是**事后拦输出**，
//     不是「事前拦执行」。真实执行发生在 harness 内部（tool-output-guard.js:16-19
//     已写明桥看不见那段），事前执行拦截归 harness 职责，本 handler 不越界。
//   - 本 handler 的定位 = 「桥层能看到的工具能力边界门禁」：未授权工具的输出在回写前
//     被替换为拒绝标记，下游 agent 拿到的是明确拒绝而非静默数据 —— 这正好对齐
//     外部文《Harness 控制面》讲的「Control Plane 管权限」那一层（在 multi-proxy 里
//     叫「工具能力控制面」，避免与 token 成本控制层撞名，见四视角审校流程第 46 条）。
//
// 非侵入铁律④：默认 enabled:false + mode:'pass'，零行为变更。

const params = {
    mode: 'pass',                    // 'pass' = 关（passthrough）；'deny' = 按 denyTools 拦；'allow' = 只放行 allowTools
    denyTools: '',                   // 逗号分隔的工具名清单（mode='deny' 时生效）
    allowTools: '',                  // 逗号分隔的工具名清单（mode='allow' 时生效）
    rejectMessage: '[工具未授权 · 已被工具能力控制面拦截]',
};

// ⚠️ 参数只认自己的 env（与 tool-output-guard / tools-lazyload 的 ENV_OVERRIDE 同一套约定，
// 见 tools/token-policy-bridge.js:65 的既有说明）。默认全关 = passthrough，零行为变更。
if (process.env.CURATOR_TOOL_GATE_MODE) params.mode = String(process.env.CURATOR_TOOL_GATE_MODE).trim();
if (process.env.CURATOR_TOOL_GATE_DENY) params.denyTools = String(process.env.CURATOR_TOOL_GATE_DENY).trim();
if (process.env.CURATOR_TOOL_GATE_ALLOW) params.allowTools = String(process.env.CURATOR_TOOL_GATE_ALLOW).trim();
if (process.env.CURATOR_TOOL_GATE_REJECT_MSG) params.rejectMessage = String(process.env.CURATOR_TOOL_GATE_REJECT_MSG).trim();

function _parse(list) {
    if (!list || typeof list !== 'string') return [];
    return list.split(',').map((s) => s.trim()).filter(Boolean);
}

function handler(ctx, io) {
    const toolName = (ctx && ctx.toolName) || '';
    // 关 / 无工具名 / 非拦截模式 → 原样返回
    if (params.mode !== 'deny' && params.mode !== 'allow') {
        return { rawOutput: (ctx && ctx.rawOutput) || '', toolName, netTokenDelta: null, reason: 'off' };
    }
    if (!toolName) {
        return { rawOutput: (ctx && ctx.rawOutput) || '', toolName, netTokenDelta: null, reason: 'no-tool-name' };
    }

    const deny = _parse(params.denyTools);
    const allow = _parse(params.allowTools);

    let blocked = false;
    if (params.mode === 'deny') {
        blocked = deny.includes(toolName);
    } else if (params.mode === 'allow') {
        blocked = !allow.includes(toolName);
    }

    if (!blocked) {
        return { rawOutput: (ctx && ctx.rawOutput) || '', toolName, netTokenDelta: null, reason: 'allowed' };
    }

    // 拦截：替换为拒绝标记，不回写原输出（下游拿到明确拒绝，而非静默数据）
    return {
        rawOutput: params.rejectMessage,
        toolName,
        blocked: true,
        netTokenDelta: null, // 拦截不改 token 计数口径（C4：无节省则报 null）
        reason: `blocked:${params.mode}`,
    };
}

module.exports = { handler, params };
