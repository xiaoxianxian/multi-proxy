// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// ============================================================================
// claude-proxy — Claude Code 的 Anthropic 兼容网关（端口 18791）
//
// 定位：让 Claude Code **零改动**接入 multi-proxy 的上游池（DeepSeek / Moonshot
// 的 /anthropic 兼容端点 + Agnes），白拿 per-provider 熔断、预算预检、成本台账。
//
// 与 codex-proxy 的关系：同构分叉（沿用 dsh-proxy 模式）。共享路由策略/预算/
// 熔断三大模块的实现，差异只有三点：
//   ① 默认端口 18791（与 codex-proxy 18790 并存，互不抢占）；
//   ② MODEL_ALIASES：claude-* 模型名 → 上游模型名映射（核心增量，见下方定义）；
//   ③ 主 surface 是 /v1/messages（Anthropic 原生协议），chat/completions 保留
//      作 OpenAI 风格客户端备用口。
// ============================================================================

const express = require('express');
const { Readable, PassThrough } = require('stream');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// P0-E: 仅在直接运行时覆盖 console.log 输出 ISO 时间戳；被 require()（测试）时保留原行为。
if (require.main === module) {
  console.log = (...args) => {
    const ts = new Date().toISOString();
    process.stdout.write(`[${ts}] ${args.join(' ')}
`);
   };
}

const PORT = parseInt(process.env.PORT) || 18791;
const HOME = process.env.HOME || path.join(require('os').homedir());
const AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || '';

if (!AUTH_TOKEN) {
  // P0-C: fail-open with loud WARN — 未设 token 时 /api/* 对任意可达方开放，
  // 仅适合本机使用。暴露到网络前必须设 PROXY_AUTH_TOKEN。
  console.warn('[SECURITY][fail-open] PROXY_AUTH_TOKEN unset — /api/* open to anyone reachable; set it before network exposure.');
}

// ===== Auth Middleware =====
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next(); // Auth disabled if no token set
  const headerToken = req.headers['x-proxy-auth'];
  if (headerToken === AUTH_TOKEN) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

// ===== Config file detection =====
const DATA_DIR = path.join(HOME, '.multi-proxy-manager');
const ROUTING_MODE_FILE = path.join(DATA_DIR, 'routing-mode.json');

let CONFIG_TOML = findConfigToml();
let lastConfigModel = '';
let routingMode = 'codex'; // 'codex' | 'config' | 'both'

function findConfigToml() {
  const home = HOME;
  const candidates = [
    path.join(home, '.hermes', 'config.toml'),
    path.join(home, 'Library', 'Containers', 'app.nousresearch.hermes', 'Data', '.hermes', 'config.yaml'),
    path.join(home, '.codex', 'config.toml'),
    path.join(home, 'Library', 'Containers', 'com.openai.codex', 'Data', '.codex', 'config.toml'),
    path.join(home, 'Library', 'Application Support', 'Codex', 'config.toml'),
    path.join(home, '.codex-plus-plus', 'config.toml')
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        console.log(`[CONFIG] 检测到配置文件: ${candidate}`);
        return candidate;
      }
    } catch (e) {
      // ignore
    }
  }
  return candidates[0];
}

function parseConfigToml(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m);
    const modelProviderMatch = content.match(/^model_provider\s*=\s*"([^"]+)"/m);
    const wireApiMatch = content.match(/^wire_api\s*=\s*"([^"]+)"/m);
    const yamlModelMatch = content.match(/(?:^|\n)\s*default:\s*(\S+)/m);
    const yamlProviderMatch = content.match(/(?:^|\n)\s*provider:\s*(\S+)/m);

    let model = '';
    let model_provider = '';
    let wire_api = '';

    if (filePath.endsWith('.toml') || modelMatch) {
      model = modelMatch ? modelMatch[1] : '';
      model_provider = modelProviderMatch ? modelProviderMatch[1] : '';
      wire_api = wireApiMatch ? wireApiMatch[1] : '';
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml') || yamlModelMatch) {
      model = yamlModelMatch ? yamlModelMatch[1] : '';
      model_provider = yamlProviderMatch ? yamlProviderMatch[1] : '';
      wire_api = '';
    }

    return { model, model_provider, wire_api, raw: content };
  } catch (e) {
    return { model: '', model_provider: '', wire_api: '', raw: '', error: e.message };
  }
}

