// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 子 agent 识别三法（外部对照 #71 PilotDeck 落地件 · 2026-10-18）
//
// 来源：PilotDeck `src/router/scenario/subagentDetector.ts`（AGPL-3.0，
// 2026-10-18 经 7897 代理直读 GitHub 核证，母本 docs/10-initiatives/90-PilotDeck外部对照与路由工程设计对照-2026-10-18.md）。
// **抄度量衡不抄形态**：搬它的三条判据（标签注入 / 工具清单反推 / 显式标志），
// 标签前缀换成自家 multi-proxy-（不继承 pilotdeck-/ccr- 前缀），落点按本项目
// 分布式代理架构重挂（见文件末「接线」）。
//
// 为什么要识别子 agent：父/子请求的成本结构完全不同——子 agent 干的是有界
// 探索/规划/验证，用旗舰模型是拿大炮打蚊子。识别出来只是**观测输入**：
// 本模块零决策、零改写，只回答「这条请求是不是子 agent 上下文」，
// 采不采纳、降不降档由路由层/调用方决定（N3 纯决策铁律不破）。
//
// 三法（任一命中即 isSubagent，与 PilotDeck 同构）：
//   ① 标签注入：user 消息体嵌 <multi-proxy-subagent-model>provider/model</...>，
//      提取 modelHint 供路由参考；转发前 stripSubagentTags 剥掉（不泄漏给上游）。
//   ② 工具清单反推：tools 里没有 agent/task/launch_agent/spawn_agent 类派发工具
//      ⇒ 这大概率是子 agent 上下文（父 agent 才有派发工具）。
//   ③ 显式标志：调用方传 isMainAgent=false。
//
// 纪律：
//   - 纯函数、零依赖、零 IO。确定性：同一输入必得同一结果（可单测可回归）。
//   - 永不抛错：messages/tools 形状不对时按「无信号」处理，不把观测搞成故障。
//   - 深拷贝只在命中标签时发生（未命中返回原引用），热路径零分配。

// 标签模式：<multi-proxy-subagent-model>...</multi-proxy-subagent-model>（大小写不敏感，允许前后空白）
const SUBAGENT_TAG_PATTERN =
  /<multi-proxy-subagent-model>\s*([\s\S]+?)\s*<\/multi-proxy-subagent-model>/i;

// 父 agent 才有的派发工具名（PilotDeck 的 AGENT_TOOL_NAME_PATTERN 同款集合）
const AGENT_TOOL_NAME_PATTERN = /^(?:agent|task|launch[_-]?agent|spawn[_-]?agent)$/i;

// 观测门控（与 l2/ 其它模块同款读法）：PROXY_SUBAGENT_DETECT=1/true/on 才观测。
// 默认关 ⇒ 接线点零副作用；本模块自身永远是纯函数（门控只影响调用方要不要调）。
const GATE_ENV = 'PROXY_SUBAGENT_DETECT';

function gateOpen() {
  const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * 探测一条请求是否处于子 agent 上下文。
 *
 * @param {object} input
 * @param {Array<object>} [input.messages] canonical messages（{role, content:[{type,text}]} 或 {role, content:string} 两种形态都收）
 * @param {Array<object>} [input.tools] 请求的 tools 数组（{name} 形状；没有 tools 字段时不反推）
 * @param {boolean} [input.isMainAgent=true] 调用方显式标志；false = 明确是子 agent
 * @returns {{isSubagent: boolean, modelHint: string|null, missingAgentTool: boolean, taggedInUserMessage: boolean, reasons: string[]}}
 */
function detectSubagent(input = {}) {
  const { messages, tools, isMainAgent = true } = input;
  const reasons = [];
  let modelHint = null;
  let taggedInUserMessage = false;

  // ① 标签注入：扫 user 消息的文本块
  const msgList = Array.isArray(messages) ? messages : [];
  for (const message of msgList) {
    if (!message || message.role !== 'user') continue;
    const blocks = extractTextBlocks(message.content);
    for (const text of blocks) {
      const match = SUBAGENT_TAG_PATTERN.exec(text);
      if (match) {
        modelHint = match[1].trim();
        taggedInUserMessage = true;
        reasons.push('tagged');
      }
    }
  }

  // ② 工具清单反推：有 tools 数组但没有派发工具 ⇒ 子上下文
  // ⚠️ 只在 tools 是**非空数组**时反推：请求不带 tools（纯聊天）不是「子 agent」信号，
  // 父 agent 的简单对话也可能不带 tools。空数组/缺省一律不反推（宁可漏判，不可错杀）。
  const toolList = Array.isArray(tools) ? tools : null;
  const missingAgentTool = !!toolList && toolList.length > 0 &&
    !toolList.some((t) => t && typeof t.name === 'string' && AGENT_TOOL_NAME_PATTERN.test(t.name));
  if (missingAgentTool) reasons.push('missing-agent-tool');

  // ③ 显式标志
  if (!isMainAgent) reasons.push('explicit');

  return {
    isSubagent: taggedInUserMessage || missingAgentTool || !isMainAgent,
    modelHint,
    missingAgentTool: !!missingAgentTool,
    taggedInUserMessage,
    reasons,
  };
}

/**
 * 从 messages 里剥掉子 agent 标签（转发上游前调用）。
 * 命中才深拷贝；未命中逐条返回原引用（热路径零分配，与 detectSubagent 同纪律）。
 *
 * @param {Array<object>} messages
 * @returns {Array<object>} 剥过标签的 messages（无标签时与输入同结构）
 */
function stripSubagentTags(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || message.role !== 'user') return message;
    if (typeof message.content === 'string') {
      if (!SUBAGENT_TAG_PATTERN.test(message.content)) return message;
      return { ...message, content: message.content.replace(SUBAGENT_TAG_PATTERN, '').trimEnd() };
    }
    if (!Array.isArray(message.content)) return message;
    let mutated = false;
    const content = message.content.map((block) => {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
      if (!SUBAGENT_TAG_PATTERN.test(block.text)) return block;
      mutated = true;
      return { ...block, text: block.text.replace(SUBAGENT_TAG_PATTERN, '').trimEnd() };
    });
    return mutated ? { ...message, content } : message;
  });
}

// content 两种形态（字符串 / block 数组）统一抽文本块
function extractTextBlocks(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text);
}

module.exports = {
  detectSubagent,
  stripSubagentTags,
  gateOpen,
  GATE_ENV,
  SUBAGENT_TAG_PATTERN,
  AGENT_TOOL_NAME_PATTERN,
};

// ---- 接线（2026-10-18 落地记录）----
// generic-openai-proxy/proxy.js 的 /v1/chat/completions 入口（applyRoutingPolicy 之前）
// 以观测形态挂载：detectSubagent 结果只进 trace/日志（门控 PROXY_SUBAGENT_DETECT 默认关，
// 关时热路径只多一次布尔判断）。其余五个 proxy（claude/codex/cursor/dsh/opencode）
// 本轮不接——先看观测命中率再铺开，符合本项目 shadow 先行纪律。
