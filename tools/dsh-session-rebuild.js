// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// 从**真 dsh 会话**（~/.dsh/sessions/*/*/session.jsonl.zstd）重建一条真实请求体，
// 供 dsh-saving-ab.sh 做 A/B —— 之前那份假样本（system+user+user，没有 assistant 工具轮）
// 根本触发不了 lazyload（activeToolNames 扫不到 tool_calls ⇒ 必然 no-usage-evidence）。
//
// 用法：
//   node tools/dsh-session-rebuild.js <输出payload.json> [模型=deepseek-v4-flash] [--session <可选指定会话文件>]
//
// 🔴 三条口径（踩过，别改）：
//   1. dsh 内部是 **content 数组协议**（assistant.content = [{type:'reasoning'|'text'|'tool-call'}]），
//      DeepSeek/OpenAI chat 只认**顶层 tool_calls**。重建必须做协议翻译，不能原样丢过去。
//   2. assistant 轮要带 `reasoning_content`（DeepSeek thinking 模型的硬要求，
//      实测 400 文案：`The reasoning_content in the thinking mode must be passed back to the API.`）。
//      真 dsh 会话本来就带（12/12），这里保留原值、缺就补空串。
//   3. tool 轮的 tool_call_id 必须能和 assistant 的 tool_calls.id 对上，
//      否则上游 400（tool_call_id not found）。按 callId 重建，别自己造。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = process.argv[2];
const MODEL = process.argv[3] && process.argv[3] !== '--session' ? process.argv[3] : 'deepseek-v4-flash';
const argSession = process.argv.indexOf('--session');
const WANT = argSession > -1 ? process.argv[argSession + 1] : null;

const HOME = process.env.HOME || '/Users/xiaota';
const ZSTD = '/opt/homebrew/bin/zstd';

// ---- 0. 找会话（默认取最大的那个，样本最多）----
function findSessions() {
  const base = path.join(HOME, '.dsh/sessions');
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.jsonl.zstd') out.push(p);
    }
  };
  walk(base);
  return out;
}
let files = findSessions();
if (WANT) files = files.filter((f) => f.includes(WANT));
if (!files.length) { console.error('❌ 没找到 dsh 会话文件'); process.exit(1); }
files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
const SESSION = files[0];

// ---- 1. 解 zstd（只读，绝不写回 ~/.dsh）----
const tmp = path.join('/tmp', 'dsh-session-rebuild-' + Date.now() + '.jsonl');
console.error('会话 = ' + SESSION + '（' + Math.round(fs.statSync(SESSION).size / 1024) + ' KB）');
// 🔴 必须给 maxBuffer：会话解出来动辄几 MB，默认 1MB 会直接抛
//   "maxBuffer exceeded"，看着像 zstd 炸了其实是 Node 的 buffer 上限。
fs.writeFileSync(tmp, execFileSync(ZSTD, ['-dc', SESSION], { maxBuffer: 1 << 30, encoding: 'buffer' }));
const events = fs.readFileSync(tmp, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch (e) { return null; }
}).filter(Boolean);

// ---- 2. 抽 system / tools ----
const header = events.find((o) => o.type === 'request/header');
const H = (header && header.data && header.data.header) || {};
console.error('dsh 原生 provider/model = ' + JSON.stringify(H.config || {}));
console.error('system = ' + String(H.system || '').length + ' 字符, tools = ' + ((H.tools || []).length) + ' 个');

// ---- 3. 按 seq 重建 messages ----
const msgs = [];
const toolById = new Map();        // callId -> tool result text
let lastAssistant = null;

// 工具结果文本：嵌在 message.content[] → [].content[] → [{type:'text',text}] 里，
// 得递归抠（直接 stringify 会把协议外壳一起算进 token，跟真实请求不是一个量级）。
function toolResultText(m) {
  const out = [];
  const walk = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      if (!c || typeof c !== 'object') { if (typeof c === 'string') out.push(c); continue; }
      if (typeof c.text === 'string') out.push(c.text);
      if (Array.isArray(c.content)) walk(c.content);
      if (typeof c.content === 'string') out.push(c.content);
    }
  };
  walk(m && m.content);
  return out.join('\n');
}

// 先扫一遍 tool/result 建立 id → 结果
// 🔴 `message.id` 是**会话级 UUID**（5961150f-…），跟 tool_call_id 没关系。真正的
//    tool_call_id 在 `message.source.callId` 或 `content[].toolCallId` 上，两者一致且与
//    assistant 的 tool_calls.id 同源 —— 拿错字段整条链会全部错配（实测踩到）。
for (const o of events) {
  if (o.type !== 'tool/result') continue;
  const d = o.data || {};
  const m = d.message || {};
  const id = (m.source && m.source.callId)
    || (Array.isArray(m.content) ? (m.content.find((c) => c && c.toolCallId) || {}).toolCallId : null)
    || d.callId;
  if (!id) continue;
  if (!toolById.has(id)) toolById.set(id, toolResultText(m) || JSON.stringify(m.content || m));
}