function updateConfigToml(filePath, newModel) {
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.toml')) {
      content = content.replace(/^model\s*=\s*".+"$/m, `model = "${newModel}"`);
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      content = content.replace(/(default:\s*)(\S+)/m, `$1${newModel}`);
      if (!content.includes(`default: ${newModel}`)) {
        content = content.replace(/(model:\s*\n\s*default:\s*)(\S+)/m, `$1${newModel}`);
      }
    } else {
      content = content.replace(/^model\s*=\s*".+"$/m, `model = "${newModel}"`);
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, message: `已更新配置文件，model 设置为 ${newModel}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getConfigModel() {
  if (!CONFIG_TOML) return '';
  try {
    const cfg = parseConfigToml(CONFIG_TOML);
    const newModel = cfg.model || '';
    if (newModel && newModel !== lastConfigModel) {
      if (lastConfigModel) {
        console.log(`[CONFIG WATCH] ${CONFIG_TOML} 变更: "${lastConfigModel}" → "${newModel}"`);
      }
      lastConfigModel = newModel;
      return newModel;
    }
  } catch (e) {
    console.warn(`[CONFIG WATCH] 读取 ${CONFIG_TOML} 失败: ${e.message}`);
  }
  return lastConfigModel;
}

function loadRoutingMode() {
  try {
    const data = fs.readFileSync(ROUTING_MODE_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed.mode && ['codex', 'config', 'both'].includes(parsed.mode)) {
      routingMode = parsed.mode;
    }
  } catch {
    routingMode = 'codex';
  }
}

function updateRoutingMode(mode) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = JSON.stringify({ mode }, null, 2);
    const tmpFile = ROUTING_MODE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, data, 'utf-8');
    fs.renameSync(tmpFile, ROUTING_MODE_FILE);
    console.log(`[ROUTING MODE] 路由模式已更新为: ${mode}`);
    return true;
  } catch (e) {
    // Clean up temp file on failure
    try { fs.unlinkSync(ROUTING_MODE_FILE + '.tmp'); } catch {}
    console.error(`[ROUTING MODE] 更新路由模式失败: ${e.message}`);
    return false;
  }
}

// ===== Upstream models =====
// 🔴 2026-10-11：apiKey 改成 getter 延迟读 env。
// 原因：const 表在模块加载时一次性求值 process.env.XXX，但 dotenv（第 7 行）
// 与 launchd 注入的 key 可能在之后才生效，导致首读时 key 为空 → 上游 401。
// 改成 getter 后，每次 findProvider() 调用时现读，key 总能拿到最新值。
//
// 🔴🔴 2026-10-12 二次修（纯 getter 引入的回归，必读）：
//   纯延迟读打破了「UPSTREAM_MODELS 是**模块加载时求值的常量**」这条既有约定
//   （codex-proxy-messages.test.js:26 注释里就是这么写的，测试在 require 之前设 env）。
//   现场：jest.setup-afterenv.js 的 afterEach 会把 process.env 恢复到 worker 加载时的
//   快照（那是为根治跨文件 env 泄漏 flaky 特意加的）⇒ 测试里 module-scope 设的
//   DEEPSEEK_API_KEY 在**第一个 test 结束后就被清掉** ⇒ getter 读到 undefined
//   ⇒ 「鉴权换成 provider 自己的 key」两条断言挂（全量套件 2 failed）。
//   解法：**运行时 env 优先，读不到回落加载时快照** ——
//     · 延迟读的价值完整保留（运行中被注入/改过的 key 照样生效，这才是改 getter 的目的）；
//     · 同时不再依赖 env 从头到尾都存在（顺带更稳：任何误删 env 的路径都不会丢 key）。
//   ⚠️ 别再改回纯 `process.env.XXX`：那会让 launchd/dotenv 注入晚于模块加载时 key 为空。
const _keyAtLoad = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  AGNES_API_KEY:    process.env.AGNES_API_KEY,
};
const UPSTREAM_MODELS = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    get apiKey() { return process.env.DEEPSEEK_API_KEY || _keyAtLoad.DEEPSEEK_API_KEY; },
    availableModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    get apiKey() { return process.env.MOONSHOT_API_KEY; },
    availableModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'moonshot-v1-128k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-8k-vision-preview', 'moonshot-v1-auto']
  },
  {
    name: 'Agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    get apiKey() { return process.env.AGNES_API_KEY || _keyAtLoad.AGNES_API_KEY; },
    // 🔴 2026-10-02 维护者订正：agnes-2.0-flash / agnes-1.5-flash 是老型号，官方不一定还收。
    // 实测：agnes-2.0-flash 与 2.5-flash 在 max_tokens=16 下 16 token 全被 thinking 吃掉、
    // body.content 恒为空（finish_reason=length）；agnes-1.5-flash 直接 503。
    // agnes-3.0-flash 实测 finish_reason=stop、真出正文 ⇒ 一律用 3.0-flash。
    availableModels: ['agnes-3.0-flash', 'agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-video-v2.0']
  }
];

// ===== MODEL_ALIASES：Claude Code 模型名 → 上游模型名（本代理的核心增量）=====
// Claude Code 的模型选择器 / --model / ANTHROPIC_MODEL 只会发 claude-* 名字，
// 不映射则每个请求都 UNSUPPORTED_MODEL。映射后 Claude Code 零改动接入上游池。
// 默认分档（.env 可覆盖：CLAUDE_ALIAS_OPUS / CLAUDE_ALIAS_SONNET / CLAUDE_ALIAS_HAIKU）：
//   opus/sonnet 档 → deepseek-v4-pro（重活的质量锚点）
//   haiku       档 → agnes-3.0-flash（后台轻活：标题生成/上下文压缩，越便宜越好）
const ALIAS_DEFAULTS = { opus: 'deepseek-v4-pro', sonnet: 'deepseek-v4-pro', haiku: 'agnes-3.0-flash' };
function aliasTarget(tier) {
  const fromEnv = process.env['CLAUDE_ALIAS_' + tier.toUpperCase()];
  return fromEnv || ALIAS_DEFAULTS[tier];
}
const MODEL_ALIAS_PATTERNS = [
  { re: /^claude-3-opus|^claude-opus/i, tier: 'opus' },
  { re: /^claude-3-5-sonnet|^claude-3-sonnet|^claude-sonnet/i, tier: 'sonnet' },
  { re: /^claude-3-5-haiku|^claude-3-haiku|^claude-haiku/i, tier: 'haiku' },
];
function resolveAlias(model) {
  if (typeof model !== 'string' || !model) return model;
  for (const p of MODEL_ALIAS_PATTERNS) {
    if (p.re.test(model)) return aliasTarget(p.tier);
  }
  return model; // 非 claude 名原样返回（上游真名直连）
}
// 就地改写 req.body.model（上游与成本记账都用映射后名字），返回映射结果。
function applyModelAlias(body) {
  const raw = body && body.model;
  const mapped = resolveAlias(raw);
  if (mapped !== raw && body) body.model = mapped;
  return mapped;
}
// 列进 /v1/models 展示用的别名（Claude Code 客户端真实会发的名字形态）。
const ALIAS_DISPLAY = [
  'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-5-sonnet-20241022',
  'claude-3-opus-20240229', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307',
];

function findProvider(modelName) {
  if (!modelName) return null;
  // 1. User-defined providers (created via Web UI, stored in providers.json)
  //    take priority. Their models are matched exactly; base_url + api_key
  //    come from the provider entry itself.
  const userProviders = loadProviders().filter(p => p.enabled !== false);
  for (const p of userProviders) {
    if (Array.isArray(p.models) && p.models.includes(modelName)) {
      // ⚠️ anthropicBaseUrl 必须一起带出：/v1/messages 的厂商规则对自定义上游未必适用，
      // 漏了它 = 显式逃生口形同不存在（测试抓到的）。
      return { name: p.name, baseUrl: p.base_url, apiKey: p.api_key, availableModels: p.models, anthropicBaseUrl: p.anthropicBaseUrl, responsesTranslate: p.responsesTranslate, responsesTarget: p.responsesTarget, messagesTranslate: p.messagesTranslate };
    }
  }
  const userMatch = userProviders.find(p => p.provider_id && modelName.toLowerCase().includes(String(p.provider_id).toLowerCase()));
  if (userMatch) {
    return { name: userMatch.name, baseUrl: userMatch.base_url, apiKey: userMatch.api_key, availableModels: userMatch.models || [], anthropicBaseUrl: userMatch.anthropicBaseUrl, responsesTranslate: userMatch.responsesTranslate, responsesTarget: userMatch.responsesTarget, messagesTranslate: userMatch.messagesTranslate };
  }

  // 2. Legacy built-in env-key providers (DeepSeek / Kimi / Agnes)
  let provider = UPSTREAM_MODELS.find(p => p.availableModels.includes(modelName));
  if (provider) return provider;
  const lower = modelName.toLowerCase();
  if (lower.includes('deepseek')) return UPSTREAM_MODELS[0];
  if (lower.includes('kimi') || lower.includes('moonshot')) return UPSTREAM_MODELS[1];
  if (lower.includes('agnes')) return UPSTREAM_MODELS[2];
  return null;
}

// ===== model-id 级路由策略（2026-10-12 P6，门控默认关）=====
// 把「这个网关代理哪些模型」从 provider 级细化到 model-id 级，落地 Q3 的
// 「只代理这 3 个模型、其余直连」。规则文件 ~/.multi-proxy-manager/routing-policy.json：
//   { "default": "direct", "rules": [ {"match":"deepseek-v4-flash","action":"proxy"}, … ] }
// 动作语义与纯函数实现见 routing-policy.js（parse/match/resolve 全部可单测）。
//
// 门控：PROXY_ROUTING_POLICY 不设 ⇒ routingPolicy = null ⇒ resolveRoute 恒返回 proxy
//       ⇒ 三条转发路径逐字不变（零行为变更才敢默认关）。
// 畸形 fail-safe：文件读不出/JSON 坏/形状不对 ⇒ 当作无策略 + 启动期大声报错。
//       与 P3「malformed 计价按标准价」同纪律：配错时退回已知安全的老行为。
const { parseRoutingPolicy, resolveRoute, resolveDirectTarget, buildDirectUpstreamUrl } = require('./routing-policy');
// 文件位置可用 env 覆盖（测试与「策略放别处」的场景都用它），缺省落在 DATA_DIR。
const ROUTING_POLICY_FILE = process.env.PROXY_ROUTING_POLICY_FILE || path.join(DATA_DIR, 'routing-policy.json');
const ROUTING_POLICY_GATE = ['1', 'true', 'on', 'yes'].includes(String(process.env.PROXY_ROUTING_POLICY || '').toLowerCase());
let routingPolicy = null;

// P7-2：预算预检（热路径前置闸门）。模块只暴露纯函数 + decide，门控关时 decide 恒 open。
// 三态（exact/degraded/open）的语义与快照字段说明见 budget-check.js 头注释。
const budgetCheck = require('./budget-check');
const BUDGET_GUARD_GATE = ['1', 'true', 'on', 'yes'].includes(String(process.env.PROXY_BUDGET_GUARD || '').toLowerCase());

function loadRoutingPolicy() {
  if (!ROUTING_POLICY_GATE) { routingPolicy = null; return; }
  let raw = null;
  try {
    if (fs.existsSync(ROUTING_POLICY_FILE)) {
      raw = JSON.parse(fs.readFileSync(ROUTING_POLICY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`[ROUTING-POLICY] ${ROUTING_POLICY_FILE} 读取/解析失败，按无策略处理（老行为）: ${e.message}`);
    raw = null;
  }
  const parsed = parseRoutingPolicy(raw);
  if (!parsed.ok) {
    console.error(`[ROUTING-POLICY] 策略畸形，按无策略处理（老行为）: ${parsed.error}`);
    routingPolicy = null;
    return;
  }
  routingPolicy = parsed.policy;
  if (routingPolicy) {
    console.log(`[ROUTING-POLICY] 已加载 model-id 级路由策略：default=${routingPolicy.default}, rules=${routingPolicy.rules.length} 条`);
  }
}

// P6 direct：把请求透到该 agent 的 takeover 真上游（P1 的真值库）。
// 🔴 解析不出 → 502 + 明写缺什么。绝不猜、绝不静默回落 proxy——那会让
//    「我想绕开网关」的意图悄悄失效（钱照记、流量照过），比报错更糟。
// direct 的全部含义就是「不走我们的链路」：不 captureTrace、不 reportUsage、不喂熔断。
async function forwardDirect(req, res, model, route) {
  const agent = detectAgent(req);
  let records = {};
  try {
    const f = path.join(DATA_DIR, `takeover-${agent}.json`);
    if (fs.existsSync(f)) {
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (rec && typeof rec === 'object') records[agent] = rec;
    }
  } catch (e) {
    console.error(`[ROUTING-POLICY] 读 takeover-${agent}.json 失败: ${e.message}`);
  }
  const target = resolveDirectTarget(agent, { records, env: process.env });
  if (!target.ok) {
    console.error(`[ROUTING-POLICY] direct 目标不可解析（model=${model}, agent=${agent}）: ${target.detail}`);
    if (!canWrite(res)) return;
    return res.status(502).json({
      success: false,
      error: `Direct route target unresolved: ${target.detail}`,
      code: 'DIRECT_TARGET_UNRESOLVED',
    });
  }

  const upstreamUrl = buildDirectUpstreamUrl(target.upstream, req.path);
  const headers = { 'Content-Type': 'application/json' };
  // Anthropic 原生协议（/v1/messages）认 x-api-key；OpenAI 兼容认 Bearer。按入口分发。
  if (req.path === '/v1/messages') {
    headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
    if (target.apiKey) {
      headers['x-api-key'] = target.apiKey;
      if (req.headers['authorization']) headers['authorization'] = `Bearer ${target.apiKey}`;
    }
  } else if (target.apiKey) {
    headers['Authorization'] = `Bearer ${target.apiKey}`;
  }

  const upstreamSignal = createUpstreamSignal(req, res);
  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: upstreamSignal,
    });
    if (!response.ok) {
      const err = await response.text();
      console.error(`[direct] upstream error (status ${response.status}) model=${model} agent=${agent}: ${err.slice(0, 300)}`);
      if (!canWrite(res)) return;
      return res.status(response.status).json({ success: false, error: 'Upstream error', code: 'UPSTREAM_ERROR' });
    }
    if (!canWrite(res)) return;
    if (response.body) {
      const ct = response.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'no-cache');
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.json(await response.json());
    }
  } catch (e) {
    console.error(`[direct] error model=${model} agent=${agent}: ${e.message}`);
    if (!canWrite(res)) return;
    return res.status(502).json({ success: false, error: e.message, code: 'DIRECT_UPSTREAM_ERROR' });
  }
}

// 三条转发路由共用的策略闸门。await 后看返回值：
//   'continue' —— 放行，走现有 proxy 链路（含门控关/无策略/action=proxy）
//   'handled'  —— 已终结请求（deny 的 400 或 direct 的转发/502），调用方直接 return
// 用法（放在 findProvider 空检查之后、circuitProvider 赋值之前）：
//   if (await applyRoutingPolicy(model, req, res) !== 'continue') return;
async function applyRoutingPolicy(model, req, res) {
  const route = resolveRoute(model, routingPolicy);
  if (route.action === 'deny') {
    res.status(400).json({
      success: false,
      error: `Model not permitted by routing policy: ${model}`,
      code: 'MODEL_NOT_PERMITTED',
    });
    return 'handled';
  }
  if (route.action === 'direct') {
    await forwardDirect(req, res, model, route);
    return 'handled';
  }
  return 'continue';
}

// P7-2：预算预检。放在路由策略之后、熔断之前——direct/deny 的请求不该进预算账，
// 预算也没必要为「绕开网关」的流量操心。用法同 applyRoutingPolicy：
//   if (await applyBudgetGuard(model, req, res) !== 'continue') return;
// 门控关 ⇒ 直接 'continue'，三条转发逐字不变（零行为变更）。
// 返回 'handled' 时已经写过 429（BUDGET_EXCEEDED），调用方直接 return。
async function applyBudgetGuard(model, req, res) {
  if (!BUDGET_GUARD_GATE) return 'continue';
  const body = req.body || {};
  const maxTokens = body.max_tokens != null ? body.max_tokens : body.max_completion_tokens;
  let d;
  try {
    d = await budgetCheck.decide(model, maxTokens, { now: new Date() });
  } catch (e) {
    // 判据自身异常 → fail-open（预算模块 bug 不该把正常流量挡了）
    console.error(`[BUDGET-GUARD] 判定异常，fail-open: ${e.message}`);
    return 'continue';
  }
  if (d.allowed) return 'continue';
  if (canWrite(res)) {
    res.status(429).json({
      success: false,
      error: `Budget guard: estimated worst-case cost ${d.estimate} CNY exceeds remaining ${d.remaining} (state=${d.state})`,
      code: 'BUDGET_EXCEEDED',
    });
  }
  return 'handled';
}

// ===== 上游熔断（2026-10-09，借鉴 cc-switch 的「错误率 + 最小样本」门控）=====
// 挂在 18790 而不是桥层，是因为这里才是真正 per-provider 路由的那层：
// agnes 挂掉不该连累 deepseek / kimi；桥（18795）只看到单一 UPSTREAM，分不出是谁挂了。
//
// 门控默认关：PROXY_CIRCUIT_BREAKER 未设 → breaker = null，三条转发逐字不变（零行为变更）。
// 语义与 l2/savings-gateway 同一条红线：
//   success  → 2xx → recordSuccess
//   upstream → 5xx / 429 / 408 / 网络不可达（上游故障）→ recordFailure
//   client   → 其他 4xx（客户端错，含坏 key）→ **不喂**。
//             反例：把 401 也记失败，一个用错 key 的客户端就能把整个 provider 熔断、连累所有流量。
const { createRecommendedBreaker } = require('../l2/circuit-breaker.js');
const CIRCUIT_BREAKER_ENV = String(process.env.PROXY_CIRCUIT_BREAKER || '').toLowerCase();
const CIRCUIT_MODE_RAW = String(process.env.PROXY_CIRCUIT_MODE || 'observe').toLowerCase();
const CIRCUIT_MODE = ['observe', 'block'].includes(CIRCUIT_MODE_RAW) ? CIRCUIT_MODE_RAW : 'observe';
const upstreamBreaker = ['1', 'true', 'recommended'].includes(CIRCUIT_BREAKER_ENV)
    ? createRecommendedBreaker()
    : null;

function classifyUpstreamStatus(status) {
    return (status >= 500 || status === 429 || status === 408) ? 'upstream' : 'client';
}

// 请求前：该 provider 已 OPEN 且 mode=block → 直接 503（快速失败，别让客户端干等超时）。
// observe（默认）与门控关时一律放行。
function circuitAllows(provider, res) {
    if (!upstreamBreaker || !provider) return true;
    if (upstreamBreaker.allowRequest(provider.name)) return true;
    if (CIRCUIT_MODE === 'block' && canWrite(res)) {
        res.status(503).json({ success: false, error: `Upstream circuit open: ${provider.name}`, code: 'CIRCUIT_OPEN' });
        return false;
    }
    return true;
}

function feedCircuit(provider, kind) {
    if (!upstreamBreaker || !provider) return;
    if (kind === 'success') { upstreamBreaker.recordSuccess(provider.name); return; }
    if (kind === 'upstream') upstreamBreaker.recordFailure(provider.name);
    // kind === 'client' → 故意不记：4xx 是客户端的错，不是上游健康信号
}

// ===== In-memory provider store =====
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');

function loadProviders() {
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch {}
  return [];
}

function saveProviders(providers) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // P0-8: 原子写 —— 直接 writeFileSync 在进程崩溃/磁盘满时会留下半截
    // JSON，下次 load 解析失败静默返回空数组导致数据全丢。tmp+rename 与
    // updateRoutingMode 同模式，rename 在同一文件系统上是原子的。
    const tmpFile = PROVIDERS_FILE + '.tmp';
    // P1: 文件含明文 API Key，收紧权限到 0600
    fs.writeFileSync(tmpFile, JSON.stringify(providers, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpFile, PROVIDERS_FILE);
  } catch (e) {
    try { fs.unlinkSync(PROVIDERS_FILE + '.tmp'); } catch {}
    console.error(`[PROVIDERS] Failed to save: ${e.message}`);
  }
}

let providers = loadProviders();

// ===== P5：模型目录上游同步（门控默认关，PROXY_MODEL_SYNC=1 才启用）=====
// 做的是一件朴素的事：用各供应商自己的 key 打它的 GET /v1/models，把**真实在售**
// 模型 add-only 并进本地缓存，/v1/models 从此反映上游现状而不是硬编码表
// （思路同 new-api 的 adaptor.GetModelList()）。细节与纪律见 model-sync.js 头部。
// 关时：下面的一切零调用，/v1/models 与旧版逐字一致。
const modelSync = require('./model-sync');
const MODEL_SYNC_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.PROXY_MODEL_SYNC || '').toLowerCase());
const MODEL_SYNC_INTERVAL_MS = parseInt(process.env.PROXY_MODEL_SYNC_INTERVAL_MS, 10) > 0
  ? parseInt(process.env.PROXY_MODEL_SYNC_INTERVAL_MS, 10)
  : 30 * 60 * 1000;   // 默认半小时一轮：模型列表不是热数据，别拿它当心跳打上游
const MODEL_CATALOG_FILE = path.join(DATA_DIR, 'model-catalog.json');

function loadModelCatalog() {
  try {
    if (fs.existsSync(MODEL_CATALOG_FILE)) {
      const d = JSON.parse(fs.readFileSync(MODEL_CATALOG_FILE, 'utf8'));
      if (d && Array.isArray(d.models)) return d;
    }
  } catch (e) {
    // 缓存坏掉按空目录继续 —— 绝不能因为这个让端点起不来
    console.error(`[MODEL-SYNC] 缓存读取失败（按空目录继续）: ${e.message}`);
  }
  return { version: 1, updatedAt: null, models: [], providers: {} };
}

function saveModelCatalog(catalog) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = MODEL_CATALOG_FILE + '.tmp';
    // 缓存只存模型 id/归属/状态，不含任何 key（纪律：key 不落这个盘）；
    // 0600 只是稳妥起见，与 providers.json 一致。
    fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, MODEL_CATALOG_FILE);
  } catch (e) {
    try { fs.unlinkSync(MODEL_CATALOG_FILE + '.tmp'); } catch {}
    console.error(`[MODEL-SYNC] 缓存写入失败: ${e.message}`);
  }
}

// 门控关时保持一个空目录对象，/v1/models 与 /health 读它零成本
let modelCatalog = MODEL_SYNC_ENABLED
  ? loadModelCatalog()
  : { version: 1, updatedAt: null, models: [], providers: {} };

async function runModelSyncOnce() {
  // 单个供应商 8s 超时：后台任务不该把进程或事件循环拖住
  const fetchWithTimeout = (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  const r = await modelSync.runModelSync({
    providers: loadProviders(),   // 每轮重读：Web UI 刚加的供应商下一轮就生效
    fetchImpl: fetchWithTimeout,
    readCache: loadModelCatalog,
    writeCache: saveModelCatalog,
  });
  modelCatalog = loadModelCatalog();
  const bad = Object.entries(r.providers).filter(([, s]) => !s.ok).map(([id, s]) => `${id}:${s.error}`);
  console.log(`[MODEL-SYNC] ok=${r.ok} failed=${r.failed} added=${r.added.length} total=${r.total}${bad.length ? ' 失败: ' + bad.join(', ') : ''}`);
  return r;
}

if (MODEL_SYNC_ENABLED) {
  // 启动期拉一次（不阻塞 listen）；之后每 interval 一轮，unref 不挂住进程退出
  runModelSyncOnce().catch((e) => console.error(`[MODEL-SYNC] 启动轮失败（不影响端点）: ${e.message}`));
  setInterval(() => {
    runModelSyncOnce().catch((e) => console.error(`[MODEL-SYNC] 本轮失败（不影响端点）: ${e.message}`));
  }, MODEL_SYNC_INTERVAL_MS).unref();
  console.log(`[MODEL-SYNC] 已启用：间隔 ${MODEL_SYNC_INTERVAL_MS}ms，缓存 ${MODEL_CATALOG_FILE}`);
}

function generateId() {
  return 'prov_' + Date.now().toString(36).padStart(9, '0') + '_' + Math.random().toString(36).substring(2, 8);
}

// ===== API Routes =====

// Models list
// P5：builtin + providers.json（旧行为）+ 上游同步目录（仅门控开时非空，add-only 合并）。
// 与旧版的两处差异都是有意的：① user providers 也参与全局去重（旧代码只在 builtin 内
// 去重，两家供应商列同一模型会吐重复 id）；② models 字段为对象形状时正确取 id
// （旧代码把对象当 id 塞进响应）。门控关闭时输出与旧版在无重复场景下逐字一致。
app.get('/v1/models', requireAuth, (req, res) => {
  const userProviders = loadProviders().filter((p) => p.enabled !== false);
  const resp = modelSync.buildModelsResponse({
    builtin: UPSTREAM_MODELS,
    userProviders,
    synced: MODEL_SYNC_ENABLED ? modelCatalog.models : [],
  });
  // Claude Code 的模型选择器只认 claude-* 名字：把别名也列出来，让选择器和
  // --model 有可展示/可校验的目标（别名请求会在转发前映射到上游真名）。
  for (const id of ALIAS_DISPLAY) {
    resp.data.push({ id, object: 'model', created: 0, owned_by: 'claude-alias' });
  }
  res.json(resp);
});

// Claude Code 的上下文联话计量会调 count_tokens；上游各家口径不一，
// 本地给一个保守估算（JSON 序列化长度 / 3，中文偏乐观场景也够用）。
app.post('/v1/messages/count_tokens', requireAuth, (req, res) => {
  let chars = 0;
  try {
    chars = JSON.stringify(req.body || {}).length;
  } catch (e) { chars = 0; }
  res.json({ input_tokens: Math.ceil(chars / 3) });
});

// Health check — M1 DAG 健康依赖图：分级状态 (ok/degraded/down) + 各检查项 + 原因。
// 保留 status:'healthy'（本进程存活即健康），checks/reasons 供 manager 聚合与 dashboard 展示原因。
// 向后兼容：新增字段为增量，旧调用方只读 status/uptime/models 不受影响。
function buildCodexHealthChecks() {
  const checks = { process: true, config: true, providers: true };
  const reasons = [];

  // config: 客户端配置（~/.claude.json / ~/.claude/settings.json）存在时校验可读性；
  // 不存在属常态（代理转发不依赖客户端配置），不算降级。
  try {
    const cfgPath = findConfigToml();
    if (cfgPath && fs.existsSync(cfgPath)) {
      const parsed = parseConfigToml(cfgPath);
      if (!parsed || parsed.error) {
        checks.config = false;
        reasons.push('客户端配置解析失败: ' + (parsed ? parsed.error : '未知'));
      }
    }
  } catch (e) {
    checks.config = false;
    reasons.push('客户端配置读取异常: ' + e.message);
  }

  // providers: providers.json 存在时校验合法性；不存在视为正常（默认态）
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    }
  } catch (e) {
    checks.providers = false;
    reasons.push('providers.json 损坏，已回退空列表');
  }

  return { checks, reasons };
}

/**
 * /health 用的熔断快照。
 *
 * ⚠️ 关键：真实记账全在 per-provider sibling 上，主实例（default）永远 CLOSED。
 * 只报主实例会让 observe 期的观察结果恒为「CLOSED / 0 outcomes」——等于瞎子摸象，
 * 也就没法拿数据决定要不要切 block。所以这里必须带 providers 明细 + 汇总。
 */
function buildCircuitSnapshot() {
  if (!upstreamBreaker) return { enabled: false };
  const list = Object.entries(upstreamBreaker.getProviders());
  return {
    enabled: true,
    mode: CIRCUIT_MODE,
    ...upstreamBreaker.getStateSnapshot(),     // 主实例（default），仅供对照
    providers: Object.fromEntries(list),
    totals: {
      tracked: list.length,
      open: list.filter(([, s]) => s.state === 'OPEN').map(([n]) => n),
      halfOpen: list.filter(([, s]) => s.state === 'HALF_OPEN').map(([n]) => n),
      outcomes: list.reduce((n, [, s]) => n + (s.outcomes || 0), 0),
      worstErrorRate: list.reduce((m, [, s]) => Math.max(m, s.errorRate || 0), 0),
    },
  };
}

app.get('/health', requireAuth, (req, res) => {
  const { checks, reasons } = buildCodexHealthChecks();
  const allOk = checks.process && checks.config && checks.providers;
  res.json({
    status: allOk ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    models: UPSTREAM_MODELS.flatMap(p => p.availableModels),
    checks,
    reasons,
    // per-provider 熔断状态（门控关 = enabled:false）
    circuit: buildCircuitSnapshot(),
    // P5：上游模型目录同步状态（门控关 = enabled:false；开了能看到 total/updatedAt/各供应商成败）
    modelSync: MODEL_SYNC_ENABLED
      ? { enabled: true, total: modelCatalog.models.length, updatedAt: modelCatalog.updatedAt, providers: modelCatalog.providers }
      : { enabled: false },
    // P6：model-id 级路由策略状态（门控关/无策略 = enabled:false，行为与上线前逐字一致）
    routingPolicy: routingPolicy
      ? { enabled: true, file: ROUTING_POLICY_FILE, default: routingPolicy.default, rules: routingPolicy.rules.length }
      : { enabled: false, file: ROUTING_POLICY_FILE },
    // P7-2：预算预检状态（门控关 = enabled:false；开了能看当前三态 mode + 剩额 + 本地累加）
    budgetGuard: BUDGET_GUARD_GATE
      ? { enabled: true, ...budgetCheck.getStatus() }
      : { enabled: false },
    timestamp: new Date().toISOString()
  });
});

// Admin API routes
// P0-A: 凭证泄露根治 —— 只回路由元数据，绝不回 raw（含 api_key / 上游 token）。
//   parseConfigToml() 内部仍保留 raw 供本地读用，但 HTTP 响应显式白名单字段。
app.get('/api/config', requireAuth, (req, res) => {
  const configTomlPath = findConfigToml();
  const parsed = parseConfigToml(configTomlPath);
  res.json({
    model: parsed.model,
    model_provider: parsed.model_provider,
    wire_api: parsed.wire_api,
    path: configTomlPath,
  });
});

// ===== Settings (key-value store for Web UI; e.g. current_model) =====
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    }
  } catch {}
  return {};
}

function saveSettings(settings) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error(`[SETTINGS] Failed to save: ${e.message}`);
  }
}

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: loadSettings() });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const { key, value } = req.body || {};
  if (!key) {
    return res.status(400).json({ success: false, error: 'Missing key', code: 'MISSING_KEY' });
  }
  const settings = loadSettings();
  settings[key] = value;
  saveSettings(settings);
  console.log(`[SETTINGS] ${key} = ${JSON.stringify(value)}`);
  res.json({ success: true });
});


app.get('/api/routing-mode', requireAuth, (req, res) => {
  loadRoutingMode();
  res.json({ mode: routingMode });
});

app.post('/api/set-routing-mode', requireAuth, (req, res) => {
  const { mode } = req.body;
  if (!['codex', 'config', 'both'].includes(mode)) {
    return res.status(400).json({ success: false, error: 'Invalid mode', code: 'INVALID_MODE' });
  }
  try {
    if (!updateRoutingMode(mode)) {
      return res.status(500).json({ success: false, error: 'Failed to write routing mode file', code: 'WRITE_FAILED' });
    }
    routingMode = mode;
    console.log(`[ADMIN] 路由模式设置为: ${mode}`);
    res.json({ success: true, mode });
  } catch (e) {
    console.error(`[ADMIN] 设置路由模式失败: ${e.message}`);
    res.status(500).json({ success: false, error: e.message, code: 'INTERNAL_ERROR' });
  }
});

app.get('/api/providers/status', requireAuth, (req, res) => {
  const providers = UPSTREAM_MODELS.map(p => ({
    name: p.name,
    baseUrl: p.baseUrl,
    status: p.apiKey ? 'online' : 'offline',
    models: p.availableModels
  }));
  res.json({ providers });
});

// Switch history (in-memory)
const switchHistory = [];
const MAX_HISTORY = 50;

app.get('/api/history', requireAuth, (req, res) => {
  res.json({ history: switchHistory.slice(0, 20).reverse() });
});

app.post('/api/switch-model', requireAuth, (req, res) => {
  const { model } = req.body;
  if (!model) {
    return res.status(400).json({ success: false, error: '缺少 model 参数', code: 'MISSING_MODEL' });
  }
  const provider = findProvider(model);
  if (!provider) {
    return res.status(400).json({ success: false, error: `不支持的模型: ${model}`, code: 'UNSUPPORTED_MODEL' });
  }
  try {
    const configTomlPath = findConfigToml();
    const currentConfig = parseConfigToml(configTomlPath);
    const oldModel = currentConfig.model;

    const updateResult = updateConfigToml(configTomlPath, model);
    if (!updateResult.success) throw new Error(updateResult.error);

    updateRoutingMode('config');
    routingMode = 'config';

    console.log(`[ADMIN] 模型切换: ${oldModel} → ${model}`);
    addHistory('切换模型', oldModel, model, 'config', true);

    res.json({
      success: true,
      message: `已成功切换到 ${model}，路由模式已设置为 config`,
      oldModel,
      newModel: model,
      needRestart: true
    });
  } catch (e) {
    console.error(`[ADMIN] 切换模型失败: ${e.message}`);
    addHistory('切换模型', '', model, '', false);
    res.status(500).json({ success: false, error: e.message, code: 'SWITCH_FAILED' });
  }
});

app.post('/api/test-connection', requireAuth, async (req, res) => {
  const { model } = req.body;
  if (!model) {
    return res.status(400).json({ success: false, error: '缺少 model 参数', code: 'MISSING_MODEL' });
  }
  const provider = findProvider(model);
  if (!provider) {
    return res.status(400).json({ success: false, error: `不支持的模型: ${model}`, code: 'UNSUPPORTED_MODEL' });
  }
  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${provider.apiKey}` }
    });
    if (response.ok) {
      res.json({ success: true, message: '连接成功' });
    } else {
      res.json({ success: false, error: `HTTP ${response.status}`, code: 'UPSTREAM_HTTP_ERROR' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message, code: 'CONNECTION_FAILED' });
  }
});

