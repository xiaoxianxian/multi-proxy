// workbuddy-shim — WorkBuddy (CodeBuddy / copilot.tencent.com) → OpenAI-compatible adapter
// Copyright © 2026 xiaoxian (Jason). Licensed under AGPL-3.0 (source).
//
// 这是什么：一个本机 OpenAI 兼容网关，把 multi-proxy 发来的标准 /v1/chat/completions
// 请求，翻译成 WorkBuddy 私有 chat 协议（copilot.tencent.com/v2/chat/completions）。
// 客户端要流式：WB 返回的 OpenAI 格式 SSE 原样透传；客户端要非流式：shim 内部以 stream
// 打 WB 并聚合 SSE 为单个完整 chat.completion 返回（WB 私线强制 SSE，故 always-stream）。
//
// 为什么单独成进程：WorkBuddy 的线协议（UA / 头链 / 请求体整形 / token 形态）和 OpenAI 不
// 一样，但 dsh-workbuddy-connect 插件已逆向清楚（upstream.ts 注释明写 ported from
// Sliverkiss/workbuddy2api，MIT）。把这块 wire 知识锁在本 shim，multi-proxy 核心仍然只认
// "OpenAI 兼容 localhost 端点"，不沾 WorkBuddy 私线 —— 与项目"接入方不写解析、不改 wire
// 知识"的纪律一致。
//
// 红线（必读，对应 dsh 插件的 ToS 灰区）：
//   ① 仅用你自己 WorkBuddy 账号的 token，且通过 WORKBUDDY_ACCESS_TOKEN 显式注入；
//      本 shim 不读桌面端私有存储、不做每日签到 bot（那是促销刷取，风险高）。
//   ② 默认只绑 127.0.0.1；要暴露到网络前必须设 WORKBUDDY_SHIM_AUTH_TOKEN。
//   ③ WorkBuddy 私有 API 在官方客户端之外调用属 ToS 灰区，上游一改本 shim 可能挂；
//      这是已知风险，不是 bug。

'use strict';

const http = require('http');
const { Readable } = require('stream');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 零依赖 .env 加载器：从脚本同目录的 .env 读 KEY=VALUE（不覆盖已存在的 env）。
// 保持零外部依赖；launchd 也可直接把 env 注入进程，二者不冲突。
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {}
})();

// ===== 已验证的协议常量（来源：corrinehu/dsh-workbuddy-connect src/upstream.ts + src/client-identity.ts）=====
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const FALLBACK_CN_APP_VERSION = '5.5.6';
const FALLBACK_GLOBAL_APP_VERSION = '5.5.6';
const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.';

const CN_CHAT_BASE = 'https://copilot.tencent.com';
const GLOBAL_BASE = 'https://www.workbuddy.ai';
const CN_BILLING_BASE = 'https://www.codebuddy.cn';

// ===== 协议纯函数（与 dsh 插件逐字对齐，便于单测；不触网）=====

// region 判定：空 domain = CN（与上游工具链一致）；workbuddy.ai = global。
function regionOf(domain) {
  const lowered = String(domain || '').trim().toLowerCase();
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global';
  return 'cn';
}

function chatBaseUrl(region) {
  if (process.env.WORKBUDDY_CHAT_BASE) return process.env.WORKBUDDY_CHAT_BASE;
  return region === 'global' ? GLOBAL_BASE : CN_CHAT_BASE;
}
function originReferer(region) {
  if (process.env.WORKBUDDY_CHAT_BASE) return process.env.WORKBUDDY_CHAT_BASE;
  return region === 'global' ? GLOBAL_BASE : CN_BILLING_BASE;
}

// Chat User-Agent（client-identity.ts:122-131）：WorkBuddy/<v> [WorkBuddy AI/<v>] [CLI/<v>]
function chatUserAgent(region, clientVersion) {
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy';
  const parts = [`WorkBuddy/${clientVersion}`, `${product}/${clientVersion}`];
  return parts.join(' ');
}

