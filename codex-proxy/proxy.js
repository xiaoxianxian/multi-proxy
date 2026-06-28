const express = require('express');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

console.log = (...args) => {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${args.join(' ')}\n`);
};

const PORT = parseInt(process.env.PORT) || 18790;
const HOME = process.env.HOME || path.join(require('os').homedir());

// ===== Config file detection =====
const ROUTING_MODE_FILE = path.join(HOME, '.codex-proxy', 'routing-mode.json');

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
    const dir = path.dirname(ROUTING_MODE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
const UPSTREAM_MODELS = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY,
    availableModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: process.env.MOONSHOT_API_KEY,
    availableModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'moonshot-v1-128k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-8k-vision-preview', 'moonshot-v1-auto']
  },
  {
    name: 'Agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: process.env.AGNES_API_KEY,
    availableModels: ['agnes-2.0-flash', 'agnes-1.5-flash', 'agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-video-v2.0']
  }
];

function findProvider(modelName) {
  if (!modelName) return null;
  let provider = UPSTREAM_MODELS.find(p => p.availableModels.includes(modelName));
  if (provider) return provider;
  const lower = modelName.toLowerCase();
  if (lower.includes('deepseek')) return UPSTREAM_MODELS[0];
  if (lower.includes('kimi') || lower.includes('moonshot')) return UPSTREAM_MODELS[1];
  if (lower.includes('agnes')) return UPSTREAM_MODELS[2];
  return null;
}

// ===== API Routes =====

// Models list
app.get('/v1/models', (req, res) => {
  const models = UPSTREAM_MODELS.flatMap(p =>
    p.availableModels.map(name => ({
      id: name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: p.name
    }))
  );
  res.json({ object: 'list', data: models });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    models: UPSTREAM_MODELS.flatMap(p => p.availableModels)
  });
});

// Admin API routes
app.get('/api/config', (req, res) => {
  const configTomlPath = findConfigToml();
  const config = parseConfigToml(configTomlPath);
  config.path = configTomlPath;
  res.json(config);
});

app.get('/api/routing-mode', (req, res) => {
  loadRoutingMode();
  res.json({ mode: routingMode });
});

app.post('/api/set-routing-mode', (req, res) => {
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

app.get('/api/providers/status', (req, res) => {
  const providers = UPSTREAM_MODELS.map(p => ({
    name: p.name,
    baseUrl: p.baseUrl,
    status: p.apiKey ? 'online' : 'offline',
    models: p.availableModels
  }));
  res.json({ providers });
});

app.get('/api/balances', async (req, res) => {
  const balances = {};
  for (const provider of UPSTREAM_MODELS) {
    if (!provider.apiKey) { balances[provider.name] = '未配置'; continue; }
    try {
      let url;
      if (provider.name === 'DeepSeek') url = `${provider.baseUrl}/user/info`;
      else if (provider.name === 'Kimi') url = `${provider.baseUrl}/user/info`;
      else if (provider.name === 'Agnes') url = `${provider.baseUrl}/user/balance`;
      else { balances[provider.name] = '不支持'; continue; }

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` }
      });
      if (response.ok) {
        const data = await response.json();
        balances[provider.name] = data.balance || data.amount || '未知';
      } else {
        balances[provider.name] = '查询失败';
      }
    } catch (e) {
      balances[provider.name] = '错误';
    }
  }
  res.json({ balances });
});

// Switch history (in-memory)
const switchHistory = [];
const MAX_HISTORY = 50;

app.get('/api/history', (req, res) => {
  res.json({ history: switchHistory.slice(0, 20).reverse() });
});

app.post('/api/switch-model', (req, res) => {
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

app.post('/api/test-connection', async (req, res) => {
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

app.post('/api/clear-history', (req, res) => {
  switchHistory.length = 0;
  res.json({ success: true });
});

function addHistory(action, from, to, mode, success) {
  switchHistory.push({ timestamp: Date.now(), action, from, to, mode, success });
  if (switchHistory.length > MAX_HISTORY) switchHistory.shift();
}

// Chat Completions passthrough
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model } = req.body;
    const provider = findProvider(model);
    if (!provider) {
      return res.status(400).json({ success: false, error: `Unsupported model: ${model}`, code: 'UNSUPPORTED_MODEL' });
    }

    const upstreamUrl = `${provider.baseUrl}/chat/completions`;
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Chat upstream error: ${err}`);
      return res.status(response.status).json({ success: false, error: err, code: 'UPSTREAM_ERROR' });
    }

    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      try {
        await response.body.pipeTo(res);
      } catch (err) {
        console.error(`[Stream] Pipe error: ${err.message}`);
        if (!res.headersSent) {
          res.status(504).json({ success: false, error: 'Stream timeout or upstream disconnected', code: 'STREAM_TIMEOUT' });
        }
      }
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (e) {
    console.error(`Chat error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message, code: 'CHAT_ERROR' });
  }
});

// Listen
app.listen(PORT, () => {
  console.log(`Codex Multi-Model Proxy started on port ${PORT}`);
  console.log(`Config: ${CONFIG_TOML}`);
  console.log(`Models: ${UPSTREAM_MODELS.flatMap(p => p.availableModels).join(', ')}`);
  loadRoutingMode();
});