const flushAssistant = () => {
  if (!lastAssistant) return;
  const { textParts, toolCalls } = lastAssistant;
  const msg = { role: 'assistant' };
  const txt = textParts.filter(Boolean).join('\n');
  if (txt) msg.content = txt;
  if (toolCalls.length) {
    msg.tool_calls = toolCalls.map((tc) => ({
      id: tc.id, type: 'function',
      function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) }
    }));
  }
  if (!msg.content && !msg.tool_calls.length) msg.content = '';
  // 🔴 DeepSeek thinking 模型：回传 assistant 必须带 reasoning_content，否则 400。
  if (msg.reasoning_content === undefined) msg.reasoning_content = '';
  msgs.push(msg);
};

for (const o of events.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
  const d = o.data || {};
  if (o.type === 'user/message') {
    flushAssistant(); lastAssistant = null;
    const c = d.message || {};
    msgs.push({ role: 'user', content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content || c) });
  } else if (o.type === 'assistant/message') {
    flushAssistant();
    const m = d.message || {};
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    lastAssistant = { textParts: [], toolCalls: [] };
    for (const seg of content) {
      if (seg.type === 'reasoning') { lastAssistant.textParts.push(String(seg.text || '')); lastAssistant.reasoning = String(seg.text || ''); }
      else if (seg.type === 'text') lastAssistant.textParts.push(String(seg.text || ''));
      else if (seg.type === 'tool-call') lastAssistant.toolCalls.push({ id: seg.id, name: seg.name, arguments: seg.arguments });
      else if (seg.type === 'tool_call') lastAssistant.toolCalls.push({ id: seg.id || seg.call_id, name: seg.name, arguments: seg.arguments || seg.input });
    }
    const rm = lastAssistant;
    lastAssistant = { textParts: rm.textParts, toolCalls: rm.toolCalls, reasoning: rm.reasoning };
    // 立刻推出（下一轮 flush 会带上）
    msgs.push({ role: 'assistant', content: rm.textParts.filter(Boolean).join('\n') || '',
                reasoning_content: rm.reasoning || '',
                tool_calls: rm.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) });
    lastAssistant = null;
  } else if (o.type === 'tool/result') {
    flushAssistant(); lastAssistant = null;
    const m = d.message || {};
    const id = (m.source && m.source.callId)
      || (Array.isArray(m.content) ? (m.content.find((c) => c && c.toolCallId) || {}).toolCallId : null)
      || d.callId;
    if (!id) continue; // 认不出 id 的 tool 结果直接丢，留着就是孤儿轮 → 上游 400
    msgs.push({ role: 'tool', tool_call_id: id, name: (m.name || d.name || 'tool'),
                content: toolById.get(id) || toolResultText(m) || '(empty)' });
  }
}
flushAssistant(); lastAssistant = null;

// ---- 3.5 截断到真实上下文预算 ----
// 🔴 不能整段丢给上游：真 dsh 有 262144 窗口（request/context 里记的），一个完整会话
//    重建出来能到 50 万字符 ≈ 20 万 token，直连就超窗。真实 agent 也是「保留最近一段」，
//    所以这里**从头部丢、保尾不保头**（丢掉残缺的头部轮次比截断中间安全得多）。
//    丢之前先对齐轮次边界：一旦头部被切在 assistant 和它的 tool 结果中间，
//    上游会直接 400（tool_call_id 找不到），那种「截断失败」比少几条消息严重得多。
const argMaxMsgs = process.argv.indexOf('--max-msgs');
const argMaxChars = process.argv.indexOf('--max-chars');
const MAX_MSGS = argMaxMsgs > -1 ? Number(process.argv[argMaxMsgs + 1]) : 0;
const MAX_CHARS = argMaxChars > -1 ? Number(process.argv[argMaxChars + 1]) : 0;
if (MAX_MSGS || MAX_CHARS) {
  const budget = MAX_CHARS || Infinity;
  const sizeOf = (m) => String(m.content || '').length + (m.reasoning_content ? String(m.reasoning_content).length : 0);
  // 🔴 顺序不能反：先按**条数**截、再按**字符**兜底。真 dsh 会话是「一个超长任务」，
  //    尾部几条天然只有几千字符（前面的 50 万字符全堆在头部轮次），先套字符预算会把
  //    整个会话截成一条孤零零的 assistant —— 既不真实也测不到任何东西（实测踩到）。
  //    真实 agent 也是按窗口/轮数丢历史，不是按字符硬切。
  let cut = 0;
  // 🔴 丢弃必须**成对**：tool 轮上游要求前面有对应的 tool_calls，丢掉 assistant
  //    却留下它的 tool 结果 = 孤儿轮 = 直接 400 `role 'tool' must be a response to ...`。
  //    所以向左也要扩：从 from 往回把依附在它前面的 tool 轮一起带走（只往右扩过一次，
  //    实测把 system 后面的头几轮切成了 system,tool,assistant —— 本身就是非法序列）。
  const pairDrop = (from) => {
    let lo = from, hi = from;
    while (lo > 0 && msgs[lo - 1] && msgs[lo - 1].role === 'tool') lo--;
    while (hi < msgs.length - 1 && msgs[hi + 1] && msgs[hi + 1].role === 'tool') hi++;
    return hi; // cut = hi ⇒ [0..hi] 整段丢掉，lo..hi-1 顺带
  };
  if (MAX_MSGS) {
    const want = Math.max(1, msgs.length - MAX_MSGS);
    if (want > 0) cut = Math.min(pairDrop(want), msgs.length - 1);
  }
  while (msgs.length - cut > 1) {
    if (msgs.slice(cut).reduce((s, m) => s + sizeOf(m), 0) <= budget) break;
    const next = Math.min(cut + 8, msgs.length - 1);
    cut = Math.max(cut + 1, pairDrop(next));
  }
  const dropped = msgs.splice(0, cut);
  console.error('截断：丢头部 ' + dropped.length + ' 条（剩下 ' + msgs.length + ' 条，' +
    Math.round(msgs.reduce((s, m) => s + sizeOf(m), 0) / 1024) + ' KB 文本）');
  console.error('  丢弃末尾工具名 = ' + (dropped.slice(-3).map((m) => m.role).join(',') || '-'));
}