// ===== Provider CRUD =====

// GET /api/providers — list all providers
app.get('/api/providers', requireAuth, (req, res) => {
  const safe = providers.map(p => ({
    ...p,
    api_key: p.api_key ? p.api_key.substring(0, 4) + '****' : ''
  }));
  res.json({ providers: safe });
});

// POST /api/providers — create a new provider
app.post('/api/providers', requireAuth, (req, res) => {
  const { name, provider_id, api_key, base_url, enabled, models, responsesTranslate, responsesTarget, messagesTranslate } = req.body;
  if (!name || !provider_id || !api_key || !base_url) {
    return res.status(400).json({ success: false, error: 'Missing required fields: name, provider_id, api_key, base_url' });
  }
  if (providers.find(p => p.provider_id === provider_id)) {
    return res.status(409).json({ success: false, error: 'Provider ID already exists' });
  }
  const provider = {
    id: generateId(),
    name,
    provider_id,
    api_key,
    base_url,
    models: Array.isArray(models) ? models.filter(m => typeof m === 'string') : [],
    enabled: enabled !== false,
    responsesTranslate: responsesTranslate === true,
    responsesTarget: responsesTarget === 'messages' ? 'messages' : (responsesTarget || 'chat'),
    messagesTranslate: messagesTranslate === true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  providers.push(provider);
  saveProviders(providers);
  res.json({ success: true, provider });
});

// PUT /api/providers/:id — update a provider
app.put('/api/providers/:id', requireAuth, (req, res) => {
  const idx = providers.findIndex(p => p.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Provider not found' });
  }
  const allowedFields = ['name', 'provider_id', 'api_key', 'base_url', 'enabled', 'models', 'responsesTranslate', 'responsesTarget', 'messagesTranslate'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  updates.updated_at = new Date().toISOString();
  providers[idx] = { ...providers[idx], ...updates };
  saveProviders(providers);
  res.json({ success: true, provider: providers[idx] });
});

// DELETE /api/providers/:id — delete a provider
app.delete('/api/providers/:id', requireAuth, (req, res) => {
  const idx = providers.findIndex(p => p.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Provider not found' });
  }
  providers.splice(idx, 1);
  saveProviders(providers);
  res.json({ success: true });
});

// ===== 客户端断开 → 上游一起停（L004 · 2026-10-04 修）=====
//
// 三处转发（/v1/chat/completions、/v1/responses、/v1/messages）原先只挂
// AbortSignal.timeout(120000)：客户端 5 秒关掉连接（Ctrl-C、关窗口、agent 自己超时），
// 上游 fetch 照样跑满 120 秒才收手，就是「僵尸请求」。卖接入交付之前必须先修掉，
// 否则用户一次误操作就白烧一份长上下文的钱，长任务还能叠出十几个并行僵尸。
//
// 三个坑踩过才写成这样：
//   ① 用单个 AbortController 管「客户端断」+「超时」两件事， abort 的 reason 自己给。
//      用 AbortSignal.any() 合成虽然更短，但合成后的 signal 丢掉 reason，
//      日志里分不清「用户走了」还是「上游慢」，排障时这个区别就是全部线索。
//   ② res 的 'close' 事件在**正常写完**时同样会触发，只认 !res.writableEnded，
//      否则每一笔正常请求都会把自己刚拿到的上游掐断。
//   ③ setTimeout 必须 unref，不然每个在途请求都把事件循环拽住，进程退不出去。
const UPSTREAM_TIMEOUT_MS = 120000;

const CLIENT_GONE = new Error('client aborted');

/**
 * 判「客户端是不是已经走了」。
 *
 * 不能用 res.writableEnded 单独下结论：客户端拔线时 Node 常把这一轮响应顺手标成
 * ended（L004 修的时候就被这个骗过一次，于是账还是照报）。真正硬的判据是** socket 死没死**，
 * writableEnded 只在确认「是我们自己写完的」时才算数。
 */
function isClientGone(req) {
  // 别拿 req.destroyed 单独立论：响应正常走完时 req 同样是 destroyed=true，
  // 一判断就变成「每笔正常请求都判客户端走了」，上游会被自己掐掉。
  if (!req) return false;
  if (req.aborted) return true;
  if (req.complete === false) return true;               // 请求体没收完就关
  if (req.readableEnded && !req.complete) return true;   // 收不满就想走
  return false;
}

function isResClosedEarly(res) {
  // 只给 res 的 'close' 用：此时 res 已经关了，要么是我们写完（调用方先用
  // selfFinished 挡掉），要么是客户端拔了。别拿去给 req 的 'close' 判。
  if (!res) return false;
  if (res.socket && res.socket.destroyed) return true;
  if (res.destroyed) return true;
  if (res.writableEnded || res.writableFinished) return false; // 是我们自己写完的
  return true;
}

function createUpstreamSignal(req, res, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  let settled = false;
  const abort = (reason) => {
    if (settled) return;
    settled = true;
    controller.abort(reason);
  };

  // 🔴 每个在途请求都会在 req/res 上挂 3 个监听器（req.aborted、req.close、res.finish、res.close），
  // 全生命周期不摘的话，高并发或长跑测试会触发 MaxListenersExceededWarning。
  // 用一个 cleanup 在 abort 事件上一次性摘掉，避免监听器堆积。
  const cleanups = [];
  if (req && typeof req.on === 'function') {
    const hAborted = () => abort(CLIENT_GONE);
    const hClose = () => { if (isClientGone(req)) abort(CLIENT_GONE); };
    req.on('aborted', hAborted); // Node 16 起弃用，2026-10 实测仍生效
    req.on('close', hClose);      // Node 18+ 兜底
    cleanups.push(() => { req.removeListener('aborted', hAborted); req.removeListener('close', hClose); });
  }
  if (res && typeof res.on === 'function') {
    // 🔴 res 的 'close' 在 keep-alive 下**可能早于 'finish'** 触发，
    // 光看 writableEnded 会把「自己写完了、socket 顺手关掉」误判成「客户端拔了」，
    // 结果每一笔正常请求都把刚拿到的上游掐掉。所以自己写完这件事得单独记一笔。
    let selfFinished = false;
    const hFinish = () => { selfFinished = true; };
    const hClose = () => { if (!selfFinished && isResClosedEarly(res)) abort(CLIENT_GONE); };
    res.on('finish', hFinish);
    res.on('close', hClose);
    cleanups.push(() => { res.removeListener('finish', hFinish); res.removeListener('close', hClose); });
  }

  const timer = setTimeout(() => abort(new Error('upstream timeout')), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  // 响应写完后（正常收尾）不再等这个定时器，也别留着监听器
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    for (const fn of cleanups) { try { fn(); } catch {} }
  }, { once: true });
  return controller.signal;
}

/**
 * 客户端都已经走了，就别再往 res 上写东西。
 * 断连后 res.status(...).json(...) 会变成 write-after-end，日志里又是一堆假错误。
 */
function canWrite(res) {
  return !!(res && !res.destroyed && !res.headersSent);
}

// ===== Balance Query =====

// Known balance API endpoints per provider type
const BALANCE_ENDPOINTS = {
  deepseek: ['https://api.deepseek.com/user/info', 'GET'],
  moonshot: ['https://api.moonshot.cn/user/info', 'GET'],
  agnes: ['https://apihub.agnes-ai.com/user/balance', 'GET'],
  openai: ['https://api.openai.com/dashboard/billing/credit_grants', 'GET'],
  anthropic: null,
  ollama: null,
};

function detectProviderType(providerId) {
  const lower = providerId.toLowerCase();
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('moonshot') || lower.includes('kimi')) return 'moonshot';
  if (lower.includes('agnes') || lower.includes('agnes-ai')) return 'agnes';
  if (lower.includes('openai')) return 'openai';
  if (lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('ollama')) return 'ollama';
  return 'generic';
}

