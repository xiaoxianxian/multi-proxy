// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

const express = require('express');
const { Readable, PassThrough } = require('stream');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const keyPool = require('./key-pool.js'); // 门控 PROXY_KEYPOOL 默认关；纯函数、key 选择只读 (provider, attemptIndex, env)

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

const PORT = parseInt(process.env.PORT) || 18799;
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
      return { name: p.name, baseUrl: p.base_url, apiKey: p.api_key, availableModels: p.models, anthropicBaseUrl: p.anthropicBaseUrl, fallback: p.fallback, responsesTranslate: p.responsesTranslate, responsesTarget: p.responsesTarget };
    }
  }
  const userMatch = userProviders.find(p => p.provider_id && modelName.toLowerCase().includes(String(p.provider_id).toLowerCase()));
  if (userMatch) {
    return { name: userMatch.name, baseUrl: userMatch.base_url, apiKey: userMatch.api_key, availableModels: userMatch.models || [], anthropicBaseUrl: userMatch.anthropicBaseUrl, fallback: userMatch.fallback, responsesTranslate: userMatch.responsesTranslate, responsesTarget: userMatch.responsesTarget };
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
// 2026-10-15：通用 failover 纯函数层（bounded fallback，任何 provider 可声明 fallback 字段）
const { isRetryableFailure, buildFallbackTargets, nextFallback, MAX_FALLBACK_DEPTH } = require('./failover');
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
  // 账本记检测原值（可能是 <unknown>），takeover 查找用回落值——两者分开：
  // 归因要诚实，路由要兼容，不能为了兼容把归因也一起糊掉。
  const agent = pickTakeoverAgent(detectAgent(req));
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

// 2026-10-15：fallback 循环用 —— 只查熔断态、不写 res。
// circuitAllows 在 block 模式会直接写 503 并 return false；fallback 循环需要先「探测」OPEN
// 再决定是否切下一个，不能让 circuitAllows 提前污染 res。
// 关键：observe（默认）/门控关时恒放行（只记账不拦），与 circuitAllows 的语义一致——
// 否则 observe 模式下 breaker 一旦 OPEN 就会被误判成「硬 503」，破坏「observe 原样透传」契约
// （见 circuit-proxy.test.js ⑥）。
function breakerIsOpen(provider) {
    if (!upstreamBreaker || !provider) return false;     // 门控关：无 breaker
    if (CIRCUIT_MODE !== 'block') return false;          // observe（默认）：只记账不拦
    return !upstreamBreaker.allowRequest(provider.name);
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
  res.json(modelSync.buildModelsResponse({
    builtin: UPSTREAM_MODELS,
    userProviders,
    synced: MODEL_SYNC_ENABLED ? modelCatalog.models : [],
  }));
});

