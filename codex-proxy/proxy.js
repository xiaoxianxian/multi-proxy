// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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

const PORT = parseInt(process.env.PORT) || 18790;
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
      return { name: p.name, baseUrl: p.base_url, apiKey: p.api_key, availableModels: p.models, anthropicBaseUrl: p.anthropicBaseUrl };
    }
  }
  const userMatch = userProviders.find(p => p.provider_id && modelName.toLowerCase().includes(String(p.provider_id).toLowerCase()));
  if (userMatch) {
    return { name: userMatch.name, baseUrl: userMatch.base_url, apiKey: userMatch.api_key, availableModels: userMatch.models || [], anthropicBaseUrl: userMatch.anthropicBaseUrl };
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

function generateId() {
  return 'prov_' + Date.now().toString(36).padStart(9, '0') + '_' + Math.random().toString(36).substring(2, 8);
}

// ===== API Routes =====

// Models list
app.get('/v1/models', requireAuth, (req, res) => {
  const builtin = UPSTREAM_MODELS.flatMap(p =>
    p.availableModels.map(name => ({
      id: name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: p.name
    }))
  );
  // Merge in models of user-defined providers (Web UI CRUD)
  const userModelIds = new Set(builtin.map(m => m.id));
  const userModels = loadProviders().filter(p => p.enabled !== false && Array.isArray(p.models))
    .flatMap(p => p.models
      .filter(name => !userModelIds.has(name))
      .map(name => ({ id: name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: p.name })));
  res.json({ object: 'list', data: builtin.concat(userModels) });
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
  const { name, provider_id, api_key, base_url, enabled, models } = req.body;
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
  const allowedFields = ['name', 'provider_id', 'api_key', 'base_url', 'enabled', 'models'];
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
    const { model } = req.body;
    const provider = findProvider(model);
    if (!provider) {
      return res.status(400).json({ success: false, error: `Unsupported model: ${model}`, code: 'UNSUPPORTED_MODEL' });
    }
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
        captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'codex-proxy', stream: true } });
        reportUsage(acc, Date.now() - t0, detectAgent(req), req.body && req.body.model);
      }
    } else {
      const data = await response.json();
      captureTrace({ req, provider, rawOrObj: data, meta: { agent: 'codex-proxy', stream: false } });
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

app.post('/v1/responses', requireAuth, async (req, res) => {
  let circuitProvider = null;
  try {
    const { model } = req.body;
    const provider = findProvider(model);
    if (!provider) {
      return res.status(400).json({ success: false, error: `Unsupported model: ${model}`, code: 'UNSUPPORTED_MODEL' });
    }
    circuitProvider = provider;
    if (!circuitAllows(provider, res)) return;

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
      captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'codex-proxy', stream: !!req.body.stream } });
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
  const body = { agent: agent || 'codex-proxy', raw, latencyMs };
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
// codex-proxy 同时服务多个客户端（dsh / codex / cursor / hermes...），
// 上报账本时必须能区分是谁在花钱，否则「省钱效果」无法按客户端归因。
// 检测优先级：
//   1. 显式 `x-agent` 请求头（接入方主动声明，如 dsh 插件在状态栏上报）
//   2. `user-agent` 头里抓客户端特征（dsh / codex / cursor / hermes）
//   3. 默认 'codex-proxy'（保持向后兼容，老客户端不带头也照旧）
function detectAgent(req) {
  const explicit = req.headers['x-agent'];
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const ua = String(req.headers['user-agent'] || '');
  if (/dsh|deepseek[-\s]harness/i.test(ua)) return 'dsh';
  if (/codex|openai/i.test(ua)) return 'codex';
  if (/cursor/i.test(ua)) return 'cursor';
  if (/hermes/i.test(ua)) return 'hermes';
  return 'codex-proxy';
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
      captureTrace({ req, provider, rawOrObj: acc, meta: { agent: 'codex-proxy', stream: !!req.body.stream } });
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
};

// ===== P0-B: 默认绑 127.0.0.1（仅本机）=====
//   暴露到网络前显式设 BIND_HOST=0.0.0.0；Docker 内可设 PROXY_BIND_HOST=0.0.0.0。
const BINDING = process.env.BINDING || process.env.PROXY_BIND_HOST || '127.0.0.1';
if (require.main === module) {
  const netWarn = BINDING !== '127.0.0.1' ? ' (network-exposed — set PROXY_AUTH_TOKEN!)' : '';
  app.listen(PORT, BINDING, () => {
    console.log(`Codex Multi-Model Proxy started on ${BINDING}:${PORT}${netWarn}`);
    console.log(`Config: ${CONFIG_TOML}`);
    console.log(`Models: ${UPSTREAM_MODELS.flatMap(p => p.availableModels).join(', ')}`);
    loadRoutingMode();
   });
}