// GET /api/balances — query balances for all providers
app.get('/api/balances', requireAuth, async (req, res) => {
  const balances = {};
  for (const provider of providers) {
    if (!provider.enabled || !provider.api_key) {
      balances[provider.name] = '未启用';
      continue;
    }
    const type = detectProviderType(provider.provider_id);
    const endpoint = BALANCE_ENDPOINTS[type];
    if (!endpoint) {
      balances[provider.name] = '不支持';
      continue;
    }
    try {
      const [url, method] = endpoint;
      const response = await fetch(url, {
        method,
        headers: { 'Authorization': `Bearer ${provider.api_key}` },
        // L004 同源：客户端关页面后这串余额查询不该还在跑到第 6 个上游
        signal: createUpstreamSignal(req, res, 10000)
      });
      if (response.ok) {
        const data = await response.json();
        balances[provider.name] = data.balance || data.amount || data.totalAmount || data.total_available || '未知';
      } else {
        balances[provider.name] = `查询失败 (HTTP ${response.status})`;
      }
    } catch (e) {
      balances[provider.name] = `错误: ${e.message}`;
    }
  }
  res.json({ balances });
});

app.post('/api/clear-history', requireAuth, (req, res) => {
  switchHistory.length = 0;
  res.json({ success: true });
});

