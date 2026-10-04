'use strict';

// lib/redact.js · 出站流量脱敏（2026-10-04 补，外部对照 75 号）
//
// 🔴 先说清它不是什么——这是最容易混的一条：
//   l2/route-engine.js 的 log_redaction 脱的是**我们自己写的日志**（taskPrompt 前 50 字），
//   l2/mcp-server.js 的 [redacted] 脱的是**自家 MCP 只读视图**。那两处只保证「我们不往外漏」，
//   管不到「我们发给上游/中继的那份流量」。本文件脱的是后者：请求体离开本机之前，
//   把敏感值换成占位符，让中继手里根本没有真值。
//
// 落点：代理转发出口（发给上游/中继前的那一份 body），不是日志、不是 MCP 视图。
// 门控：PROXY_REDACT=1/true/on 才生效；关时热路径只做一次布尔判断（< 1μs），零副作用。
//
// 规则清单抄自 ThinkWatch-Lite（MIT / ThinkWatchProject/ThinkWatch-Lite，2026-10-04 核证）
// 的四类 + 三项中国场景（身份证号 / 银行卡号 / 连接串密码），见 75 号文档 §三。
// 抄的是**度量衡（清单）**，不抄它的形态（Tauri 桌面 app + 13 客户端接管）。

const UNKNOWN_RULE = null;

// 每条规则：id / 说明 / 正则（全局）/ 占位符
// 🔴 正则里带 /g 的对象是**共享可变状态**（lastIndex 会被 replace 改），
// 所以统一走 buildRule() 每次现造，别把它们当常量直接复用。
const RULES = [
  { id: 'private-key', ph: '<PRIVATE_KEY>',
    src: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/ },
  { id: 'jwt', ph: '<JWT>',
    src: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/ },
  { id: 'api-key', ph: '<API_KEY>',
    src: /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,})\b/ },
  { id: 'conn-password', ph: '<CONN_PASSWORD>',
    src: /(?<=\/\/)[^\/\s:@]{1,64}:[^\/\s:@]{1,64}@/ },
  { id: 'id-card', ph: '<ID_CARD>',
    src: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/ },
  { id: 'bank-card', ph: '<BANK_CARD>',
    src: /\b\d{16,19}\b/ },
];

function buildRule(r) { return { id: r.id, ph: r.ph, re: new RegExp(r.src.source, 'g') }; }

function enabled() {
  const v = String(process.env.PROXY_REDACT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * 单字符串脱敏（纯函数，无副作用、不落盘、不计数）。
 * @returns {{text: string, hits: Array<{id: string, count: number}>}}
 */
function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return { text, hits: [] };
  let out = text;
  const hits = [];
  for (const r of RULES) {
    const rule = buildRule(r);
    const found = out.match(rule.re);
    if (!found || found.length === 0) continue;
    out = out.replace(rule.re, r.ph);
    hits.push({ id: r.id, count: found.length });
  }
  return { text: out, hits };
}

// 递归脱敏 JSON 值：**只改字符串，不动 key、不动结构**（原样递归比 stringify 再 parse 安全，
// 后者会改 key 顺序、转义 unicode，对真请求体是行为变更）。
function walk(v, hits) {
  if (typeof v === 'string') {
    const r = redactText(v);
    if (r.hits.length) { for (const h of r.hits) increment(hits, h.id, h.count); return r.text; }
    return v;
  }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i], hits); return v; }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = walk(v[k], hits);
    return v;
  }
  return v;
}

function increment(bag, id, n) {
  const e = bag.find((x) => x.id === id);
  if (e) e.count += n; else bag.push({ id, count: n });
}

/**
 * 出站 body 脱敏（唯一应该被热路径调用的入口）。
 * 门控关 ⇒ 原样返回（**零副作用**，不是返回空值）。
 * @returns {{body: *, hits: Array<{id:string,count:number}>, changed: boolean}}
 */
function redactOutbound(body) {
  const hits = [];
  if (!enabled()) return { body, hits, changed: false };
  if (body === null || body === undefined) return { body, hits, changed: false };
  const clone = Array.isArray(body) ? body.slice() : (typeof body === 'object' ? { ...body } : body);
  const out = walk(clone, hits);
  return { body: out, hits, changed: hits.length > 0 };
}

module.exports = { enabled, redactText, redactOutbound, RULES, UNKNOWN_RULE };