// Health check — M1 DAG 健康依赖图：分级状态 (ok/degraded/down) + 各检查项 + 原因。
// 保留 status:'healthy'（本进程存活即健康），checks/reasons 供 manager 聚合与 dashboard 展示原因。
// 向后兼容：新增字段为增量，旧调用方只读 status/uptime/models 不受影响。
function buildCodexHealthChecks() {
  const checks = { process: true, config: true, providers: true };
  const reasons = [];

  // config: 配置文件是否可读（findConfigToml 永远返回候选路径，需实测可存在）
  try {
    const cfgPath = findConfigToml();
    if (cfgPath && fs.existsSync(cfgPath)) {
      const parsed = parseConfigToml(cfgPath);
      if (!parsed || parsed.error) {
        checks.config = false;
        reasons.push('配置文件解析失败: ' + (parsed ? parsed.error : '未知'));
      }
    } else {
      // 未检测到任何配置文件，标记为降级但非致命（使用默认）
      checks.config = false;
      reasons.push('未检测到配置文件');
    }
  } catch (e) {
    checks.config = false;
    reasons.push('配置文件读取异常: ' + e.message);
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
  const { name, provider_id, api_key, base_url, enabled, models, responsesTranslate, responsesTarget } = req.body;
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
  const allowedFields = ['name', 'provider_id', 'api_key', 'base_url', 'enabled', 'models', 'responsesTranslate', 'responsesTarget'];
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

// Chat Completions passthrough (with bounded failover · 2026-10-15)
// 任何 provider 在 providers.json 声明 `fallback` 字段即启用：上游瞬态故障（网络异常/5xx/429/408/
// 熔断 OPEN）时按链切下一个，确定性 4xx 或链耗尽 → fail-loud（不静默吞）。未声明 fallback 的
// provider 行为与改造前逐字一致（单次直发、失败不切）。详见 failover.js。
app.post('/v1/chat/completions', requireAuth, async (req, res) => {
  const originalModel = req.body && req.body.model;
  if (!originalModel) {
    return res.status(400).json({ success: false, error: 'model is required', code: 'UNSUPPORTED_MODEL' });
  }
  // P6/P7-2：只对原始 model 应用一次（fallback 的是同一请求语义，不重复拦截/记账预算）
  // ── 子 agent 上下文观测（l2/subagent-detect · 门控 PROXY_SUBAGENT_DETECT，默认关）──
  // 外部对照 #71 PilotDeck（2026-10-18）：三法识别「这条请求是不是子 agent 派生的」
  //（① 消息体 <multi-proxy-subagent-model> 标签 ② tools 无派发工具反推 ③ x-main-agent: false 头）。
  // 只观测、不改写、不阻断：结果挂 req._subagent + 一行 console（debug 级）。
  // 关时热路径零开销（一次布尔）；观测失败不拖垮转发（旁路铁律同 reportUsage）。
  try {
    const subagentDetect = require('../l2/subagent-detect');
    if (subagentDetect.gateOpen()) {
      const det = subagentDetect.detectSubagent({
        messages: req.body && req.body.messages,
        tools: req.body && req.body.tools,
        isMainAgent: req.headers['x-main-agent'] !== 'false',
      });
      if (det.isSubagent) {
        req._subagent = { modelHint: det.modelHint, reasons: det.reasons };
        console.log(`[subagent] 子上下文命中（${det.reasons.join('+')}）model=${originalModel}${det.modelHint ? ` hint=${det.modelHint}` : ''}`);
      }
    }
  } catch { /* 观测失败不是转发失败 */ }
  if (await applyRoutingPolicy(originalModel, req, res) !== 'continue') return;
  if (await applyBudgetGuard(originalModel, req, res) !== 'continue') return;

  const allProviders = loadProviders().filter(p => p.enabled !== false);
  const visited = new Set([originalModel]);
  let currentModel = originalModel;
  let lastFailure = null;       // { status, code, errored, message }
  let lastProviderName = null;
  let exhausted = false;       // 是否「曾 fallback 且最终无更多目标」（链耗尽，区别于首跳无兜底）
  let fellBack = false;        // 是否曾切到过 fallback

  // key-pool（门控 PROXY_KEYPOOL 默认关）：开则同 provider 429 时换下一把 key 再试(有界)，全 key 都 429 才进 provider-fallback。
  // 关 = activeKey 恒 provider.apiKey、不轮换、零行为变更（沿用 routing-policy 门控范式）。
  const kpOpen = keyPool.gateOpen();
  const keyAttempt = kpOpen ? new Map() : null; // provider.name → 已试到第几把 key（仅门控开时有）

  for (let depth = 0; depth <= MAX_FALLBACK_DEPTH; depth++) {
    const provider = findProvider(currentModel);
    if (!provider) {
      lastFailure = { status: 400, code: 'UNSUPPORTED_MODEL', errored: false };
      break;
    }
    lastProviderName = provider.name;

    // key-pool：门控关 → keyIdx=0、activeKey=provider.apiKey（老行为逐字不变）；开 → 试到第几把 key
    const keyIdx = keyAttempt ? (keyAttempt.get(provider.name) || 0) : 0;
    const activeKey = keyPool.activeKey(provider, keyIdx); // 门控关 → 恒 provider.apiKey

    // 熔断 OPEN：当作「需重试」信号，不硬 503，进入 fallback 决策（除非无 fallback）
    if (!breakerIsOpen(provider)) {
      const bodyForUpstream = { ...req.body, model: currentModel };
      const t0 = Date.now();
      const upstreamUrl = `${provider.baseUrl}/chat/completions`;
      const upstreamSignal = createUpstreamSignal(req, res);
      try {
        const response = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeKey}`,
          },
          body: JSON.stringify(bodyForUpstream),
          signal: upstreamSignal,
        });

        if (response.ok) {
          feedCircuit(provider, 'success');
          // === commit：一旦 2xx 立即落定，不再 fallback（SSE 已推回不去）===
          if (bodyForUpstream.stream) {
            const { outcome, acc } = await pipeUpstreamBytes(res, response, '[chat]', upstreamSignal);
            if (outcome === 'completed' && acc && !upstreamSignal.aborted) {
              captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'generic-openai-proxy', stream: true } });
              reportUsage(acc, Date.now() - t0, detectAgent(req), currentModel, originalModel);
            }
          } else {
            const data = await response.json();
            captureTrace({ req, provider, rawOrObj: data, meta: { agent: 'generic-openai-proxy', stream: false } });
            res.json(data);
            reportUsage(JSON.stringify(data), Date.now() - t0, detectAgent(req), currentModel, originalModel);
            // ── context-breakdown 观测（门控 PROXY_CONTEXT_TRACK 默认关 = 零开销；口径 docs/context-breakdown-口径.md）──
            // 旁路铁律同 reportUsage：全 catch、不拖主路径。只报计数，不报正文。
            try {
              require('../l2/context-report').observe({
                agent: 'generic-openai-proxy',
                reqId: null,
                model: currentModel,
                requestModel: req.body && req.body.model,
                clientKey: detectAgent(req),
                request: req.body,
                actuals: (data && data.usage) || null,
              });
            } catch { /* 观测失败不是转发失败 */ }
          }
          return;
        }

        // 非 2xx：记熔断（瞬态/确定分类），确定性 4xx → 不 fallback，fail-loud
        feedCircuit(provider, classifyUpstreamStatus(response.status));
        const err = await response.text();
        console.error(`[chat] upstream error (status ${response.status}) on model=${currentModel}: ${err.slice(0, 300)}`);
        if (!isRetryableFailure({ status: response.status })) {
          if (!canWrite(res)) return;
          return res.status(response.status).json({
            success: false, error: 'Upstream error', code: 'UPSTREAM_ERROR', attempted: currentModel,
          });
        }
        lastFailure = { status: response.status, code: 'UPSTREAM_ERROR', errored: false };
      } catch (e) {
        // 网络异常/超时/连接失败：瞬态，可切
        feedCircuit(provider, 'upstream');
        console.error(`[chat] fetch error on model=${currentModel}: ${e.message}`);
        lastFailure = { status: 500, code: 'CHAT_ERROR', errored: true, message: e.message };
      }
    } else {
      // 熔断 OPEN：记失败态，进入 fallback 决策（breaker 自身已判定，不重复 record）
      console.error(`[chat] circuit open on model=${currentModel} (${provider.name}) — trying fallback`);
      lastFailure = { status: 503, code: 'CIRCUIT_OPEN', errored: false };
    }

    // key-pool：429(限流) + 门控开 + 还有下一把 key ⇒ 同 provider 换 key 再试(有界)，不急着进 provider-fallback。
    // 门控关(kpOpen=false) → 条件恒假 → 走 provider-fallback，与老行为逐字一致（零变更）。
    if (lastFailure && lastFailure.status === 429 && kpOpen && keyPool.hasNextKey(provider, keyIdx)) {
      keyAttempt.set(provider.name, keyIdx + 1);
      continue; // 重回循环：同 provider、下一把 key（depth 仍受 MAX_FALLBACK_DEPTH 限）
    }

    // === fallback 决策：取下一个未访问的候选 model ===
    const next = nextFallback(currentModel, visited, provider, allProviders);
    if (!next) {
      // 当前 provider 无兜底目标：若从未切过（首跳就无兜底）→ 原样透传上游状态码；
      // 若已切过（链走到头）→ 标记链耗尽。两种都不伪装成 502 误报。
      if (fellBack) exhausted = true;
      break;
    }
    visited.add(next);
    currentModel = next;
    fellBack = true;
  }

  if (!canWrite(res)) return;
  // 模型无处路由（无 provider）且首跳 → 400（与改造前一致）
  if (lastFailure && lastFailure.status === 400 && !fellBack) {
    return res.status(400).json({ success: false, error: `Unsupported model: ${currentModel}`, code: 'UNSUPPORTED_MODEL' });
  }
  const label = lastProviderName || currentModel;
  if (exhausted) {
    // 兜底耗尽：primary + 所有 fallback 都试过仍失败（或全链熔断 OPEN）。明确 502/503。
    const finalCode = (lastFailure && lastFailure.code === 'CIRCUIT_OPEN') ? 'CIRCUIT_OPEN' : 'FALLBACK_EXHAUSTED';
    const finalStatus = (lastFailure && lastFailure.code === 'CIRCUIT_OPEN') ? 503 : 502;
    return res.status(finalStatus).json({
      success: false,
      error: `All fallback targets exhausted (last attempted: ${label})`,
      code: finalCode,
    });
  }
  // 首跳无兜底（provider 没声明 fallback）：原样透传上游状态码（保持老行为，重试性错误也不伪装成 502）
  const status = lastFailure ? lastFailure.status : 502;
  const code = lastFailure ? lastFailure.code : 'UPSTREAM_ERROR';
  const msg = (lastFailure && lastFailure.message) || 'Upstream error';
  return res.status(status).json({ success: false, error: msg, code });
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
    captureTrace({ req, provider, rawOrObj: upstreamJson, meta: { agent: 'generic-openai-proxy', stream: false, translated: target } });
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
      captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'generic-openai-proxy', stream: !!req.body.stream } });
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
function reportUsage(raw, latencyMs, agent, model, requestedModel) {
  if (!raw || typeof raw !== 'string') return;
  const url = String(process.env.MANAGER_URL || 'http://127.0.0.1:18792').replace(/\/$/, '');
  // 写端点不 fail-open：没 token 就不报，宁可少一笔账也不让陌生人灌假成本。
  // manager 侧 lib/auth.js 的 requireAgentAuth 认这个头；MANAGER_AGENT_TOKEN 由
  // manager 注入自身 env → spawnProxy 的 { ...process.env } 自动带进来（开盒即用）。
  const agentToken = process.env.MANAGER_AGENT_TOKEN || process.env.PROXY_AUTH_TOKEN;
  const headers = { 'content-type': 'application/json' };
  if (agentToken) headers['x-agent-token'] = agentToken;
  // 上游 usage 里通常不带模型名，所以这里从请求体/路由结果补。
  //
  // 🔴 model 与 requestModel 必须是**两个不同的值**（2026-10-16 修）：
  //   本文件的 /v1/chat/completions 有 fallback 链（currentModel 会被 nextFallback 改写），
  //   此前把 currentModel 同时塞进 model 和 requestModel，等于把「宿主要的是哪个模型」
  //   这条信息扔了 —— 账本里两个字段永远相同，「如果不重写会花多少」的对比因此恒等于
  //   实际花费，「已省金额」结构性算不出来（永远 0 或 null）。
  //   cost-track 当初做这两个字段就是为了回答这个问题，接线却把它抵消了。
  // 只传一个值时退回原行为（两者同值）—— /v1/messages 那条是真直通，本就该同值。
  // agent 兜底用哨兵值而非代理名（2026-10-16）：调用方没给 agent 就是「不知道」，
  // 记成代理名会让账本多出一个不存在的花钱方。
  const body = { agent: agent || UNKNOWN_AGENT, raw, latencyMs };
  if (model || requestedModel) {
    body.model = model || requestedModel;
    body.requestModel = requestedModel || model;
  }
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

// ===== agent 维度检测（2026-10-14，P2 通用 OpenAI 兼容网关）=====
// generic-openai-proxy 是「一个适配器覆盖 Cline / Aider / OpenHands 三件套」的落地：
// 三家 LLM 配置方式完全一致（base_url + api_key + model），共用本网关（端口 18799）。
// 上报账本时必须能区分是谁在花钱，否则「省钱效果」无法按客户端归因。
// 检测优先级：
//   1. 显式 `x-agent` 请求头（接入方主动声明，如客户端插件在状态栏上报）
//   2. `PROXY_AGENT_UA_MAP` 里登记的 UA 特征（部署侧自配，见下）
//   3. 内置 `user-agent` 特征表（cline / aider / openhands / opencode / dsh / codex / cursor / hermes）
//   4. '<unknown>' —— 与 lib/cost-track.js 的哨兵值同串
//
// 🔴 2026-10-16：第 4 步从 'generic-openai-proxy' 改成 '<unknown>'。
//    本代理覆盖十几种客户端，兜底成代理名等于把「不知道是哪个客户端在花钱」
//    伪装成「网关自己的流量」——归因错了比归因缺失更难看：
//      · 一个不存在的 agent 长期占据账单首位，读者会以为网关自己在烧钱；
//      · 真正该被点名的接入方（补一个 x-agent 头就能被统计）永远发现不了自己没被算进去。
//    这正是 multi-proxy 自己的 unknown 态对账纪律：不知道就说不知道，不拿猜测填。
//    ⚠️ 行为兼容：forwardDirect 的 takeover 查找已加回落（见 pickTakeoverAgent），
//       direct 行为不变；历史账本里的 'generic-openai-proxy' 行不改写（账本冻结）。
//
// 可配置覆盖 PROXY_AGENT_UA_MAP（JSON 数组，按顺序先中先得）：
//   [{"match":"myclient","agent":"my-client"}]
// 用途：接入方不方便加 x-agent 头时，在这里登记一次即可，不用改代码、不用重启逻辑。
const UNKNOWN_AGENT = '<unknown>';
let _uaMapCache = null;
function loadUaMap() {
  if (_uaMapCache !== null) return _uaMapCache;
  const raw = process.env.PROXY_AGENT_UA_MAP;
  if (!raw || !raw.trim()) { _uaMapCache = []; return _uaMapCache; }
  try {
    const parsed = JSON.parse(raw);
    _uaMapCache = Array.isArray(parsed)
      ? parsed.filter(m => m && typeof m.match === 'string' && typeof m.agent === 'string')
      : [];
    if (_uaMapCache.length === 0 && parsed) {
      console.warn('[agent] PROXY_AGENT_UA_MAP 解析成功但没有有效条目（需要 {match, agent}），已忽略');
    }
  } catch (e) {
    // 配置坏 → 明确警告一次后按「没配」处理。绝不静默：静默会让接入方以为登记生效了。
    console.warn('[agent] PROXY_AGENT_UA_MAP 不是合法 JSON，已忽略：' + e.message);
    _uaMapCache = [];
  }
  return _uaMapCache;
}
function detectAgent(req) {
  const explicit = req.headers['x-agent'];
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const ua = String(req.headers['user-agent'] || '');
  const lua = ua.toLowerCase();
  const configured = loadUaMap();
  for (let i = 0; i < configured.length; i++) {
    if (lua.indexOf(configured[i].match.toLowerCase()) !== -1) return configured[i].agent;
  }
  if (/cline/i.test(ua)) return 'cline';
  if (/aider/i.test(ua)) return 'aider';
  if (/openhands/i.test(ua)) return 'openhands';
  if (/opencode/i.test(ua)) return 'opencode';
  if (/dsh|deepseek[-\s]harness/i.test(ua)) return 'dsh';
  if (/codex/i.test(ua)) return 'codex';
  if (/cursor/i.test(ua)) return 'cursor';
  if (/hermes/i.test(ua)) return 'hermes';
  // /openai/i 故意放在 codex 之后且单独一条：openai-node / openai-python 这些官方库
  // 的 UA 会被各种客户端带上，命中它只说明「用的 openai 官方 SDK」，不说明是 codex。
  // 但它仍然比 unknown 更接近事实，故保留，仅不再与 codex 合并（合并时 codex 会被误判）。
  if (/openai/i.test(ua)) return 'openai-sdk';
  return UNKNOWN_AGENT;
}

// takeover 文件名按「检测到的 agent」找。检测不出时回落到本代理名——
// 这样老部署里已存在的 takeover-generic-openai-proxy.json 照旧命中，
// 2026-10-16 改 detectAgent 兜底值不会让 direct 路由悄悄失效。
function pickTakeoverAgent(detected) {
  if (detected !== UNKNOWN_AGENT) return detected;
  const asUnknown = path.join(DATA_DIR, 'takeover-' + UNKNOWN_AGENT + '.json');
  if (fs.existsSync(asUnknown)) return UNKNOWN_AGENT;
  return 'generic-openai-proxy';
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

app.post('/v1/messages', requireAuth, async (req, res) => {
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
      captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'generic-openai-proxy', stream: !!req.body.stream } });
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
  // agent 归因（2026-10-16 兜底值从代理名改成 <unknown>，与 cost-track 哨兵同串）：
  // 导出供单测钉死「猜不到就说不知道」，以及 PROXY_AGENT_UA_MAP 的解析与回落。
  detectAgent,
  pickTakeoverAgent,
  UNKNOWN_AGENT,
  budgetCheck,
};

// ===== P0-B: 默认绑 127.0.0.1（仅本机）=====
//   暴露到网络前显式设 BIND_HOST=0.0.0.0；Docker 内可设 PROXY_BIND_HOST=0.0.0.0。
const BINDING = process.env.BINDING || process.env.PROXY_BIND_HOST || '127.0.0.1';
if (require.main === module) {
  const netWarn = BINDING !== '127.0.0.1' ? ' (network-exposed — set PROXY_AUTH_TOKEN!)' : '';
  app.listen(PORT, BINDING, () => {
    console.log(`Generic OpenAI-Compatible Proxy started on ${BINDING}:${PORT}${netWarn}`);
    console.log(`Config: ${CONFIG_TOML}`);
    console.log(`Models: ${UPSTREAM_MODELS.flatMap(p => p.availableModels).join(', ')}`);
    loadRoutingMode();
    loadRoutingPolicy();   // P6：门控关时是 no-op（routingPolicy 恒 null）
    budgetCheck.seedStateFromFile();   // P7-2：把磁盘快照读进内存（降级窗口可立即用；陈旧的 decide 会忽略）
   });
}