function addHistory(action, from, to, mode, success) {
  switchHistory.push({ timestamp: Date.now(), action, from, to, mode, success });
  if (switchHistory.length > MAX_HISTORY) switchHistory.shift();
}

// Chat Completions passthrough
app.post('/v1/chat/completions', requireAuth, async (req, res) => {
  let circuitProvider = null;   // 熔断记账用：catch 作用域拿不到 try 里的 provider
  try {
    const requestedModel = req.body.model;
    const model = applyModelAlias(req.body);
    if (model !== requestedModel) console.log(`[alias] ${requestedModel} → ${model}`);
    const provider = findProvider(model);
    if (!provider) {
      return res.status(400).json({ success: false, error: `Unsupported model: ${model}`, code: 'UNSUPPORTED_MODEL' });
    }
    // P6：model-id 级路由策略。deny/direct 在这里终结；proxy 才继续往下。
    // 放在 circuitProvider 赋值之前 —— direct 的失败不该喂熔断（那不是上游健康信号）。
    if (await applyRoutingPolicy(model, req, res) !== 'continue') return;
    // P7-2：预算预检（gate 关时恒 'continue'）。放熔断之前：被预算挡的请求不算上游故障。
    if (await applyBudgetGuard(model, req, res) !== 'continue') return;
    circuitProvider = provider;

    // 熔断：block 模式下该 provider 已 OPEN → 快速 503，别让客户端干等上游超时
    if (!circuitAllows(provider, res)) return;

    const t0 = Date.now();
    const upstreamUrl = `${provider.baseUrl}/chat/completions`;
    // L004：客户端一走，这份 signal 立刻让上游停下，不再空跑满 120 秒
    const upstreamSignal = createUpstreamSignal(req, res);
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(req.body),
      signal: upstreamSignal,
    });

    if (!response.ok) {
      feedCircuit(provider, classifyUpstreamStatus(response.status));
      // Log the raw upstream error internally for debugging
      const err = await response.text();
      console.error(`Chat upstream error (status ${response.status}): ${err}`);
      // Sanitize: never leak provider diagnostic details to the client
      if (!canWrite(res)) return;
      return res.status(response.status).json({ success: false, error: 'Upstream error', code: 'UPSTREAM_ERROR' });
    }

    feedCircuit(provider, 'success');

    if (req.body.stream) {
      // 流式也接成本采集：复用 pipeUpstreamBytes tee 一份字节、流走完再抽 usage 上报，
      // 与 /v1/messages 同款。dsh 走的就是这条流式 chat 链路（api: openai-completions），
      // 之前直接 readable.pipe(res) 没攒字节 ⇒ 流量过 18790 但成本链路抓不到。
      // 只在 outcome==='completed' 上报：客户端中途断开=虚账，半截 usage 报上去比少报一笔更难看（L004）。
      const { outcome, acc } = await pipeUpstreamBytes(res, response, '[chat]', upstreamSignal);
      if (outcome === 'completed' && acc && !upstreamSignal.aborted) {
        captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'claude-proxy', stream: true } });
        reportUsage(acc, Date.now() - t0, detectAgent(req), req.body && req.body.model);
      }
    } else {
      const data = await response.json();
      captureTrace({ req, provider, rawOrObj: data, meta: { agent: 'claude-proxy', stream: false } });
      res.json(data);
      // 成本采集：chat 路由此前只有 /v1/messages 接了 reportUsage，dsh 走的这条一直没进账。
      // 流式分支暂不接（usage 藏在流末、客户端中途断开=虚账），先保非流式完整可记账。
      reportUsage(JSON.stringify(data), Date.now() - t0, detectAgent(req), req.body && req.body.model);
    }
  } catch (e) {
    // 客户端拔了（canWrite=false）不算上游故障，不喂熔断；其余视为上游不可达
    if (canWrite(res)) feedCircuit(circuitProvider, 'upstream');
    console.error(`Chat error: ${e.message}`);
    // 客户端断了才走到这里（L004 后的新路径）：不打日志刷屏，也不往死 socket 上写
    if (!canWrite(res)) return;
    res.status(500).json({ success: false, error: e.message, code: 'CHAT_ERROR' });
  }
});

