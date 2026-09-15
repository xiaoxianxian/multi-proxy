// ==================== 供应商 API 转发辅助（fetch-models / test-connection / forward 白名单） ====================
const axios = require('axios');
const { appendLog } = require('./logger');

/**
 * 把上游请求错误分类成用户可读文案。
 * 区分：认证失败(401/403) / 端点不存在(404) / 网络不通 / 其它，
 * 避免把「密钥错误」误报成「无法连接」（交接文档遗留体验问题）。
 */
function classifyUpstreamError(err) {
  const status = err && err.response && err.response.status;
  if (status === 401 || status === 403) {
    return { status: 401, error: `认证失败（HTTP ${status}）：API Key 无效或无权限，请检查密钥` };
  }
  if (status === 404) {
    return { status: 404, error: '端点不存在（HTTP 404）：请检查 Base URL 是否正确' };
  }
  if (status) {
    return { status: 502, error: `供应商返回错误（HTTP ${status}）` };
  }
  // 无 response —— 网络层失败（DNS/超时/拒绝连接等）
  return { status: 502, error: '无法连接到供应商 API，请检查网络和地址（' + ((err && err.code) || err.message || '未知错误') + '）' };
}

/** Normalize raw provider response to canonical {id, name, displayName} */
function normalizeModels(rawModels, format) {
  const list = [];
  if (format === 'openai') {
    for (let i = 0; i < rawModels.length; i++) {
      const m = rawModels[i];
      list.push({ id: m.id, name: m.id, displayName: m.id });
    }
  } else if (format === 'anthropic') {
    for (let i = 0; i < rawModels.length; i++) {
      const m = rawModels[i];
      list.push({ id: m.identifier, name: m.identifier, displayName: m.name || m.identifier });
    }
  } else if (format === 'gemini') {
    for (let i = 0; i < rawModels.length; i++) {
      const m = rawModels[i];
      const id = m.name.replace('models/', '');
      const displayName = m.displayName || id;
      list.push({ id: id, name: id, displayName: displayName });
    }
  } else if (format === 'ollama') {
    for (let i = 0; i < rawModels.length; i++) {
      const m = rawModels[i];
      list.push({ id: m.name, name: m.name, displayName: m.name });
    }
  }
  return list;
}

// Forward proxy whitelist - only allow known endpoints
const FORWARD_ENDPOINTS = {
  codex: {
    GET: ['/v1/models', '/health', '/api/config', '/api/routing-mode', '/api/providers', '/api/providers/status', '/api/balances', '/api/history', '/api/test-connection', '/api/settings'],
    POST: ['/v1/chat/completions', '/api/set-routing-mode', '/api/switch-model', '/api/clear-history', '/api/providers'],
    PUT: ['/api/providers/:id', '/api/settings'],
    DELETE: ['/api/providers/:id'],
  },
  hermes: {
    GET: ['/v1/models', '/health', '/api/config', '/api/routing-mode', '/api/providers', '/api/providers/status', '/api/balances', '/api/history', '/api/test-connection'],
    POST: ['/v1/chat/completions', '/api/set-routing-mode', '/api/switch-model', '/api/clear-history', '/api/providers'],
    PUT: ['/api/providers/:id'],
    DELETE: ['/api/providers/:id'],
  },
  cursor: {
    GET: ['/v1/models', '/health', '/v1/chat/completions', '/admin-api/providers', '/admin-api/models', '/admin-api/routes', '/admin-api/logs', '/admin-api/health', '/admin-api/settings', '/admin-api/balances'],
    POST: ['/v1/chat/completions', '/admin-api/providers', '/admin-api/models', '/admin-api/routes', '/admin-api/settings'],
    PUT: ['/admin-api/providers/:id', '/admin-api/settings'],
    DELETE: ['/admin-api/providers/:id', '/admin-api/models/:id'],
  },
};

