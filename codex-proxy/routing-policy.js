// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// ==================== model-id 级路由策略（codex-proxy/routing-policy.js，P6）====================
// 目的：把「这个网关代理哪些模型」从**provider 级**细化到 **model-id 级**。
// 落地它就回答了 Q3：「只代理这 3 个模型、其余直连」能不能成立——能，写三行规则即可。
//
// 三种动作：
//   proxy  —— 走本网关现有路由（findProvider + 熔断 + 成本落账），即今天的行为
//   direct —— 不经过网关路由：直接转发到该 agent 的 takeover 真 upstream
//             （P1 存的 ~/.multi-proxy-manager/takeover-<agent>.json）。
//             用途：流量是 agent 与它自己上游之间的事，不走我们的账、不喂我们的熔断。
//   deny   —— 明确拒绝（400 + MODEL_NOT_PERMITTED）。宁可响亮地失败，不静默乱转。
//
// 规则形状（~/.multi-proxy-manager/routing-policy.json）：
//   {
//     "default": "direct",                      // 无规则命中时的动作；缺省 "proxy"（= 今天的行为）
//     "rules": [                                // 有序，**第一条命中即停**
//       { "match": "deepseek-v4-flash", "action": "proxy" },
//       { "match": "agnes-*",            "action": "proxy" },
//       { "match": "*",                  "action": "direct" }
//     ]
//   }
//   白名单写法 = default 非 proxy + 只给要代理的模型写 proxy 规则；
//   黑名单写法 = default:"proxy" + 给要拦的模型写 deny 规则。**一套机制两个方向。**
//
// 纪律（与全站同源）：
//   · **门控默认关**：PROXY_ROUTING_POLICY 不设 ⇒ routingPolicy = null ⇒ 三条转发路径
//     逐字不变（resolveRoute 对 null policy 恒返回 proxy）。零行为变更才敢默认关。
//   · **畸形 fail-safe 到「无策略」**：JSON 解析失败 / 形状不对 ⇒ 当作没有策略
//     （unrestricted）+ 启动期大声报错。与 P3「malformed 计价按标准价」同一条纪律：
//     配错的时候退回**已知安全的老行为**，不是退回一个更危险的新行为。
//   · **匹配大小写不敏感**：白名单是权限机制，用户写 DeepSeek-V4-Flash、agent 发
//     deepseek-v4-flash，规则静默不匹配 ⇒ 模型被意外 deny/direct，比「多代理一个」
//     危险得多。宁可往 proxy 方向偏（那正是今天的行为）。
//   · **direct 解析不出就 502，绝不猜**：没有 takeover 记录 / 记录缺 upstream /
//     apiKeyEnv 指向的 env 在代理进程里没设 ⇒ 明写缺什么。静默回落 proxy 会让
//     「我想绕开网关」的意图悄悄失效（钱照记、流量照过），比报错更糟。
//   · **纯函数/IO 分离**：match/parse/resolve 是纯函数；读文件与 env 由调用方注入，
//     测试不碰磁盘不碰网络。

const ACTIONS = ['proxy', 'direct', 'deny'];

// 模式匹配：精确 id / `*` 后缀 glob / 裸 `*`（全部）。大小写不敏感。
// 只支持 `*` 一种通配符（够用：deepseek-*、*-flash、*）；不上 `?`/字符类，
// 规则文件是手写的，通配符越少越不会写错。
function matchModelPattern(modelId, pattern) {
  if (typeof modelId !== 'string' || typeof pattern !== 'string') return false;
  const id = modelId.trim().toLowerCase();
  const pat = pattern.trim().toLowerCase();
  if (!id || !pat) return false;
  if (pat === '*') return true;
  if (!pat.includes('*')) return id === pat;
  // glob → 正则：先把正则元字符转义，再把 * 换成 .*
  const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(id);
}

// 原始 JSON → {ok:true, policy} | {ok:false, error}
// 校验失败的**唯一**后果是调用方当作无策略（fail-safe），所以错误信息要写清楚
// 「哪儿不对、于是策略没生效」，让人一眼能从日志看出来。
function parseRoutingPolicy(raw) {
  if (raw === null || raw === undefined) return { ok: true, policy: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'routing-policy 必须是对象' };
  }

  const def = raw.default === undefined ? 'proxy' : raw.default;
  if (!ACTIONS.includes(def)) {
    return { ok: false, error: `default 必须是 ${ACTIONS.join('/')} 之一，收到: ${JSON.stringify(raw.default)}` };
  }

  if (raw.rules !== undefined && !Array.isArray(raw.rules)) {
    return { ok: false, error: 'rules 必须是数组' };
  }

  const rules = [];
  const list = raw.rules || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, error: `rules[${i}] 必须是对象` };
    }
    if (typeof r.match !== 'string' || !r.match.trim()) {
      return { ok: false, error: `rules[${i}].match 必须是非空字符串` };
    }
    const action = r.action === undefined ? 'proxy' : r.action;
    if (!ACTIONS.includes(action)) {
      return { ok: false, error: `rules[${i}].action 必须是 ${ACTIONS.join('/')} 之一，收到: ${JSON.stringify(r.action)}` };
    }
    rules.push({ match: r.match.trim(), action });
  }

  return { ok: true, policy: { default: def, rules } };
}