// ===== Responses passthrough（codex 客户端默认就走这条协议）=====
// 此前 18790 只接 /v1/chat/completions，codex 发 /v1/responses 一律 404——
// 也就是说这个「codex proxy」从来没真正服务过 codex 的默认流量。补上之后
// codex 不必再依赖一个额外的桥进程，归一化也照旧（见下）。
//
// 归一化**复用** tools/token-policy-bridge.js 里已实测的那份（见 50 号文档 §一），
// 不在这里复制第二份：两份实现必然漂移，代价就是「这条路工具类型不兼容、那条兼容」。
const { normalizeTools } = require('../tools/token-policy-bridge.js');
// P8：Responses API ⇄ ChatCompletions / Anthropic Messages 双向翻译（与 codex-proxy 同层实现）。
//   上游不原生支持 /v1/responses 时，开启 provider.responsesTranslate 即可对接；默认 false = 维持原透传。
const RT = require('../l2/responses-translate.js');

// P8 翻译分支：把 Responses 请求翻成上游真支持的协议（ChatCompletions / Messages），
//   再把上游响应翻回 Responses 格式。仅当 provider.responsesTranslate 为真时走这条；
//   默认关 → 下方路由维持原透传路径（零行为变更）。
async function handleTranslatedResponses(req, res, provider, upstreamSignal) {
  const target = provider.responsesTarget === 'messages' ? 'messages' : 'chat';
  const { body: norm } = normalizeTools(req.body);
  const translated = target === 'messages'
    ? RT.responsesToMessages(norm)
    : RT.responsesToChatCompletions(norm);
  translated.stream = !!req.body.stream;

  let upstreamUrl, headers;
  if (target === 'messages') {
    upstreamUrl = anthropicMessagesUrl(provider);
    headers = { 'Content-Type': 'application/json', 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' };
    if (provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
      if (req.headers['authorization']) headers['authorization'] = `Bearer ${provider.apiKey}`;
    }
  } else {
    upstreamUrl = `${provider.baseUrl}/chat/completions`;
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` };
  }

  const response = await fetch(upstreamUrl, {
    method: 'POST', headers, body: JSON.stringify(translated), signal: upstreamSignal,
  });
  if (!response.ok) {
    feedCircuit(provider, classifyUpstreamStatus(response.status));
    const err = await response.text();
    console.error(`[responses-translate] upstream error (${target}, status ${response.status}): ${err.slice(0, 300)}`);
    if (!canWrite(res)) return;
    return res.status(response.status).json({ success: false, error: 'Upstream error', code: 'UPSTREAM_ERROR' });
  }
  feedCircuit(provider, 'success');

  if (!translated.stream) {
    const upstreamJson = await response.json();
    const resp = target === 'messages'
      ? RT.messagesToResponses(upstreamJson, req.body)
      : RT.chatCompletionsToResponses(upstreamJson, req.body);
    if (!canWrite(res)) return;
    res.json(resp);
    captureTrace({ req, provider, rawOrObj: upstreamJson, meta: { agent: 'claude-proxy', stream: false, translated: target } });
    return;
  }

  // 流式：把上游 SSE 逐行解析，翻成 Responses SSE 写给客户端
  if (!canWrite(res)) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const emitter = new RT.ResponsesStreamEmitter(req.body);
  const nodeStream = Readable.fromWeb(response.body);
  let buffer = '';
  let pendingUsage = null;
  const anthropicBlocks = new Map();
  const ingestAnthropic = (ev) => {
    if (ev.type === 'content_block_start') {
      const b = ev.content_block || {};
      anthropicBlocks.set(ev.index, { type: b.type, id: b.id, name: b.name, input: '' });
    } else if (ev.type === 'content_block_delta') {
      const b = anthropicBlocks.get(ev.index);
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) { const s = emitter.pushText(d.text); if (s) res.write(s); }
      else if (d.type === 'input_json_delta' && b) { b.input += d.partial_json || ''; }
    } else if (ev.type === 'content_block_stop') {
      const b = anthropicBlocks.get(ev.index);
      if (b && b.type === 'tool_use') { const s = emitter.pushTool(ev.index, { id: b.id, function: { name: b.name, arguments: b.input } }); if (s) res.write(s); }
    } else if (ev.type === 'message_delta') {
      if (ev.usage) pendingUsage = { completion_tokens: ev.usage.output_tokens || 0, prompt_tokens: 0, total_tokens: 0 };
    }
  };
  const flushLine = (data) => {
    if (data === '[DONE]') return;
    let obj; try { obj = JSON.parse(data); } catch { return; }
    if (target === 'messages') { ingestAnthropic(obj); return; }
    const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (delta && delta.content) { const s = emitter.pushText(delta.content); if (s) res.write(s); }
    if (delta && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) { const s = emitter.pushTool(tc.index, tc); if (s) res.write(s); }
    }
    if (obj.usage) pendingUsage = obj.usage;
  };
  try {
    for await (const chunk of nodeStream) {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
        const t = line.trim();
        if (t.startsWith('data:')) flushLine(t.slice(5).trim());
      }
    }
    const s = emitter.end(pendingUsage); if (s) res.write(s);
    res.end();
  } catch (e) {
    if (canWrite(res)) { try { const s = emitter.end(pendingUsage); res.write(s); } catch { /* noop */ } res.end(); }
    console.error(`[responses-translate] stream error: ${e.message}`);
  }
}

app.post('/v1/responses', requireAuth, async (req, res) => {
  let circuitProvider = null;
  try {
    const { model } = req.body;
    const provider = findProvider(model);
    if (!provider) {
      return res.status(400).json({ success: false, error: `Unsupported model: ${model}`, code: 'UNSUPPORTED_MODEL' });
    }
    // P6：model-id 级路由策略（deny→400 / direct→透传 takeover 真上游 / proxy→继续）
    if (await applyRoutingPolicy(model, req, res) !== 'continue') return;
    // P7-2：预算预检（gate 关时恒 'continue'）
    if (await applyBudgetGuard(model, req, res) !== 'continue') return;
    circuitProvider = provider;
    if (!circuitAllows(provider, res)) return;

    // P8：翻译分支（上游不原生支持 /v1/responses 时）。门控默认关 → 维持原透传。
    if (provider.responsesTranslate) {
      const upstreamSignal = createUpstreamSignal(req, res);
      await handleTranslatedResponses(req, res, provider, upstreamSignal);
      return;
    }

    // 注意返回值是 { body, changed, from } 包装对象，不是 body 本身——直接 stringify
    // 整个返回值会把 model 一起弄丢（上游报 "model name cannot be empty"）。
    const { body } = normalizeTools(req.body);
    // agnes 的 /v1/responses 不吃「没有 stream 字段」的包（50 号文档 §四）：漏带就按非流发，
    // 否则上游必返 500。codex 自己发的包总是带 stream，这条只兜非 codex 来源。
    if (!Object.prototype.hasOwnProperty.call(body, 'stream')) body.stream = false;

    const upstreamUrl = `${provider.baseUrl}/responses`;
    // L004
    const upstreamSignal = createUpstreamSignal(req, res);
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(body),
      signal: upstreamSignal,
    });

    if (!response.ok) {
      feedCircuit(provider, classifyUpstreamStatus(response.status));
      const err = await response.text();
      console.error(`[responses] upstream error (status ${response.status}): ${err.slice(0, 300)}`);
      if (!canWrite(res)) return;
      return res.status(response.status).json({ success: false, error: 'Upstream error', code: 'UPSTREAM_ERROR' });
    }
    feedCircuit(provider, 'success');
    const { outcome, acc } = await pipeUpstreamBytes(res, response, '[responses]', upstreamSignal);
    if (outcome === 'completed' && acc && !upstreamSignal.aborted) {
      captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'claude-proxy', stream: !!req.body.stream } });
    }
  } catch (e) {
    if (canWrite(res)) feedCircuit(circuitProvider, 'upstream');
    console.error(`[responses] error: ${e.message}`);
    if (!canWrite(res)) return;
    return res.status(500).json({ success: false, error: e.message, code: 'RESPONSES_ERROR' });
  }
});

/**
 * 把上游响应按原始字节转发出去。
 * chat 那条不得不用 Readable.fromWeb 是因为 Web ReadableStream 与 Express 的 res 不兼容
 * （B6 fix：直接 pipeTo 会抛 TypeError → 504）；responses 是同一个坑，所以共用这一份。
 *
 * 返回 { outcome, acc }：outcome 取 'completed' / 'client-aborted' / 'stream-error'。
 * 攒到的字节走 acc 交还调用方（用法见 /v1/messages），不再用回调——回调和返回值双轨
 * 很容易一疏漏报两次账，跟 L004 是同一类问题。
 */
function pipeUpstreamBytes(res, response, tag, signal) {
  if (!response.body) { res.end(); return; }
  const ct = response.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const readable = Readable.fromWeb(response.body);

  // usage 藏在**流末**（Anthropic 的 message_delta / 末 chunk），所以必须边 pipe 边攒字节，
  // 等流走完再给出去 —— 攒一份副本换「流式体验不被破坏 + 账本不丢数」。
  let acc = '';
  const tee = new PassThrough();
  tee.on('data', (c) => { acc += c.toString('utf8'); });

  // L004：客户端一走（signal abort）就地掐断上游字节流，不再等 120 秒慢慢跑。
  //
  // 🔴 判「是不是被客户端掐的」一律读 signal.aborted，**不要**在 abort 事件里设一个
  // 闭包变量：2026-10-04 实测 abort 与 res 'close' 的相对顺序在 Node 里不保证，
  // 用闭包变量会漏判，结果账照报（outcome 仍是 completed）。读标记位没有时序依赖。
  const abortedByClient = () => !!(signal && signal.aborted);
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', () => {
      try { readable.destroy(); } catch { /* 已经死了就别再吵 */ }
    }, { once: true });
  }

  return new Promise((resolve, reject) => {
    // 🔴 close 与 finish **对同一次响应都会触发**，不加幂等守卫 onBytes 会被跑两次
    // （2026-10-02 e2e 实测：requestCount 多 1、同一笔 usage 落两遍账，totalTokens 翻倍）。
    let done = false;
    const settle = (outcome) => {
      if (done) return;
      done = true;
      // 主链断了，tee 别还攥着攒到的字节不撒手
      try { tee.destroy(); } catch { /* ignore */ }
      resolve({ outcome, acc });
    };
    readable.on('error', (err) => {
      console.error(`[${tag}] stream error: ${err.message}`);
      if (!res.headersSent) {
        res.status(504).json({ success: false, error: 'Stream timeout or upstream disconnected', code: 'STREAM_TIMEOUT' });
      }
      // 原先这里只打日志不 settle ⇒ promise 永远挂着，客户端走了请求对象还留着（L004 附带修）
      settle(abortedByClient() ? 'client-aborted' : 'stream-error');
    });
    readable.pipe(tee).pipe(res);
    res.on('close', () => settle(abortedByClient() ? 'client-aborted' : 'completed'));
    res.on('finish', () => settle(abortedByClient() ? 'client-aborted' : 'completed'));
    res.on('error', reject);
  });
}

/**
 * 把这次转发的 usage 报给 manager 的 cost-track（POST /api/cost/report）。
 *
 * 接入面是**同一条**：任何 agent 的代理都报这个端点、都只贴 `raw`（上游 usage 原样），
 * 解析/归一由 manager 侧 lib/usage-probe 自动生成 —— 接入方不写解析、不改 wire 知识。
 * 详见 routes/cost-report.js 头注释。
 *
 * 🔴 纪律：上报是**旁路**，fire-and-forget + 全 catch。manager 挂了 / 格式认不出，
 * 都不能让主路径（Claude Code 的请求）失败或变慢。
 */
function reportUsage(raw, latencyMs, agent, model) {
  if (!raw || typeof raw !== 'string') return;
  const url = String(process.env.MANAGER_URL || 'http://127.0.0.1:18792').replace(/\/$/, '');
  // 写端点不 fail-open：没 token 就不报，宁可少一笔账也不让陌生人灌假成本。
  // manager 侧 lib/auth.js 的 requireAgentAuth 认这个头；MANAGER_AGENT_TOKEN 由
  // manager 注入自身 env → spawnProxy 的 { ...process.env } 自动带进来（开盒即用）。
  const agentToken = process.env.MANAGER_AGENT_TOKEN || process.env.PROXY_AUTH_TOKEN;
  const headers = { 'content-type': 'application/json' };
  if (agentToken) headers['x-agent-token'] = agentToken;
  // model / requestModel 原样带上：否则过代理的 openai 线会退化成 model=<unknown>，
  // 按模型拆账直接没数据（见 cost-report.js 头注释）。上游 usage 里通常不带模型名，
  // 所以这里从请求体补（dsh / codex / cursor 都在 body.model 声明目标模型）。
  const body = { agent: agent || 'claude-proxy', raw, latencyMs };
  if (model) { body.model = model; body.requestModel = model; }
  fetch(`${url}/api/cost/report`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }).catch((e) => {
    // 全 catch（不拖累主路径），但**只警告一次** —— 静默吞掉会让"上报没生效"变成玄学。
    if (!reportWarned) {
      reportWarned = true;
      console.warn('[cost] 上报 manager 失败（不影响主路径）:', (e && e.message) || e);
    }
  });
}
let reportWarned = false;

// ===== agent 维度检测（2026-10-11，dsh 成本采集）=====
// claude-proxy 主要服务 Claude Code（UA 形如 claude-cli/2.x），同时兼容其他
// Anthropic 风格客户端；上报账本时必须能区分是谁在花钱。
// 检测优先级：
//   1. 显式 `x-agent` 请求头（接入方主动声明）
//   2. `user-agent` 头里抓客户端特征（claude / dsh / codex / cursor / hermes）
//   3. 默认 'claude-proxy'（本代理的默认身份）
function detectAgent(req) {
  const explicit = req.headers['x-agent'];
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const ua = String(req.headers['user-agent'] || '');
  if (/claude/i.test(ua)) return 'claude-code';
  if (/dsh|deepseek[-\s]harness/i.test(ua)) return 'dsh';
  if (/codex|openai/i.test(ua)) return 'codex';
  if (/cursor/i.test(ua)) return 'cursor';
  if (/hermes/i.test(ua)) return 'hermes';
  return 'claude-proxy';
}

// ===== 质量层观测 capture（flag-gated，默认关）=====
// 服务于「模型漂移 / session 切换衔接 / 多 agent 轨迹质量」的量化：只在出口抓
// 边界证据（usage + logprobs + 输出摘要 + 模型版本），**不碰训练**（铁律：不自训
// 模型），也**不落完整 prompt/response body**（与 Portico 审计「只落指针不落全文」对齐）。
// 启用：设 PROXY_TRACE_DIR 指向已存在目录；再设 PROXY_TRACE_FULL=1 才落完整 body
// （仅本机 eval 用，含敏感内容）。**不设 PROXY_TRACE_DIR ⇒ 整函数为 no-op，零行为变化。**
// 参照：HF《multi-harness RL》的 capture proxy 范式——这里只取它的「观测半边」。
// 漂移/切换衔接信号源：
//   - responseModel：上游实际返回的 model 字段（provider 静默换后端时 ≠ requestedModel，这是漂移的第一手证据）
//   - sessionId：自 `x-session-id` 头；同 session 内 resolvedModel 变了＝切换衔接问题
//   - versionLabel：PROXY_TRACE_VERSION_LABEL 打的稳版标签（如 qwen3.8-27b-mlx@2026-10-06），跨次回放比漂移用
const TRACE_DIR = process.env.PROXY_TRACE_DIR || '';
const TRACE_FULL = process.env.PROXY_TRACE_FULL === '1';
const TRACE_VERSION_LABEL = process.env.PROXY_TRACE_VERSION_LABEL || null;
let _traceWarned = false;
function captureTrace({ req, provider, rawOrObj, meta }) {
  if (!TRACE_DIR) return;
  if (meta && meta.stream) return; // 流式 = SSE 拼接文本，暂不入 trace（后续按需补）
  try {
    const isObj = typeof rawOrObj === 'object' && rawOrObj !== null;
    const text = isObj ? JSON.stringify(rawOrObj) : String(rawOrObj || '');
    let parsed = isObj ? rawOrObj : null;
    if (!parsed) { try { parsed = JSON.parse(text); } catch { parsed = null; } }

    const reqBody = req.body || {};
    const usage = parsed?.usage || null;
    let outPreview = '', outDigest = '', logprobs = null, finishReason = null;
    try {
      const choice = parsed?.choices?.[0] || null;
      const msg = choice?.message || (parsed?.output?.[0]?.content ? parsed.output[0] : null);
      const content = msg?.content ?? parsed?.content?.[0]?.text ?? '';
      if (typeof content === 'string') {
        outPreview = content.slice(0, 200);
        outDigest = require('crypto').createHash('sha256').update(content).digest('hex').slice(0, 16);
      }
      logprobs = parsed?.choices?.[0]?.logprobs ?? null;
      finishReason = parsed?.choices?.[0]?.finish_reason ?? parsed?.stop_reason ?? null;
    } catch { /* 形态不识别就跳过，不影响主路径 */ }

    const rec = {
      ts: Date.now(),
      traceId: req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent: meta?.agent,
      path: req.url,
      sessionId: req.headers['x-session-id'] || null,
      requestedModel: reqBody.model || null,
      resolvedModel: provider?.model || provider?.name || null,
      responseModel: parsed?.model || null,
      versionLabel: TRACE_VERSION_LABEL,
      provider: provider?.name || null,
      usage,
      finishReason,
      logprobs: logprobs ? JSON.stringify(logprobs).slice(0, 4000) : null,
      outPreview: TRACE_FULL ? undefined : outPreview,
      outDigest,
      body: TRACE_FULL ? text : undefined,
    };
    const fs = require('fs');
    const p = require('path').join(TRACE_DIR, `trace-${new Date().toISOString().slice(0, 10)}.jsonl`);
    // 异步落盘，不阻塞主路径
    fs.promises.appendFile(p, JSON.stringify(rec) + '\n').catch(() => {});
  } catch (e) {
    if (!_traceWarned) { _traceWarned = true; console.warn('[trace] capture 失败（不影响主路径）:', (e && e.message) || e); }
  }
}

// ===== Messages passthrough（Anthropic wire —— Claude Code / Claude Desktop）=====
// 此前 18790 只有 OpenAI 两条 wire（/v1/chat/completions、/v1/responses），Claude Code
// 发 /v1/messages 一律 404（见 docs/10-initiatives/62 号）。补上这条后 Claude 与 codex
// 共用一个出口，路由 / 成本 / 上下文控制不必再各写一套。
//
// 与 responses 那条的**本质区别**：这不是协议翻译，是**同协议直通**——
// 上游（DeepSeek / Kimi）官方都提供 Anthropic 兼容端点：
//   DeepSeek: https://api.deepseek.com/anthropic   （api-docs.deepseek.com/quick_start/agent_integrations/claude_code）
//   Kimi    : https://api.moonshot.cn/anthropic    （platform.moonshot.cn/docs/guide/claude-code-kimi）
// 所以只需换 base 路径 + 换鉴权头，请求体原样透传。
//
// ⚠️ 配置约定：Claude Code 默认发 claude-* 模型名，而 provider 匹配按模型名做，
// 因此需在 Claude Code 侧把 ANTHROPIC_MODEL 指到上游模型名（官方文档做法，
// 如 deepseek-flash / kimi-k3），否则 model 匹配不到 provider → 400 UNSUPPORTED_MODEL。

// 各厂商把「Anthropic 兼容面」挂在**不同位置**，没有通用规律 —— 2026-10-02 逐个实测
// （方法：空包看状态码 + 差分对照「不存在路径」的基线，再带认证发假 model 名避免生成 token）：
//   DeepSeek  https://api.deepseek.com/anthropic/v1/messages   → 400 model-not-found（存在）；/v1/messages 是 404
//   Kimi      https://api.moonshot.cn/anthropic/v1/messages    → 401（存在）；/v1/messages 是 404（基线同为 404）
//   Agnes     https://apihub.agnes-ai.com/v1/messages          → 401（存在）；/anthropic/... 是 403（基线同为 403）
//   Ollama    http://127.0.0.1:11434/v1/messages               → 400（存在）；/anthropic/... 是 404
// ⇒ 三级判定：① provider 显式 anthropicBaseUrl 优先（自定义上游的逃生口）
//             ② 已知「/anthropic 前缀型」厂商（deepseek / moonshot）
//             ③ 其余按根路径（agnes / ollama 已验证属此形态）
function anthropicMessagesUrl(provider) {
  const strip = (s) => String(s || '').replace(/\/+$/, '');
  if (provider.anthropicBaseUrl) return `${strip(provider.anthropicBaseUrl)}/v1/messages`;
  const base = strip(provider.baseUrl);
  if (/^https?:\/\/[^/]*(deepseek|moonshot)\./i.test(base)) {
    return `${base.replace(/\/v1$/, '')}/anthropic/v1/messages`;
  }
  return `${base}/messages`;
}

// ===== P9：Messages 协议翻译（Anthropic Messages ⇄ OpenAI ChatCompletions）=====
//   Claude Code 只说 /v1/messages；免费模型池（Kilo 匿名池等）只说 /v1/chat/completions，
//   直接透传必得上游 404。开启 provider.messagesTranslate 后走本分支：请求翻成 chat
//   发给上游，响应（含流式 SSE）翻回 Messages。默认 false = 维持原透传（零行为变更）。
const MT = require('../l2/messages-translate.js');

async function handleTranslatedMessages(req, res, provider, upstreamSignal) {
  // 顺序不能反：normalizeTools 按 t.type 白名单剔除工具（token-policy-bridge 的行规），
  // 而 Anthropic 工具是 {name, description, input_schema}、**没有 type 字段** —— 若先过
  // 规范化会被整包剔光，上游收不到任何工具定义。故先翻成 OpenAI 形态（type=function）
  // 再交给既有规范化，能力既保留、也不绕过既定门规。
  const pre = MT.messagesToChatCompletions(req.body);
  const { body } = normalizeTools(pre);
  const translated = body;
  translated.stream = !!req.body.stream;

  const upstreamUrl = `${provider.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  // 匿名免费池无 key：此时绝不能发 `Bearer undefined`（部分上游会直接 401）
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const t0 = Date.now();
  const response = await fetch(upstreamUrl, {
    method: 'POST', headers, body: JSON.stringify(translated), signal: upstreamSignal,
  });

  if (!response.ok) {
    feedCircuit(provider, classifyUpstreamStatus(response.status));
    const err = await response.text();
    console.error(`[messages-translate] upstream error (status ${response.status}): ${err.slice(0, 300)}`);
    if (!canWrite(res)) return;
    return res.status(response.status).json({ success: false, error: 'Upstream error', code: 'UPSTREAM_ERROR' });
  }
  feedCircuit(provider, 'success');

  if (!translated.stream) {
    const upstreamJson = await response.json();
    const resp = MT.chatCompletionsToMessages(upstreamJson, req.body);
    if (!canWrite(res)) return;
    res.json(resp);
    const acc = JSON.stringify(upstreamJson);
    if (!upstreamSignal.aborted) reportUsage(acc, Date.now() - t0, detectAgent(req), req.body && req.body.model);
    captureTrace({ req, provider, rawOrObj: upstreamJson, meta: { agent: 'claude-proxy', stream: false, translated: 'chat' } });
    return;
  }

  // 流式：上游 SSE 逐行解析 → Anthropic Messages SSE
  if (!canWrite(res)) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const emitter = new MT.MessagesStreamEmitter(req.body);
  const nodeStream = Readable.fromWeb(response.body);
  let buffer = '';
  let acc = '';
  let pendingUsage = null;
  let finishReason = null;
  const flushLine = (data) => {
    if (data === '[DONE]') return;
    let obj; try { obj = JSON.parse(data); } catch { return; }
    const choice = obj.choices && obj.choices[0];
    const delta = choice && choice.delta;
    if (delta && delta.content) { const s = emitter.pushText(delta.content); if (s) res.write(s); }
    if (delta && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) { const s = emitter.pushTool(tc.index, tc); if (s) res.write(s); }
    }
    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    if (obj.usage) pendingUsage = obj.usage;
  };
  try {
    for await (const chunk of nodeStream) {
      const raw = chunk.toString();
      acc += raw;
      buffer += raw;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
        const t = line.trim();
        if (t.startsWith('data:')) flushLine(t.slice(5).trim());
      }
    }
    const s = emitter.end(pendingUsage, finishReason); if (s) res.write(s);
    res.end();
    // 流走完才上报，半截 usage 不上报（与 L004 同纪律）
    if (acc && !upstreamSignal.aborted) reportUsage(acc, Date.now() - t0, detectAgent(req), req.body && req.body.model);
  } catch (e) {
    if (canWrite(res)) { try { const s = emitter.end(pendingUsage, finishReason); res.write(s); } catch { /* noop */ } res.end(); }
    console.error(`[messages-translate] stream error: ${e.message}`);
  }
}

app.post('/v1/messages', requireAuth, async (req, res) => {
  let circuitProvider = null;
  try {
    const requestedModel = req.body.model;
    const model = applyModelAlias(req.body);
    if (model !== requestedModel) console.log(`[alias] ${requestedModel} → ${model}`);
    const provider = findProvider(model);
    if (!provider) {
      return res.status(400).json({ success: false, error: `Unsupported model: ${model}`, code: 'UNSUPPORTED_MODEL' });
    }
    // P6：model-id 级路由策略（deny→400 / direct→透传 takeover 真上游 / proxy→继续）
    if (await applyRoutingPolicy(model, req, res) !== 'continue') return;
    // P7-2：预算预检（gate 关时恒 'continue'）
    if (await applyBudgetGuard(model, req, res) !== 'continue') return;
    circuitProvider = provider;
    if (!circuitAllows(provider, res)) return;

    // P9：Messages 协议翻译分支（上游只说 OpenAI 协议时，如 Kilo 匿名免费池）。
    //     门控默认关 → 下方维持原透传路径（零行为变更）。
    if (provider.messagesTranslate) {
      const upstreamSignal = createUpstreamSignal(req, res);
      await handleTranslatedMessages(req, res, provider, upstreamSignal);
      return;
    }

    const upstreamUrl = anthropicMessagesUrl(provider);
    // 鉴权：Anthropic 原生认 x-api-key；Claude Code 走 ANTHROPIC_AUTH_TOKEN 时发 Bearer。
    // 上游兼容层两者取一，故两个头同值都带上（值相同不会冲突），避免错配 401。
    // ⚠️ 本地上游（Ollama）无 key：此时**不能**发 `x-api-key: undefined`（undici 会抛
    // Invalid value），也不该把入站那份 Claude Code token 顶上去 —— 一律不带。
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
    };
    if (provider.apiKey) {
      headers['x-api-key'] = provider.apiKey;
      if (req.headers['authorization']) headers['authorization'] = `Bearer ${provider.apiKey}`;
    }

    const t0 = Date.now();
    // L004
    const upstreamSignal = createUpstreamSignal(req, res);
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: upstreamSignal,
    });

    if (!response.ok) {
      feedCircuit(provider, classifyUpstreamStatus(response.status));
      const err = await response.text();
      console.error(`[messages] upstream error (status ${response.status}): ${err.slice(0, 300)}`);
      if (!canWrite(res)) return;
      return res.status(response.status).json({ success: false, error: 'Upstream error', code: 'UPSTREAM_ERROR' });
    }
    // 流走完再上报：把攒到的字节（非流式是整份 JSON、流式是 SSE 拼接文本）原样交给
    // manager 侧的 usage-probe 归一，这里不解析、不判 wire。
    // usage 藏在流末。客户端中途断开 ⇒ 这笔账「没跑完」⇒ 不上报：
    // 半截 usage 报上去是虚账，比少报一笔更难看（L004）。
    feedCircuit(provider, 'success');
    const { outcome, acc } = await pipeUpstreamBytes(res, response, '[messages]', upstreamSignal);
    if (outcome === 'completed' && acc && !upstreamSignal.aborted) {
      reportUsage(acc, Date.now() - t0, detectAgent(req), req.body && req.body.model);
      captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'claude-proxy', stream: !!req.body.stream } });
    }
  } catch (e) {
    if (canWrite(res)) feedCircuit(circuitProvider, 'upstream');
    console.error(`[messages] error: ${e.message}`);
    if (!canWrite(res)) return;
    return res.status(500).json({ success: false, error: e.message, code: 'MESSAGES_ERROR' });
  }
});