function isAllowedEndpoint(proxy, method, path) {
  const config = FORWARD_ENDPOINTS[proxy];
  if (!config) return false;
  const allowed = config[method.toUpperCase()];
  if (!allowed) return false;
  // Match wildcard params like :id
  for (const pattern of allowed) {
    if (pattern === path) return true;
    // Simple wildcard match for :param patterns
    const patternParts = pattern.split('/');
    const pathParts = path.split('/');
    if (patternParts.length !== pathParts.length) continue;
    let match = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        // Strict validation for :id parameters – only allow UUID or alphanumeric
        const idParam = patternParts[i].substring(1);
        if (idParam === 'id') {
          // Strict validation: UUID (36-char hex-with-dashes), numeric, or short alphanumeric
          const seg = pathParts[i];
          const isUUID   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg);
          const isNumeric = /^\d{1,10}$/.test(seg);
          const isGeneric = /^[a-zA-Z0-9_-]{1,32}$/.test(seg);
          if (!isUUID && !isNumeric && !isGeneric) {
            match = false;
            break;
          }
        }
        continue; // param placeholder – already validated above
      }
      if (patternParts[i] !== pathParts[i]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

/**
 * 转发 API 请求到代理（通用）。依赖 req.app.locals 中的共享状态：
 * getProxyConfigs / IS_DOCKER / DOCKER_SERVICE_NAMES 由 process-manager 提供。
 */
async function forwardProxy(req, res) {
  const { getProxyConfigs, IS_DOCKER, DOCKER_SERVICE_NAMES } = require('./process-manager');
  const proxyName = req.params.proxy;
  const rest = req.params[0];
  const config = getProxyConfigs()[proxyName];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${proxyName}` });
  }

  const method = req.method.toLowerCase();

  console.log(`[FORWARD] ${method} ${proxyName}/${rest}`);

  const startTime = Date.now();

  try {
    const host = IS_DOCKER ? DOCKER_SERVICE_NAMES[proxyName] || proxyName : '127.0.0.1';
    const axiosConfig = {
      baseURL: `http://${host}:${config.port}`,
      url: rest,
      method,
      timeout: 15000,
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    // Pass auth token to proxy if configured
    const proxyAuthToken = process.env.PROXY_AUTH_TOKEN;
    if (proxyAuthToken) {
      axiosConfig.headers['x-proxy-auth'] = proxyAuthToken;
    }
    if (['post', 'put', 'patch'].includes(method) && req.body) {
      axiosConfig.data = req.body;
    }

    appendLog('info', proxyName, `${method.toUpperCase()} ${rest}`, {
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });

    const response = await axios(axiosConfig);
    const elapsed = Date.now() - startTime;
    console.log(`[FORWARD OK] ${method} ${proxyName}/${rest} -> ${response.status} (${elapsed}ms)`);
    appendLog('info', proxyName, `${method.toUpperCase()} ${rest} completed in ${elapsed}ms`, { status: response.status });

    // L2 P2 A路·token×单价埋点（门控 PROXY_COST_TRACK 关时零开销：只做 rest 字符串比较）
    if (rest === '/v1/chat/completions' && response.data && response.data.usage) {
        try { require('./cost-track').accumulate(proxyName, response.data.usage); } catch { /* 非致命 */ }
    }

    res.json(response.data);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.log(`[FORWARD ERR] ${method} ${proxyName}/${rest} -> ${error.message} (${elapsed}ms)`);
    appendLog('error', proxyName, `${method.toUpperCase()} ${rest} failed after ${elapsed}ms: ${error.message}`);
    if (error.response) {
      // Sanitize: never forward provider-specific error details to client
      const sanitizedData = {
        status: error.response.status,
        statusText: error.response.statusText,
      };
      res.status(error.response.status).json({ success: false, error: error.response.statusText, data: sanitizedData });
    } else {
      res.status(503).json({ success: false, error: `${config.name} is not reachable` });
    }
  }
}

module.exports = {
  classifyUpstreamError,
  normalizeModels,
  isAllowedEndpoint,
  forwardProxy,
};