// 每个上游请求共享的头（upstream.ts:426-434）
function commonHeaders(region) {
  const origin = originReferer(region);
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': CLIENT_UA,
  };
}

// Chat 请求头（upstream.ts:443-460）。uid/eid/domain 三选一：有值带 X-*，无值带 X-No-* 否定位。
function chatHeaders(region, userAgent, clientVersion, cred) {
  const headers = {
    ...commonHeaders(region),
    'User-Agent': userAgent,
    'Content-Type': 'application/json',
    ...(cred.uid ? { 'X-User-Id': cred.uid } : { 'X-No-User-Id': '1' }),
    ...(cred.enterpriseId ? { 'X-Enterprise-Id': cred.enterpriseId } : { 'X-No-Enterprise-Id': '1' }),
    ...(cred.domain ? { 'X-Domain': cred.domain } : { 'X-No-Department-Info': '1' }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': clientVersion,
    'X-Product': 'SaaS',
  };
  return headers;
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// role developer → system（upstream.ts:519-527）。WorkBuddy 拒 developer 角色 → 400 11128。
function normalizeDeveloperRole(obj) {
  const messages = obj['messages'];
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (isObject(m) && m['role'] === 'developer') m['role'] = 'system';
  }
}

// tool_choice 归一为上游接受的字符串形态（upstream.ts:530-567）
function normalizeToolChoice(obj) {
  const suppress = () => { delete obj['tools']; delete obj['functions']; };
  if (!('tool_choice' in obj)) return;
  const choice = obj['tool_choice'];
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') { delete obj['tool_choice']; suppress(); }
    return;
  }
  if (isObject(choice)) {
    const type = typeof choice['type'] === 'string' ? choice['type'].trim().toLowerCase() : '';
    if (type === 'none') { delete obj['tool_choice']; suppress(); }
    else if (type === 'auto' || type === 'required') obj['tool_choice'] = type;
    else if (type === 'function') {
      let name = isObject(choice['function']) && typeof choice['function']['name'] === 'string' ? choice['function']['name'] : '';
      if (!name && typeof choice['name'] === 'string') name = choice['name'];
      name = name.trim();
      obj['tool_choice'] = name !== '' ? name : 'auto';
    } else { delete obj['tool_choice']; }
    return;
  }
  delete obj['tool_choice'];
}

// 统一把 OpenAI chat body 适配到 WorkBuddy：强制 stream:true（上游拒非流式）、developer→system、tool_choice 归一
// （upstream.ts:503-516 prepareChatBody）
function prepareChatBody(source) {
  let body;
  try { body = JSON.parse(source); } catch { return source; }
  if (!isObject(body)) return source;
  body['stream'] = true;
  normalizeDeveloperRole(body);
  normalizeToolChoice(body);
  return JSON.stringify(body);
}

// 去掉适配器自己发的 reasoning_effort:'off'（两个 region 都拒，upstream.ts:1523-1525）
function dropUnsupportedEffort(obj) {
  if (obj['reasoning_effort'] === 'off') delete obj['reasoning_effort'];
}

// CN body（upstream.ts:1458-1469）：仅去 off effort。
function prepareCnChatBody(source) {
  let body;
  try { body = JSON.parse(source); } catch { return source; }
  if (!isObject(body)) return source;
  dropUnsupportedEffort(body);
  return JSON.stringify(body);
}

// 国际 body（upstream.ts:1471-1491）：prepareChatBody + 去 off effort + 首位补 system 提示（若无）。
function prepareInternationalChatBody(source) {
  const prepared = prepareChatBody(source);
  let body;
  try { body = JSON.parse(prepared); } catch { return prepared; }
  if (!isObject(body)) return prepared;
  dropUnsupportedEffort(body);
  const messages = body['messages'];
  if (!Array.isArray(messages)) return JSON.stringify(body);
  const first = messages[0];
  if (!(isObject(first) && first['role'] === 'system')) {
    messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT });
  }
  return JSON.stringify(body);
}

