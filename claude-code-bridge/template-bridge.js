// claude-code-bridge — subscription-backed provider 骨架（第二个候选实例）
// Copyright © 2026 xiaoxian (Jason). Licensed under AGPL-3.0 (source).
//
// ⚠️ 这是骨架，不是可运行实现。详见同目录 README.md。
// 目的是验证 vendor-agent-bridge 抽象（docs/vendor-agent-bridge.md）确实可套用到 Claude Code：
//   框架层（独立 OpenAI 兼容网关 + 显式 token 注入 + 模型前缀 + 注册进 providers.json）
//   与 workbuddy-shim 完全同构；差异全在 CC 特有的「登录态落点 + 线协议」，那些是 TODO。
//
// 本文件里的协议函数都是占位/示意，标注了哪些必须按真实 CC 客户端实测补齐。
// 不要在没有实测前把它当成品跑——那会造出编造协议的假实现。

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// 零依赖 .env 加载器（与 workbuddy-shim 同款）
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

const PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT, 10) || 18788;
const BINDING = process.env.CLAUDE_BRIDGE_BINDING || '127.0.0.1';
const AUTH_TOKEN = process.env.CLAUDE_BRIDGE_AUTH_TOKEN || '';

// ── 协议纯函数（占位，待按真实 CC 客户端实测补齐）──

// TODO(1): 定位 CC 登录态。参考 workbuddy-shim/decrypt-token.js 的「只取你自己登录态、零网络」原则。
//   实际字段/文件需抓 CC 桌面端真实请求确认，不要猜。
function readCredential() {
  return {
    accessToken: process.env.CLAUDE_ACCESS_TOKEN || '', // 显式注入，不读桌面私有存储
    // refreshToken / uid / enterpriseId 等：按 CC 实际返回结构补
  };
}

// TODO(2): CC 实际端点。Pro/Max 订阅额度走 api.anthropic.com 还是 claude.ai 内部端点，需实测。
function claudeBaseUrl() {
  if (process.env.CLAUDE_BRIDGE_BASE_URL) return process.env.CLAUDE_BRIDGE_BASE_URL;
  return 'https://api.anthropic.com'; // 占位，待实测确认
}

// TODO(2): 把 OpenAI 兼容请求体翻译成 CC 接受的形态。
//   若 CC 客户端发 /v1/chat/completions（OpenAI 兼容），这里多半是透传；
//   若发 /v1/messages（Anthropic 格式），需要 messages↔ Anthropic 字段映射（system 提取、role 归一）。
//   这部分必须抓真实请求体对照写，不能凭训练知识编。
function prepareChatBodyForClaude(source) {
  let body;
  try { body = JSON.parse(source); } catch { return source; }
  if (!body || typeof body !== 'object') return source;
  // 占位：暂原样返回，等实测确定要整形的字段（如 stream 强制、tool_choice 归一、developer→system）。
  return JSON.stringify(body);
}

// 模型别名：cc-xxx → CC 真实模型 id（避免与真模型撞名）。
// 未配置时使用默认规则：去 "cc-" 前缀。
function buildAliasMap() {
  const raw = String(process.env.CLAUDE_BRIDGE_MODEL_ALIASES || '').trim();
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
  if (!_aliasMap && model.startsWith('cc-')) return model.slice(3);
  return model;
}

// ── 路由处理（结构同 workbuddy-shim，转发逻辑待实测）──

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c); size += c.length;
      if (size > 50 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => { try { resolve(Buffer.concat(chunks).toString('utf8')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function writeError(res, status, code, message) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: code } }));
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (req.headers['x-proxy-auth'] === AUTH_TOKEN) return next();
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
}

async function handleChatCompletions(req, res) {
  const cred = readCredential();
  if (!cred.accessToken) {
    writeError(res, 401, 'not_signed_in', 'CLAUDE_ACCESS_TOKEN 未配置：在 .env 注入你自己的 Claude Code 登录态 token');
    return;
  }
  let raw;
  try { raw = await readJsonBody(req); } catch { writeError(res, 400, 'bad_request', '无法读取请求体'); return; }

  // 别名解析
  let bodyForUpstream = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.model === 'string') {
      const resolved = resolveModelAlias(parsed.model);
      if (resolved !== parsed.model) { parsed.model = resolved; bodyForUpstream = JSON.stringify(parsed); }
    }
  } catch {}

  const prepared = prepareChatBodyForClaude(bodyForUpstream);

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cred.accessToken}`,
    // TODO(2): CC 要求的 Anthropic-Version / x-api-key 等头，按实测补
  };

  try {
    const response = await fetch(`${claudeBaseUrl()}/v1/messages`, {
      method: 'POST', headers, body: prepared,
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 400);
      writeError(res, response.status, 'claude_upstream_error', `claude upstream error (http ${response.status}): ${text}`);
      return;
    }
    // TODO(2): 把 CC 响应（Anthropic 格式或 SSE）翻译回 OpenAI 兼容形态再返回。
    // 流式/非流式处理同 workbuddy-shim 的 aggregateStreamToCompletion 思路。
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      Readable.fromWeb(response.body).pipe(res);
    } else {
      const data = await response.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data)); // 占位：未做 Anthropic→OpenAI 字段映射
    }
  } catch (e) {
    writeError(res, 502, 'upstream_unreachable', `Claude 上游不可达: ${String(e && e.message || e)}`);
  }
}

function handleModels(req, res) {
  const models = String(process.env.CLAUDE_BRIDGE_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'claude' })) }));
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const p = url.split('?')[0];
  try {
    if (req.method === 'GET' && (p === '/healthz' || p === '/healthz/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, signedIn: !!readCredential().accessToken }));
      return;
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/v1/models/')) { handleModels(req, res); return; }
    if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/chat/completions/')) {
      requireAuth(req, res, () => handleChatCompletions(req, res)); return;
    }
    writeError(res, 404, 'not_found', `no such route: ${req.method} ${p}`);
  } catch (e) {
    if (!res.headersSent) writeError(res, 500, 'internal', String(e && e.message || e));
    else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, BINDING, () => {
    console.log(`[claude-code-bridge][SKELETON] listening on ${BINDING}:${PORT} — 仅骨架，协议函数待实测补齐`);
  });
}

module.exports = {
  server,
  readCredential,
  claudeBaseUrl,
  prepareChatBodyForClaude,
  resolveModelAlias,
  buildAliasMap,
};
