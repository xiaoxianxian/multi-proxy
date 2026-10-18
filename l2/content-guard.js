// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// l2 · content-guard：记忆污染（OWASP ASI 2026 ASI06）与 目标劫持（ASI01）的专门防御。
//
// 来源：external-text-audit 评估《AI Agent 安全的治理 2026》时，对照 OWASP ASI 2026
//       发现 multi-proxy 在「记忆污染」「目标劫持」两项的专门防御是空白
//       （权限/白名单/审计/沙箱/熔断 四道半已落地，见 README §8）。本模块补这两块。
//
// 立场：只借 ASI 的「风险分类」做对照，不抄它的实现；纯启发式扫描，可解释、零外部依赖、
//       零行为变更（默认关）。与 side-effect-guard / sentinel-guard 同构：默认 off，
//       enabled 才介入热路径。
//
// 两个落点：
//   - scanMemoryWrite(content)        —— 数据与指令分离：扫描「被当成数据读入、却藏着指令」的内容
//                                        （记忆污染 ASI06 的写入前检查 + 提示词注入的指令识别）。
//   - scanAction({content,objective}) —— 目标劫持 ASI01：扫描动作携带的内容是否劫持/重定向会话原始目标。
//
// 非侵入：构造时把 contentGuard 实例传给 SideEffectGuard，beforeAction 多一道闸门；不传 = 零变更。
//   双层保险：contentGuard 自身 enabled=false 时 scan* 一律放行（与仓库其它守卫同款「门控关=no-op」）。

const GATE_ENV = 'MULTI_PROXY_CONTENT_GUARD';

