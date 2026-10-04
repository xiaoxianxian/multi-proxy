'use strict';

// packs/sandbox-egress/index.js · 出站脱敏 + 入站工具调用检查（2026-10-04 建 pack）
//
// 定位（对齐 75 号外部对照文档 §五）：这是**控制面/数据面的旁路检查**，不是执行面沙箱。
// 我们不抢「沙箱」的活（不造内核级强制、不做 macOS 强制机制 —— Landlock/seccomp 属 Linux 特性，
// 且至今未核到）。pack 只做两件事：出站脱敏、入站危险工具调用拦截。
//
// 两种模式（PROXY_SANDBOX_EGRESS_MODE）：
//   observe（默认，显式写 observe 也走这）→ 只记账，响应原样转发。
//   enforce（PROXY_SANDBOX_EGRESS_MODE=enforce）→ 命中高危 tool_use 时**真切断**：
//      把命中的 tool_use / tool_calls 换成一条说明文本（危险入参没了 ⇒ 工具拿不到可执行的参数），
//      但**不删整条响应**——删整条会让 agent 当场断腿（一次合法 tool_use 被吞，往返就断了）。
//      换文本的好处：agent 看得见「这条被拦了」，会自我修正，而不是收到空响应乱猜。
//
// enforce 的能力边界（诚实）：只在**流量真的过我们这一跳**时生效。客户端绕过 multi-proxy
// 直接打上游 ⇒ 我们看不见，拦不住。这不是 bug，是代理层的物理限制。
//
// 门控：PROXY_PACK_SANDBOX_EGRESS=1/true/on → 开（默认 observe）；默认整体关，热路径零开销。
// 门控关时两个入口都直接早退（< 1μs 布尔判断），**不 copy body、不 rewrite**。
// enforce 只在命中高危模式时才深拷贝响应体，未命中一律返回原引用。

const redact = require('../../multi-proxy-manager/lib/redact');

// 危险工具调用模式（抄 ThinkWatch-Lite 的 tool-call inspection 清单，MIT；75 号文档 §三）
// 只做**文本级**匹配：我们拿到的不是 shell 执行结果，是响应体里的 tool_use 参数 JSON。
const TOOL_RULES = [
  { id: 'download-and-exec', re: /\b(?:curl|wget)\b[^\n]{0,200}\|\s*(?:ba)?sh\b/i },
  { id: 'exfiltrate-env',     re: /\b(?:printenv|env)\b[^\n]{0,120}(?:>[^\n]{0,60}\/|curl|POST)/i },
  { id: 'credential-file-out',re: /["''][^\"']{0,80}(?:id_rsa|id_ed25519|\.npmrc|\.env|\.git-credentials|\.aws\/credentials)["'']/i },
  { id: 'install-startup',    re: /\b(?:launchctl\s+(?:load|enable|submit)|systemd-?enable|crontab\s+-|schtasks\s+\/|\/Library\/LaunchAgents)/i },
];