// 按 region 选 body 整形（upstream.ts:790）
function prepareChatBodyForRegion(region, source) {
  return region === 'global' ? prepareInternationalChatBody(source) : prepareCnChatBody(source);
}

// ===== 运行时配置 =====
const PORT = parseInt(process.env.WORKBUDDY_SHIM_PORT, 10) || 18789;
const BINDING = process.env.WORKBUDDY_SHIM_BINDING || '127.0.0.1';
const AUTH_TOKEN = process.env.WORKBUDDY_SHIM_AUTH_TOKEN || '';

function readCredential() {
  return {
    accessToken: process.env.WORKBUDDY_ACCESS_TOKEN || '',
    refreshToken: process.env.WORKBUDDY_REFRESH_TOKEN || '',
    uid: process.env.WORKBUDDY_UID || '',
    enterpriseId: process.env.WORKBUDDY_ENTERPRISE_ID || '',
    domain: process.env.WORKBUDDY_DOMAIN || '',
  };
}
function configuredModels() {
  return String(process.env.WORKBUDDY_MODELS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// 模型别名映射（env: WORKBUDDY_MODEL_ALIASES="wb-deepseek-v3.2:deepseek-v3.2,wb-r1:deepseek-r1"）。
// 用途：客户端用干净的 wb-xxx 名，避免跟真 DeepSeek 的 deepseek-v3.2 撞名；shim 转发前改写成
// WorkBuddy 真实接受的模型 id。未配置时启用默认规则：去掉 "wb-" 前缀（wb-deepseek-v3.2 → deepseek-v3.2）。
// 这是纯函数，便于单测；不改 WorkBuddy 私线，只改转发前的 model 字段。
function buildAliasMap() {
  const raw = String(process.env.WORKBUDDY_MODEL_ALIASES || '').trim();
  if (!raw) return null;
  const map = new Map();
  for (const pair of raw.split(',')) {
    const [from, to] = pair.split(':');
    if (from && to) map.set(from.trim(), to.trim());
  }
  return map.size ? map : null;
}

const _aliasMap = buildAliasMap();
function resolveModelAlias(model) {
  if (typeof model !== 'string' || !model) return model;
  if (_aliasMap && _aliasMap.has(model)) return _aliasMap.get(model);
  if (!_aliasMap && model.startsWith('wb-')) return model.slice(3);
  return model;
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (req.headers['x-proxy-auth'] === AUTH_TOKEN) return next();
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
}

function writeOpenAIError(res, status, code, message) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: code } }));
}

function mapUpstreamKindToStatus(kind) {
  switch (kind) {
    case 'auth': return 401;
    case 'session_dead': return 403;
    case 'rate_limit': return 429;
    case 'param': return 400;
    default: return 502;
  }
}