// 嵌入指令的启发式信号（中英文，覆盖「数据里藏指令」）。每条带 severity，命中即视为
// 「这段内容不该被当成纯数据信任」——即文章第七节的「数据与指令分离」检查。
const DIRECTIVE_SIGNALS = [
  // 推翻前文指令
  { re: /忽略(之前|先前|以上|你之前收到)的(所有|全部|任何)?(指令|指示|规则|提示)/i, severity: 'high', note: '试图推翻已有指令' },
  { re: /ignore(\s+(all|previous|prior|any))?\s*(instructions|prompts?|rules?|system\s*message)/i, severity: 'high', note: '试图推翻已有指令(en)' },
  { re: /disregard (your |the )?(previous|prior|above|all)/i, severity: 'high', note: '试图推翻前文(en)' },
  // 塞新指令
  { re: /你(现在|当前的|新的)指令(是|如下|为)[:：]/i, severity: 'high', note: '在内容里塞新指令' },
  { re: /your (new |updated )?instructions? (are|is|follow)[:：]/i, severity: 'high', note: '在内容里塞新指令(en)' },
  { re: /new instructions?[:：]/i, severity: 'high', note: 'new instructions 标记' },
  { re: /system\s*[:：]\s*/i, severity: 'medium', note: '内容里出现 system: 伪指令标记' },
  // 数据外传（记忆污染常伴随把记忆偷走）
  { re: /(把|将|让).{0,12}(数据|通讯录|凭证|密钥|记录).{0,6}(发送|导出|上传|转发|邮件|email|传递到)/i, severity: 'high', note: '诱导把内部数据外传' },
  { re: /(send|export|forward|upload|email|exfiltrate).{0,12}(data|contacts?|credentials?|keys?|records?)/i, severity: 'high', note: '诱导把内部数据外传(en)' },
  // 瞒报
  { re: /(不要|别|切勿).{0,8}(告诉|告知|让).{0,8}(用户|人类|管理员|老板)/i, severity: 'medium', note: '要求对监护人隐瞒' },
  { re: /(don'?t|do not|never)\s+(tell|inform|let).{0,12}(user|human|admin|owner)/i, severity: 'medium', note: '要求对监护人隐瞒(en)' },
  // 冒充高权限身份
  { re: /(冒充|假装是|扮演).{0,10}(管理员|系统|官方|老板|root)/i, severity: 'high', note: '要求冒充高权限身份' },
  { re: /(pretend|act|impersonate).{0,10}(admin|root|system|official|owner)/i, severity: 'high', note: '要求冒充高权限身份(en)' },
];

// 目标劫持信号（ASI01）：试图重定义 agent 的「原始目标」。
const GOAL_REDIRECT_SIGNALS = [
  { re: /(忽略|放弃|停止).{0,10}(原始任务|原目标|最初目标|initial (task|goal|objective))/i, severity: 'high', note: '要求放弃原始目标' },
  { re: /(你|agent).{0,8}(新的|真正的|现在的)目标(是|改为|变成)[:：]/i, severity: 'high', note: '重定义目标' },
  { re: /(your|the agent'?s)\s+(new|real|actual)\s+(goal|objective|task)\s*(is|becomes|changes? to)[:：]/i, severity: 'high', note: '重定义目标(en)' },
  { re: /重新定义(你|agent)的任务/i, severity: 'high', note: '重定义任务' },
  { re: /redefine (your|the agent'?s) (task|goal|objective)/i, severity: 'high', note: '重定义任务(en)' },
];

function scanSignals(text, signals) {
  if (typeof text !== 'string' || text.length === 0) return { found: false, signals: [], score: 0 };
  const hits = [];
  let score = 0;
  for (const s of signals) {
    if (s.re.test(text)) {
      hits.push({ note: s.note, severity: s.severity });
      score += s.severity === 'high' ? 2 : 1;
    }
  }
  return { found: hits.length > 0, signals: hits, score };
}

// 把任意 content 归一成可扫文本：字符串直接扫；带 .text 字段的对象取 text；其余 JSON 化。
function toText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return '';
}

function gateOpen() {
  const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function createContentGuard(opts = {}) {
  const enabled = typeof opts.enabled === 'boolean' ? opts.enabled : gateOpen();

  const PASS = { proceed: true, reason: 'content-guard-off', poisoned: false, goalHijacked: false, signals: [], score: 0 };

  // 记忆写入前检查（ASI06）：内容若是「被当成数据读入、却藏着指令」，标记污染。
  function scanMemoryWrite(content) {
    if (!enabled) return { ...PASS, reason: 'content-guard-off' };
    const r = scanSignals(toText(content), DIRECTIVE_SIGNALS);
    return {
      proceed: !r.found,
      reason: r.found ? 'memory-poisoning-detected' : 'ok',
      poisoned: r.found,
      signals: r.signals,
      score: r.score,
    };
  }

  // 动作执行前检查（ASI01 + 注入）：动作携带的内容若劫持目标或塞指令 → 拦。
  function scanAction({ content = '', objective = null } = {}) {
    if (!enabled) return { ...PASS, reason: 'content-guard-off' };
    const text = toText(content);
    const dir = scanSignals(text, DIRECTIVE_SIGNALS);
    const goal = scanSignals(text, GOAL_REDIRECT_SIGNALS);

    // 目标劫持：若给了原始目标，且内容只是复述/引用原目标（含原目标串），不算劫持。
    let goalHijacked = goal.found;
    if (goalHijacked && objective && typeof objective === 'string' && objective.trim()) {
      if (text.includes(objective.trim())) goalHijacked = false;
    }

    const blocked = dir.found || goalHijacked;
    return {
      proceed: !blocked,
      reason: blocked ? (goalHijacked ? 'goal-hijack-detected' : 'injected-directive-detected') : 'ok',
      poisoned: dir.found,
      goalHijacked,
      signals: [...dir.signals, ...goal.signals],
      score: dir.score + goal.score,
    };
  }

  return { enabled, scanMemoryWrite, scanAction, _config: { enabled } };
}

module.exports = {
  GATE_ENV,
  DIRECTIVE_SIGNALS,
  GOAL_REDIRECT_SIGNALS,
  scanSignals,
  toText,
  createContentGuard,
  gateOpen,
};