// modelId + policy → 路由决定。**第一条命中的规则即停**（顺序即优先级）。
// 返回的 reason 供日志/错误文案用，让人知道「为什么这个模型被这么处理」。
function resolveRoute(modelId, policy) {
  // 空 model id → deny。防御性分支：真实链路上 findProvider 会先 400 掉空模型，
  // 但 resolveRoute 作为独立判定的入口，不能把「空模型」误当成「无策略」放过去。
  if (typeof modelId !== 'string' || !modelId.trim()) {
    return { action: 'deny', matched: false, pattern: null, reason: 'empty-model-id' };
  }
  // 无策略（门控关 / 文件缺失 / 畸形 fail-safe）→ 恒 proxy：今天的行为，逐字不变。
  if (!policy) {
    return { action: 'proxy', matched: false, pattern: null, reason: 'no-policy' };
  }
  const id = modelId.trim();
  for (const rule of policy.rules) {
    if (matchModelPattern(id, rule.match)) {
      return { action: rule.action, matched: true, pattern: rule.match, reason: `rule:${rule.match}` };
    }
  }
  return { action: policy.default, matched: false, pattern: null, reason: 'default' };
}

// direct 动作的目标解析。**纯函数**：takeover 记录表与 env 都由参数注入，
// proxy.js 只负责把「读文件拿到的东西」和 process.env 传进来。
//
// records: { [agent]: {upstream, apiKeyEnv?, ...} }（来自 ~/.multi-proxy-manager/takeover-*.json）
// env:     { [envName]: value }（来自 process.env）
//
// 返回 {ok:true, upstream, apiKey|null, apiKeyEnv|null} 或 {ok:false, reason, detail?}。
// ok:false 的每一种都对应一句可操作的报错（缺记录/缺 upstream/env 没设），不猜、不回落。
function resolveDirectTarget(agent, { records = {}, env = {} } = {}) {
  const rec = records && typeof records === 'object' ? records[agent] : null;
  if (!rec) {
    return { ok: false, reason: 'no-takeover-record', detail: `agent "${agent}" 没有 takeover 记录` };
  }
  if (typeof rec.upstream !== 'string' || !rec.upstream.trim()) {
    return { ok: false, reason: 'takeover-missing-upstream', detail: `takeover-${agent}.json 缺 upstream 字段` };
  }
  const upstream = rec.upstream.trim().replace(/\/+$/, '');

  // apiKeyEnv 缺省 = 该上游不需要鉴权（典型：本地 Ollama）。此时 ok，apiKey=null，
  // 调用方不Authorization 头——不是「猜一个空 key 发出去」。
  if (!rec.apiKeyEnv) {
    return { ok: true, upstream, apiKey: null, apiKeyEnv: null };
  }
  const key = env ? env[rec.apiKeyEnv] : undefined;
  if (typeof key !== 'string' || !key) {
    return {
      ok: false,
      reason: 'api-key-env-not-set',
      detail: `takeover-${agent}.json 要求 env ${rec.apiKeyEnv}，但代理进程里没有它`,
      apiKeyEnv: rec.apiKeyEnv,
    };
  }
  return { ok: true, upstream, apiKey: key, apiKeyEnv: rec.apiKeyEnv };
}

// 代理收到的路径 → 直连 URL。upstream 已含 /v1（takeover 记录里的形态），
// reqPath 也以 /v1 开头 ⇒ 去掉 reqPath 的 /v1 前缀再拼，避免 /v1/v1。
// 纯函数：不碰 req 对象，只吃两个字符串。
function buildDirectUpstreamUrl(upstream, reqPath) {
  const base = String(upstream || '').replace(/\/+$/, '');
  let suffix = String(reqPath || '');
  suffix = suffix.replace(/^\/v1/, '');
  if (!suffix.startsWith('/')) suffix = '/' + suffix;
  return base + suffix;
}

module.exports = {
  ACTIONS,
  matchModelPattern,
  parseRoutingPolicy,
  resolveRoute,
  resolveDirectTarget,
  buildDirectUpstreamUrl,
};