function enabled() {
  const v = String(process.env.PROXY_PACK_SANDBOX_EGRESS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** enforce 模式（PROXY_SANDBOX_EGRESS_MODE=enforce|block）。默认 observe —— 改成真切断必须显式。 */
function mode() {
  const v = String(process.env.PROXY_SANDBOX_EGRESS_MODE ?? '').trim().toLowerCase();
  return v === 'enforce' || v === 'block' ? 'enforce' : 'observe';
}

/** 出站：请求体离开本机前脱敏（内部复用 lib/redact，落点唯一）。 */
function inspectOutbound(body) {
  if (!enabled()) return { body, changed: false, hits: [] };
  const r = redact.redactOutbound(body);
  if (r.changed) {
    console.log('[sandbox-egress] outbound redaction', proxyTag(), JSON.stringify(r.hits));
  }
  return r;
}

/** 入站：上游响应体（可能带 tool_use）→ 记账；mode=enforce 时把高危 tool_use 换成说明文本。 */
function inspectInbound(data) {
  if (!enabled()) return { findings: [], action: 'none', data };
  const text = safeStringify(data);
  const findings = scan(text);
  if (!findings.length) return { findings, action: 'observe', data };

  const m = mode();
  console.log('[sandbox-egress] inbound tool-call inspection', m, proxyTag(), JSON.stringify(findings));
  if (m !== 'enforce') return { findings, action: 'observe', data };
  return { findings, action: 'blocked', data: blockToolCalls(data) };
}

function scan(text) {
  const found = [];
  for (const rule of TOOL_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    if (re.test(text)) found.push({ id: rule.id });
  }
  return found;
}

/** 某个 tool_use 参数串是否命中（enforce 落刀时逐个判定，不用整包结论一刀切）。 */
function hitIds(input) {
  return scan(typeof input === 'string' ? input : safeStringify(input));
}

const BLOCK_NOTE = (ids) => ({
  type: 'text',
  text: `[sandbox-egress] 已拦截 ${ids.join(', ')}：该工具调用的入参命中高危模式（下载即执行 / 外发凭据文件 / 读取私钥 / 安装启动项），已替换为无害内容，工具未执行。`,
});

/**
 * enforce 落刀：深拷贝一份响应体，把命中的 tool_use / tool_calls 换成说明文本。
 * 🔴 只深拷贝**命中时**的那一份，未命中由调用方拿原引用 ⇒ 热路径常态零开销。
 * 两种响应形态都覆盖：Anthropic 的 data.content[]（assistant message）
 * 与 OpenAI 兼容的 data.choices[].message.{content|tool_calls}。
 */
function blockToolCalls(data) {
  const out = deepCopy(data);

  // 🔴 说明文本只写「真被拦下的」规则 id，不写整包 findings：
  // findings 是**整包**扫描出来的（响应正文里提一句 "curl ... | sh" 也算命中），
  // 拿它当说明会写出「已拦截 A」但实际拦的是 B —— 排障时最坑的就是这种假线索。
  const noteIds = [];
  const mark = (ids) => { for (const id of ids) if (!noteIds.includes(id)) noteIds.push(id); };

  if (Array.isArray(out.content)) {
    const kept = out.content.filter((b) => {
      const ids = hitIdsOf(b);
      if (!ids.length) return true;
      mark(ids);
      return false;
    });
    out.content = kept.length ? kept.concat([BLOCK_NOTE(noteIds)]) : [BLOCK_NOTE(noteIds)];
  }

  if (Array.isArray(out.choices)) {
    for (const c of out.choices) {
      const m = c && c.message;
      if (!m) continue;
      if (Array.isArray(m.content)) {
        m.content = m.content.filter((b) => {
          const ids = hitIdsOf(b);
          if (!ids.length) return true;
          mark(ids);
          return false;
        });
        m.content.push(BLOCK_NOTE(noteIds));
      } else if (Array.isArray(m.tool_calls)) {
        m.tool_calls = m.tool_calls.filter((tc) => {
          const arg = tc && tc.function ? tc.function.arguments : tc;
          const ids = hitIds(arg).map((f) => f.id);
          if (ids.length) mark(ids);
          return ids.length === 0;
        });
        // 🔴 tool_calls 被删光 ⇒ 必须补说明，且 content 可能是 null/''：
        // 只写 `content != null` 的判断会让 agent 收到一个空 message，
        // 既看不出被拦了、也不知道为什么工具没跑（2026-10-04 真 HTTP 回环抓到的）。
        // content 非空数组 ⇒ 追加 text block（Anthropic 形态）；其余 ⇒ 落字符串，
        // **不塞对象**：OpenAI 侧 message.content 只收 string|null，塞对象会被 SDK 拒。
        if (!m.tool_calls.length) {
          if (Array.isArray(m.content)) {
            m.content = m.content.concat([BLOCK_NOTE(noteIds)]);
          } else if (typeof m.content === 'string' && m.content) {
            m.content = m.content + ' ' + BLOCK_NOTE(noteIds).text;
          } else {
            m.content = BLOCK_NOTE(noteIds).text;
          }
        }
      }
    }
  }
  return out;
}

/** Anthropic content block（type=tool_use）实际命中的规则 id 列表。 */
function hitIdsOf(block) {
  if (!block || block.type !== 'tool_use') return [];
  return hitIds(block.input).map((f) => f.id);   // 非字符串由 hitIds 内部 stringify
}

function deepCopy(v) {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepCopy(v[k]);
    return o;
  }
  return v;
}

function safeStringify(v) {
  try { return JSON.stringify(v) || ''; } catch { return ''; }
}

let _tag = '';
function proxyTag() { return _tag; }
function setProxy(name) { _tag = name || ''; }

module.exports = { enabled, mode, inspectOutbound, inspectInbound, setProxy, TOOL_RULES };
