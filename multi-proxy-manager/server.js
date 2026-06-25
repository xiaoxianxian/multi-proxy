#!/usr/bin/env node
const express = require('express');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Disable caching for HTML so browser always gets latest version
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-cache');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const PORT = parseInt(process.env.PORT) || 18792;
const HOME = os.homedir();

// ==================== 日志系统 ====================
const LOG_DIR = path.join(os.tmpdir(), 'multi-proxy-manager');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'requests.log');

function appendLog(level, proxyName, message, meta = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      level,
      proxy: proxyName || 'system',
      msg: message,
      ...meta,
    };
    const line = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.proxy}] ${entry.msg}${Object.keys(entry.meta || {}).length ? ' ' + JSON.stringify(entry.meta) : ''}`;
    fs.appendFileSync(LOG_FILE, line + '\n');
    // Keep last 5000 lines
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').slice(-5000);
    fs.writeFileSync(LOG_FILE, lines.join('\n'));
  } catch (e) {
    // Silently ignore log errors
  }
}

// ==================== 代理配置 ====================
function buildProxyConfigs() {
  const baseDir = path.join(__dirname, '..');
  const configs = {};

  const codexDir = path.join(baseDir, 'codex-proxy');
  if (fs.existsSync(path.join(codexDir, 'proxy.js'))) {
    configs.codex = {
      name: 'Codex Proxy',
      port: 18790,
      scriptPath: path.join(codexDir, 'proxy.js'),
      startCommand: 'node',
      startArgs: ['proxy.js'],
      cwd: codexDir,
    };
  }

  const hermesDir = path.join(baseDir, 'hermes-proxy');
  if (fs.existsSync(path.join(hermesDir, 'proxy.py'))) {
    configs.hermes = {
      name: 'Hermes Proxy',
      port: 18793,
      scriptPath: path.join(hermesDir, 'proxy.py'),
      startCommand: 'python3',
      startArgs: ['proxy.py'],
      cwd: hermesDir,
    };
  }

  const cursorDir = path.join(baseDir, 'cursor-multi-model-proxy');
  const cursorDist = path.join(cursorDir, 'dist', 'server', 'start.js');
  if (fs.existsSync(cursorDist)) {
    configs.cursor = {
      name: 'Cursor Proxy',
      port: 18794,
      scriptPath: cursorDist,
      startCommand: 'node',
      startArgs: ['dist/server/start.js'],
      cwd: cursorDir,
    };
  }

  return configs;
}

let PROXY_CONFIGS = buildProxyConfigs();

// 进程跟踪
const proxyProcesses = {};

// ==================== 辅助函数 ====================
const LSOF = '/usr/sbin/lsof';

function isProcessRunning(name) {
  const config = PROXY_CONFIGS[name];
  if (!config) return false;

  // First check tracked process
  const proc = proxyProcesses[name];
  if (proc) {
    try {
      proc.kill(0);
      return true;
    } catch {
      delete proxyProcesses[name];
    }
  }

  // Fallback: check if port is listening
  try {
    const { execSync } = require('child_process');
    execSync(`${LSOF} -ti :${config.port} >/dev/null 2>&1`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function waitForPortFree(port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      try {
        const { execSync } = require('child_process');
        execSync(`${LSOF} -ti :${port} >/dev/null 2>&1`, { stdio: 'ignore' });
        if (Date.now() - start < timeout) {
          setTimeout(check, 200);
        } else {
          resolve(false);
        }
      } catch {
        resolve(true);
      }
    };
    check();
  });
}

function waitForPortBound(port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      try {
        const { execSync } = require('child_process');
        execSync(`${LSOF} -ti :${port} >/dev/null 2>&1`, { stdio: 'ignore' });
        resolve(true);
      } catch {
        if (Date.now() - start < timeout) {
          setTimeout(check, 200);
        } else {
          resolve(false);
        }
      }
    };
    check();
  });
}

async function fetchProxyApi(proxyName, endpoint, method = 'GET', body = null) {
  const config = PROXY_CONFIGS[proxyName];
  if (!config) return null;

  try {
    const axiosConfig = {
      baseURL: `http://127.0.0.1:${config.port}`,
      url: endpoint,
      method: method.toLowerCase(),
      timeout: 8000,
    };
    if (body) axiosConfig.data = body;
    const response = await axios(axiosConfig);
    return response.data;
  } catch {
    return null;
  }
}