// ---- 3.6 配对扫描：把孤儿 tool 轮剔掉 ----
// 🔴 上游硬规则：`role:'tool'` 必须回应前面某条 assistant 的 tool_calls
//    （400 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）。
//    dsh 会话里并非每个 tool 结果都紧跟一条 tool_calls（subagent/delegation 的结果也会落成
//    tool 轮），加上截断会**制造**新的孤儿 —— 重建完必须扫一遍，宁可少几条也不能送非法序列。
{
  const pending = new Set();
  const clean = [];
  let droppedOrphan = 0, droppedPending = 0;
  for (const m of msgs) {
    // 🔴 dsh 会给「没调工具的 assistant」也附一个 `tool_calls: []`。上游直接 400
    //    `Invalid 'messages[N].tool_calls': empty array`，空数组不是合法输入。
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && !m.tool_calls.length) delete m.tool_calls;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      for (const t of m.tool_calls) pending.add(t.id);
      clean.push(m);
    } else if (m.role === 'tool') {
      if (!pending.has(m.tool_call_id)) { droppedOrphan++; continue; } // 孤儿：丢掉
      pending.delete(m.tool_call_id);
      clean.push(m);
    } else {
      // user / system / 没有 tool_calls 的 assistant：新回合开始，此前未消费的 call 作废
      if (pending.size) droppedPending += pending.size;
      pending.clear();
      clean.push(m);
    }
  }
  msgs.length = 0; msgs.push(...clean);
  if (droppedOrphan || droppedPending)
    console.error('配对扫描：丢孤儿 tool 轮 ' + droppedOrphan + ' 条、作废未消费 tool_call ' + droppedPending + ' 个');
}

// ---- 4. 组装请求体 ----
// 🔴 dsh 内部工具表是**扁乎的**（{name, description, parameters}，见 request/header.tools），
//    OpenAI/DeepSeek 要的是 {type:'function', function:{name, description, parameters}}。
//    原样搬过去上游直接 422：`tools[0]: missing field 'type'`（实测踩到，dsh 自己发请求
//    时是它自己的 provider 层做这层包装的，重建脚本必须补上）。
function toOpenAITool(t) {
  if (!t || typeof t !== 'object') return t;
  if (t.type === 'function') return t;                       // 已经对了
  if (t.function) return { type: 'function', function: t.function };
  return { type: 'function', function: {
    name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} }
  } };
}
const body = {
  model: MODEL,
  stream: false,
  tools: Array.isArray(H.tools) ? H.tools.map(toOpenAITool) : [],
  messages: [{ role: 'system', content: String(H.system || '') }, ...msgs],
};

fs.writeFileSync(OUT, JSON.stringify(body));
const bytes = fs.statSync(OUT).size;
let chars = 0;
for (const m of body.messages) chars += String(m.content || '').length;
console.error('重建完成 → ' + OUT);
console.error('  消息 ' + body.messages.length + ' 条, tools ' + body.tools.length + ' 个, ' + Math.round(bytes / 1024) + ' KB');
console.error('  文本总长 ' + chars + ' 字符');
console.error('  assistant 轮(带 tool_calls) = ' + body.messages.filter((m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length).length +
              ', tool 轮 = ' + body.messages.filter((m) => m.role === 'tool').length +
              ', 有 reasoning_content 的 assistant = ' + body.messages.filter((m) => m.role === 'assistant' && m.reasoning_content).length);