// ===== P0-E: 可测试性 =====
//   把 app 导出，门禁测试可直接 supertest(app)，无需 require 时 listen 18790 撞端口。
module.exports = {
  app,
  requireAuth,
  findConfigToml,
  parseConfigToml,
  createUpstreamSignal, // L004：测试直接打这个函数，别再靠「镜像一份代码」的假测试
  canWrite,
  // per-provider 上游熔断（2026-10-09）：门控关时 getCircuitBreaker() 返回 null
  getCircuitBreaker: () => upstreamBreaker,
  classifyUpstreamStatus,
  // P6：model-id 级路由策略（测试可经 PROXY_ROUTING_POLICY + PROXY_ROUTING_POLICY_FILE 注入）
  loadRoutingPolicy,
  getRoutingPolicy: () => routingPolicy,
  applyRoutingPolicy,
  forwardDirect,
  ROUTING_POLICY_FILE,
  // P7-2：预算预检（测试可经 PROXY_BUDGET_GUARD + PROXY_BUDGET_SNAPSHOT_FILE + budgetCheck.setTestOverrides 注入）
  applyBudgetGuard,
  getBudgetStatus: () => budgetCheck.getStatus(),
  seedBudgetSnapshot: () => budgetCheck.seedStateFromFile(),
  budgetCheck,
  // claude-proxy 核心增量：模型别名映射（claude-* → 上游真名）
  resolveAlias,
  applyModelAlias,
  MODEL_ALIAS_PATTERNS,
  ALIAS_DISPLAY,
};

// ===== P0-B: 默认绑 127.0.0.1（仅本机）=====
//   暴露到网络前显式设 BIND_HOST=0.0.0.0；Docker 内可设 PROXY_BIND_HOST=0.0.0.0。
const BINDING = process.env.BINDING || process.env.PROXY_BIND_HOST || '127.0.0.1';
if (require.main === module) {
  const netWarn = BINDING !== '127.0.0.1' ? ' (network-exposed — set PROXY_AUTH_TOKEN!)' : '';
  app.listen(PORT, BINDING, () => {
    console.log(`Claude Multi-Model Proxy started on ${BINDING}:${PORT}${netWarn}`);
    console.log(`Config: ${CONFIG_TOML}`);
    console.log(`Models: ${UPSTREAM_MODELS.flatMap(p => p.availableModels).join(', ')}`);
    loadRoutingMode();
    loadRoutingPolicy();   // P6：门控关时是 no-op（routingPolicy 恒 null）
    budgetCheck.seedStateFromFile();   // P7-2：把磁盘快照读进内存（降级窗口可立即用；陈旧的 decide 会忽略）
   });
}
