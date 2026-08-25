// ==================== 路由：供应商 API（test-connection / fetch-models / balances / 转发白名单） ====================
const express = require('express');
const axios = require('axios');

const { requireAuth } = require('../lib/auth');
const { appendLog } = require('../lib/logger');
const pm = require('../lib/process-manager');
const {
  classifyUpstreamError,
  normalizeModels,
  isAllowedEndpoint,
  forwardProxy,
} = require('../lib/forward');

const router = express.Router();

// ==================== 连通性测试 (MUST be before proxy wildcard) ====================
router.post('/test-connection', requireAuth, async (req, res) => {
  // 参数名统一（交接遗留项）：providerId = 供应商类型，与 /api/fetch-models 一致；
  // 兼容旧参数名 model。
  var providerId = req.body.providerId || req.body.model || '';
  var apiKey = req.body.apiKey;
  var baseUrl = req.body.baseUrl;
  if (!baseUrl || !providerId) {
    return res.status(400).json({ success: false, error: 'Missing baseUrl or provider type' });
  }
  baseUrl = (baseUrl || '').replace(/\/$/, '');
  // For OpenAI-compatible providers, strip /v1 from baseUrl if present
  const baseApiUrl = baseUrl.replace(/\/v1\/?$/, '');
  try {
    var providerLower = providerId.toLowerCase();
    var testUrl, testMethod, testHeaders;

    if (providerLower === 'anthropic') {
      testUrl = baseApiUrl + '/v1/messages';
      testMethod = 'post';
      testHeaders = { 'Content-Type': 'application/json', 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' };
      var postData = { model: 'claude-sonnet-4-20250514', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
    } else if (providerLower === 'google' || providerLower === 'google-gemini') {
      testUrl = baseApiUrl + '/v1/models?key=' + (apiKey || '');
      testMethod = 'get';
      testHeaders = { 'Content-Type': 'application/json' };
    } else if (providerLower === 'ollama') {
      testUrl = baseApiUrl + '/api/tags';
      testMethod = 'get';
      testHeaders = { 'Content-Type': 'application/json' };
    } else {
      // OpenAI, Azure, and OpenAI-compatible
      testUrl = baseApiUrl + '/v1/models';
      testMethod = 'get';
      testHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (apiKey || '') };
    }

    var axiosConfig = {
      url: testUrl,
      method: testMethod,
      headers: testHeaders,
      timeout: 10000,
    };
    if (testMethod === 'post') {
      axiosConfig.data = postData || {};
    }

    var resp = await axios(axiosConfig);
    res.json({ success: true, message: '连通成功' });
  } catch (err) {
    const c = classifyUpstreamError(err);
    appendLog('warn', 'test-connection', 'Connection test failed: ' + err.message);
    res.status(c.status).json({ success: false, error: c.error });
  }
});

// ==================== 模型列表获取 (MUST be before proxy wildcard) ====================
router.post('/fetch-models', requireAuth, async (req, res) => {
  var providerId = (req.body.providerId || '').toLowerCase();
  var apiKey = req.body.apiKey || '';
  var baseUrl = (req.body.baseUrl || '').replace(/\/$/, '');
  // Strip /v1 suffix if present to avoid double /v1 in constructed URLs
  baseUrl = baseUrl.replace(/\/v1$/, '');

  if (!apiKey) {
    return res.status(400).json({ success: false, error: 'API Key 不能为空' });
  }

  var url, headers, format;

  if (providerId === 'openai-compatible' || providerId === 'openai' || providerId === 'azure' || providerId === 'deepseek') {
    url = baseUrl + '/v1/models';
    headers = { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
    format = 'openai';
  } else if (providerId === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages/models';
    headers = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    format = 'anthropic';
  } else if (providerId === 'google' || providerId === 'google-gemini') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;
    headers = { 'Content-Type': 'application/json' };
    format = 'gemini';
  } else if (providerId === 'ollama') {
    url = baseUrl + '/api/tags';
    headers = { 'Content-Type': 'application/json' };
    format = 'ollama';
  } else {
    return res.status(400).json({ success: false, error: '不支持的供应商类型: ' + providerId });
  }

  try {
    var response = await axios.get(url, { headers, timeout: 10000 });
    var data = response.data;
    var rawModels = [];

    if (format === 'openai' && Array.isArray(data.data)) {
      rawModels = data.data;
    } else if (format === 'anthropic' && Array.isArray(data.data)) {
      rawModels = data.data;
    } else if (format === 'gemini' && Array.isArray(data.models)) {
      rawModels = data.models;
    } else if (format === 'ollama' && Array.isArray(data.models)) {
      rawModels = data.models;
    }

    var models = normalizeModels(rawModels, format);
    res.json({ success: true, models: models });
  } catch (err) {
    const c = classifyUpstreamError(err);
    appendLog('warn', 'fetch-models', 'Failed to fetch models: ' + err.message);
    res.status(c.status).json({ success: false, error: c.error });
  }
});

// Proxy-specific API paths
const PROXY_API_PATHS = {
  codex: '/api',
  hermes: '/api',
  cursor: '/admin-api',
};

// ==================== 余额查询 (MUST be before proxy wildcard) ====================
router.get('/balances', requireAuth, async (req, res) => {
  const proxyName = req.query.proxy || 'codex';
  const config = pm.getProxyConfigs()[proxyName];
  if (!config) {
    return res.status(404).json({ success: false, error: 'Unknown proxy' });
  }
  const path = PROXY_API_PATHS[proxyName] + '/balances';
  const data = await pm.fetchProxyApi(proxyName, path, 'GET');
  if (data) {
    // Normalize: convert { balances: { name: value } } to array format the frontend expects
    if (data.balances && typeof data.balances === 'object') {
      const arr = Object.entries(data.balances).map(([name, amount]) => {
        const numAmount = typeof amount === 'number' ? amount : parseFloat(amount);
        return {
          name,
          amount: isNaN(numAmount) ? (typeof amount === 'string' ? amount : 0) : numAmount,
          currency: 'USD',
        };
      });
      return res.json(arr);
    }
    res.json(data);
  } else {
    res.json([]);
  }
});

// ==================== Provider enable API (MUST be before proxy wildcard) ====================
router.put('/providers/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const proxyName = req.body._proxy;
  const data = await pm.fetchProxyApi(proxyName, '/api/providers/' + id, 'PUT', req.body);
  if (data) {
    res.json(data);
  } else {
    res.status(502).json({ success: false, error: 'Provider service unreachable' });
  }
});

// Forward proxy wildcard — catches all /api/{proxy_name}/{rest} paths
// Registered AFTER all /api/fetch-models, /api/balances, /api/test-connection
router.all('/:proxy/*', requireAuth, (req, res, next) => {
  const proxy = req.params.proxy;
  const path = '/' + req.params[0];
  const method = req.method;

  if (isAllowedEndpoint(proxy, method, path)) {
    forwardProxy(req, res);
  } else {
    console.log(`[WHITELIST] Blocked ${method} ${proxy}/${path}`);
    res.status(404).json({ success: false, error: 'Not found' });
  }
});

module.exports = router;