// ==================== API 路由 ====================

// 获取所有代理状态
app.get('/api/status', async (_req, res) => {
  const status = {};

  for (const [name, config] of Object.entries(PROXY_CONFIGS)) {
    const running = isProcessRunning(name);

    let health = null;
    try {
      health = await fetchProxyApi(name, '/health');
    } catch { /* ignore */ }

    status[name] = {
      running,
      health,
      port: config.port,
      name: config.name,
      scriptPath: config.scriptPath,
    };
  }

  res.json(status);
});

// 启动代理
app.post('/api/start/:name', async (req, res) => {
  const { name } = req.params;
  const config = PROXY_CONFIGS[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  if (isProcessRunning(name)) {
    return res.json({ success: true, message: `${config.name} is already running`, running: true });
  }

  appendLog('info', name, `Starting proxy via manager`);

  try {
    const proc = spawn(config.startCommand, config.startArgs, {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proxyProcesses[name] = proc;

    proc.stdout.on('data', (data) => {
      console.log(`[${config.name}]`, data.toString());
    });

    proc.stderr.on('data', (data) => {
      console.error(`[${config.name} error]`, data.toString());
    });

    proc.on('close', (code) => {
      delete proxyProcesses[name];
      console.log(`[${config.name}] exited with code ${code}`);
      appendLog('warn', name, `Process exited with code ${code}`);
    });

    // Poll for port binding
    const bound = await waitForPortBound(config.port, 5000);
    if (bound) {
      appendLog('info', name, `Started successfully`);
      res.json({ success: true, message: `${config.name} started`, running: true });
    } else {
      appendLog('error', name, `Failed to start (port not bound)`);
      delete proxyProcesses[name];
      proc.kill('SIGKILL');
      res.status(500).json({ success: false, error: `${config.name} failed to start` });
    }
  } catch (error) {
    appendLog('error', name, `Start failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 停止代理
app.post('/api/stop/:name', async (req, res) => {
  const { name } = req.params;
  const config = PROXY_CONFIGS[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  if (!isProcessRunning(name)) {
    return res.json({ success: true, message: `${config?.name || name} is not running`, running: false });
  }

  appendLog('info', name, `Stopping proxy via manager`);

  // Try to kill via tracked process first
  const proc = proxyProcesses[name];
  if (proc) {
    try {
      proc.kill('SIGTERM');
      delete proxyProcesses[name];
    } catch {}
  }

  // Also kill via port
  try {
    const { execSync } = require('child_process');
    const pids = execSync(`${LSOF} -ti :${config.port}`, { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
    }
  } catch {}

  // Wait for port to free
  const freed = await waitForPortFree(config.port, 5000);
  if (!freed) {
    // Force kill
    try {
      const { execSync } = require('child_process');
      const pids = execSync(`${LSOF} -ti :${config.port}`, { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(parseInt(pid), 'SIGKILL'); } catch {}
      }
      await waitForPortFree(config.port, 2000);
    } catch {}
  }

  const stillRunning = isProcessRunning(name);
  if (stillRunning) {
    appendLog('warn', name, `Stop failed, port still in use`);
    res.json({ success: false, error: `Failed to stop ${config.name}, process still running` });
  } else {
    appendLog('info', name, `Stopped successfully`);
    res.json({ success: true, message: `${config.name} stopped`, running: false });
  }
});

// 重启代理
app.post('/api/restart/:name', async (req, res) => {
  const { name } = req.params;
  const config = PROXY_CONFIGS[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  appendLog('info', name, `Restarting proxy via manager`);

  try {
    // Stop
    const proc = proxyProcesses[name];
    if (proc) {
      try { proc.kill('SIGTERM'); } catch {}
    }
    delete proxyProcesses[name];

    // Also kill via port
    try {
      const { execSync } = require('child_process');
      const pids = execSync(`${LSOF} -ti :${config.port}`, { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try { process.kill(parseInt(pid), 'SIGTERM'); } catch {}
      }
    } catch {}

    await waitForPortFree(config.port, 5000);

    // Start
    const newProc = spawn(config.startCommand, config.startArgs, {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proxyProcesses[name] = newProc;

    newProc.stdout.on('data', (data) => {
      console.log(`[${config.name}]`, data.toString());
    });

    newProc.stderr.on('data', (data) => {
      console.error(`[${config.name} error]`, data.toString());
    });

    newProc.on('close', (code) => {
      delete proxyProcesses[name];
      console.log(`[${config.name}] exited with code ${code}`);
    });

    const bound = await waitForPortBound(config.port, 5000);
    if (bound) {
      appendLog('info', name, `Restarted successfully`);
      res.json({ success: true, message: `${config.name} restarted`, running: true });
    } else {
      appendLog('error', name, `Restart failed`);
      delete proxyProcesses[name];
      newProc.kill('SIGKILL');
      res.status(500).json({ success: false, error: `${config.name} failed to restart` });
    }
  } catch (error) {
    appendLog('error', name, `Restart failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 日志 API ====================
app.get('/api/logs', (req, res) => {
  try {
    const { limit = 200 } = req.query;
    if (!fs.existsSync(LOG_FILE)) {
      return res.json({ logs: '', count: 0 });
    }
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const recent = lines.slice(-parseInt(limit));
    res.json({ logs: recent.join('\n'), count: lines.length, recent: recent.length });
  } catch (e) {
    res.json({ logs: '', count: 0, error: e.message });
  }
});

app.get('/api/logs/raw', (_req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return res.send('');
    }
    res.set('Content-Type', 'text/plain');
    res.send(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logs/clear', (_req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, '');
    appendLog('info', 'system', 'Logs cleared');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 转发 API 请求到代理（通用）
async function forwardProxy(req, res) {
  const proxyName = req.params.proxy;
  const rest = req.params[0];
  const config = PROXY_CONFIGS[proxyName];

  if (!config) {
    return res.status(404).json({ error: `Unknown proxy: ${proxyName}` });
  }

  const method = req.method.toLowerCase();

  console.log(`[FORWARD] ${method} ${proxyName}/${rest}`);

  const startTime = Date.now();

  try {
    const axiosConfig = {
      baseURL: `http://127.0.0.1:${config.port}`,
      url: rest,
      method,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    };
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
    res.json(response.data);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.log(`[FORWARD ERR] ${method} ${proxyName}/${rest} -> ${error.message} (${elapsed}ms)`);
    appendLog('error', proxyName, `${method.toUpperCase()} ${rest} failed after ${elapsed}ms: ${error.message}`);
    if (error.response) {
      res.status(error.response.status).json({ error: error.response.statusText, data: error.response.data });
    } else {
      res.status(503).json({ error: `${config.name} is not reachable` });
    }
  }
}

app.all('/api/:proxy/*', forwardProxy);

// ==================== 开机自启管理 ====================
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.multi-proxy-manager.plist');
const INSTALL_SH = path.join(__dirname, '..', 'install.sh');

app.get('/api/autostart', (_req, res) => {
  res.json({ enabled: fs.existsSync(LAUNCHD_PLIST) });
});

app.post('/api/autostart', async (req, res) => {
  try {
    const { enable } = req.body;
    if (enable) {
      const { exec } = require('child_process');
      exec(`bash "${INSTALL_SH}" --autostart`, (error) => {
        if (error) {
          res.status(500).json({ success: false, error: error.message });
        } else {
          res.json({ success: true, enabled: true });
        }
      });
    } else {
      const { exec } = require('child_process');
      exec(`bash "${INSTALL_SH}" --autostop`, (error) => {
        if (error) {
          res.status(500).json({ success: false, error: error.message });
        } else {
          res.json({ success: true, enabled: false });
        }
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 启动服务
app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  Multi-Proxy Manager Shell');
  console.log(`  Access: http://localhost:${PORT}`);
  console.log(`  Managed proxies: ${Object.keys(PROXY_CONFIGS).join(', ') || 'none'}`);
  console.log('========================================\n');
});

module.exports = app;