// 读取请求体（JSON）
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 50 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => {
      try { resolve(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 把 WorkBuddy 上游的 OpenAI 格式 SSE 聚合成单个完整 chat.completion 响应。
// 用途：客户端发 stream:false 时，shim 内部仍以 stream:true 打 WB（上游强制 SSE），
// 收完所有 chunk 后拼接成标准非流式 JSON 返回。覆盖"非流式客户端"（含工具初始化探测）。
async function aggregateStreamToCompletion(response, requestedModel) {
  const src = response && response.body;
  const nodeStream = (src && typeof src.getReader === 'function') ? Readable.fromWeb(src) : src;
  if (!nodeStream) throw new Error('上游响应无 body 流');
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let toolCalls = null;
  let finishReason = null;
  let usage = null;
  let id = null;
  let role = 'assistant';
  const flushLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    if (chunk.id && !id) id = chunk.id;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (choice) {
      const delta = choice.delta || {};
      if (delta.role) role = delta.role;
      if (typeof delta.content === 'string') content += delta.content;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        if (!toolCalls) toolCalls = [];
        for (const tc of delta.tool_calls) {
          const i = typeof tc.index === 'number' ? tc.index : toolCalls.length;
          if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function) {
            if (typeof tc.function.name === 'string') toolCalls[i].function.name += tc.function.name;
            if (typeof tc.function.arguments === 'string') toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (chunk.usage) usage = chunk.usage;
  };
  for await (const chunk of nodeStream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      flushLine(line);
    }
  }
  if (buffer.trim()) flushLine(buffer);
  const message = { role, content };
  if (toolCalls) message.tool_calls = toolCalls;
  const result = {
    id: id || ('chatcmpl-' + crypto.randomBytes(8).toString('hex')),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || 'workbuddy',
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
  };
  if (usage) result.usage = usage;
  return result;
}

// 把 WorkBuddy 上游返回的错误体抽出可读信息（upstream.ts:377-403 classifyUpstreamError 的简化版）
function extractDisplayErrorMessage(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.msg === 'string') return j.msg;
    if (j && typeof j.message === 'string') return j.message;
  } catch {}
  return null;
}

// Token 刷新（upstream.ts:807-830）：用 refreshToken 换 accessToken。best-effort，响应形态按常见字段取。
async function refreshToken(cred, region, signal) {
  if (!cred.refreshToken) return null;
  const origin = originReferer(region);
  const headers = {
    ...commonHeaders(region),
    'X-Refresh-Token': cred.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
    'Content-Type': 'application/json',
  };
  if (cred.enterpriseId) headers['X-Enterprise-Id'] = cred.enterpriseId;
  try {
    const resp = await fetch(`${chatBaseUrl(region)}/v2/plugin/auth/token/refresh`, {
      method: 'POST', headers, signal,
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const data = j && (j.data || j);
    const access = data && (data.accessToken || data.access_token || data.token);
    const refresh = data && (data.refreshToken || data.refresh_token);
    if (!access) return null;
    return { accessToken: String(access), refreshToken: refresh ? String(refresh) : cred.refreshToken };
  } catch {
    return null;
  }
}

async function handleChatCompletions(req, res) {
  const cred = readCredential();
  if (!cred.accessToken) {
    writeOpenAIError(res, 401, 'not_signed_in', 'WORKBUDDY_ACCESS_TOKEN 未配置：在 .env 注入你自己的 WorkBuddy 账号 token（见 README 的"获取 token"）');
    return;
  }
  let raw;
  try { raw = await readJsonBody(req); } catch { writeOpenAIError(res, 400, 'bad_request', '无法读取请求体'); return; }

  // 客户端原始意图（用于决定返回形态）
  let clientWantsStream = false;
  let clientModel = '';
  try {
    const parsed = JSON.parse(raw);
    if (isObject(parsed)) {
      clientWantsStream = parsed['stream'] === true;
      if (typeof parsed['model'] === 'string') clientModel = parsed['model'];
    }
  } catch {}

  // 别名解析：把客户端请求里的 wb-xxx 映射成 WorkBuddy 真实模型 id，再走 region 整形。
  let bodyForRegion = raw;
  try {
    const parsed = JSON.parse(raw);
    if (isObject(parsed) && typeof parsed['model'] === 'string') {
      const resolved = resolveModelAlias(parsed['model']);
      if (resolved !== parsed['model']) { parsed['model'] = resolved; bodyForRegion = JSON.stringify(parsed); }
    }
  } catch {}

  const region = regionOf(cred.domain);
  const clientVersion = region === 'global'
    ? (process.env.WORKBUDDY_CLIENT_VERSION || FALLBACK_GLOBAL_APP_VERSION)
    : (process.env.WORKBUDDY_CLIENT_VERSION || FALLBACK_CN_APP_VERSION);
  const userAgent = chatUserAgent(region, clientVersion);
  let bodyJson = prepareChatBodyForRegion(region, bodyForRegion);
  // WB 私线强制 SSE 流式：打 WB 永远 stream:true（CN 整形此前漏设，此处兜底所有 region）。
  try {
    const b = JSON.parse(bodyJson);
    if (isObject(b)) { b['stream'] = true; bodyJson = JSON.stringify(b); }
  } catch {}

  const headers = {
    ...chatHeaders(region, userAgent, clientVersion, cred),
    'Authorization': `Bearer ${cred.accessToken}`,
  };

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const doFetch = async (accessToken) => {
    const h = { ...headers, 'Authorization': `Bearer ${accessToken}` };
    return fetch(`${chatBaseUrl(region)}/v2/chat/completions`, {
      method: 'POST', headers: h, body: bodyJson, signal: controller.signal,
    });
  };

  let response;
  let refreshed = false;
  try {
    response = await doFetch(cred.accessToken);
    // 401/403 且带 refreshToken：尝试刷新一次后重试一次（best-effort）
    if ((response.status === 401 || response.status === 403) && cred.refreshToken && !refreshed) {
      const next = await refreshToken(cred, region, controller.signal);
      if (next) {
        refreshed = true;
        cred.accessToken = next.accessToken;
        cred.refreshToken = next.refreshToken;
        response = await doFetch(cred.accessToken);
      }
    }
  } catch (e) {
    writeOpenAIError(res, 502, 'upstream_unreachable', `WorkBuddy 上游不可达: ${String(e && e.message || e)}`);
    return;
  }

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 400);
    const detail = extractDisplayErrorMessage(text) || text || `http ${response.status}`;
    writeOpenAIError(res, mapUpstreamKindToStatus('upstream'), 'workbuddy_upstream_error', `workbuddy upstream error (http ${response.status}): ${detail}`);
    return;
  }

  // 成功：按客户端要求的 stream 形态返回
  if (clientWantsStream) {
    // 客户端要流式：原样透传 OpenAI 格式 SSE（dsh 插件已验证）。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const body = Readable.fromWeb(response.body);
    let sawDone = false;
    body.on('data', (chunk) => { if (String(chunk).includes('[DONE]')) sawDone = true; });
    body.on('error', (err) => {
      console.warn('[workbuddy-shim] 上游流中断:', err.message);
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n');
    });
    body.pipe(res);
    return;
  }

  // 客户端要非流式：内部以 stream:true 打 WB，聚合 SSE 为单个完整 chat.completion。
  try {
    const full = await aggregateStreamToCompletion(response, clientModel);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(full));
  } catch (e) {
    writeOpenAIError(res, 502, 'aggregation_failed', `非流式聚合失败: ${String(e && e.message || e)}`);
  }
}

function handleModels(req, res) {
  const models = configuredModels();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    object: 'list',
    data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'workbuddy' })),
  }));
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const path = url.split('?')[0];
  try {
    if (req.method === 'GET' && (path === '/healthz' || path === '/healthz/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, signedIn: !!readCredential().accessToken }));
      return;
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) {
      handleModels(req, res); return;
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/chat/completions/')) {
      requireAuth(req, res, () => handleChatCompletions(req, res)); return;
    }
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${path}`);
  } catch (e) {
    if (!res.headersSent) writeOpenAIError(res, 500, 'internal', String(e && e.message || e));
    else res.end();
  }
});

if (require.main === module) {
  const netWarn = BINDING !== '127.0.0.1' ? ' (network-exposed — 务必设 WORKBUDDY_SHIM_AUTH_TOKEN!)' : '';
  server.listen(PORT, BINDING, () => {
    console.log(`[workbuddy-shim] listening on ${BINDING}:${PORT}${netWarn}`);
    if (!readCredential().accessToken) console.warn('[workbuddy-shim] WARN: WORKBUDDY_ACCESS_TOKEN 未配置，/v1/chat/completions 会返回 401');
  });
}

module.exports = {
  server,
  // 协议纯函数（供单测）
  regionOf,
  chatBaseUrl,
  originReferer,
  chatUserAgent,
  commonHeaders,
  chatHeaders,
  normalizeDeveloperRole,
  normalizeToolChoice,
  prepareChatBody,
  dropUnsupportedEffort,
  prepareCnChatBody,
  prepareInternationalChatBody,
  prepareChatBodyForRegion,
  buildAliasMap,
  resolveModelAlias,
  aggregateStreamToCompletion,
};
