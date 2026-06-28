#!/usr/bin/env node
const express = require('express');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

// ==================== JWT Secret ====================
const JWT_SECRET_FILE = path.join(os.homedir(), '.multi-proxy-jwt-secret');

function getOrGenerateJwtSecret() {
  // 1. Environment variable takes highest priority
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length > 0) {
    return process.env.JWT_SECRET;
  }

  // 2. Try to read persisted secret file
  try {
    const stored = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    if (stored.length > 0) {
      return stored;
    }
  } catch (e) {
    // File does not exist — fall through to generation
  }

  // 3. Generate new secret and persist it
  const newSecret = crypto.randomBytes(64).toString('hex');
  try {
    fs.writeFileSync(JWT_SECRET_FILE, newSecret, { mode: 0o600 });
    console.log('[Auth] Generated new JWT secret, persisted to ' + JWT_SECRET_FILE);
  } catch (e) {
    console.error('[Auth] Failed to persist JWT secret:', e.message);
  }
  return newSecret;
}

const AUTH_SECRET = getOrGenerateJwtSecret();

// ==================== Auth ====================
const TOKEN_EXPIRY = '8h';
const PASSWORD_FILE = path.join(os.homedir(), '.multi-proxy-password');

function getPassword() {
  try {
    if (fs.existsSync(PASSWORD_FILE)) {
      return fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    }
  } catch {}
  return null;
}

function setPassword(hash) {
  fs.writeFileSync(PASSWORD_FILE, hash, { mode: 0o600 });
}

function needsPasswordSetup() {
  const envPassword = process.env.MANAGER_PASSWORD;
  if (envPassword && envPassword.length > 0) return false;
  return getPassword() === null;
}

function verifyPassword(input) {
  const envPassword = process.env.MANAGER_PASSWORD;
  if (envPassword && envPassword.length > 0) {
    return input === envPassword;
  }
  const stored = getPassword();
  if (!stored) return false;
  return bcrypt.compareSync(input, stored);
}

function generateToken(password) {
  const payload = { authenticated: true, ts: Date.now() };
  return jwt.sign(payload, AUTH_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function requireAuth(req, res, next) {
  const envPassword = process.env.MANAGER_PASSWORD;
  if (envPassword && envPassword.length > 0) {
    // Dev mode: skip auth if MANAGER_PASSWORD is set (trust env)
    return next();
  }
  const token = req.headers['x-auth-token'] || (req.cookies && req.cookies.auth_token);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(token, AUTH_SECRET);
    req.auth = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token expired' });
  }
}

function isReadOnlyEndpoint(path, method) {
  const readOnlyPaths = ['/api/status', '/api/logs', '/api/logs/raw', '/health', '/v1/models'];
  if (method === 'GET' && readOnlyPaths.some(p => path.startsWith(p))) return true;
  return false;
}

console.log('[Auth] Management auth ' + (needsPasswordSetup() ? 'disabled (first-run)' : 'enabled'));

const app = express();
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:18792';
console.log('[CORS] Origin: ' + CORS_ORIGIN);

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '10mb' }));

// Disable caching for HTML so browser always gets latest version
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-cache');
  }
  next();
});

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net unpkg.com; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net unpkg.com; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
      meta: meta,
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
const proxyCrashRecovery = {}; // name -> { restartCount, lastRestartTime, consecutiveFailures }

function getCrashRecovery(name) {
  if (!proxyCrashRecovery[name]) {
    proxyCrashRecovery[name] = { restartCount: 0, lastRestartTime: 0, consecutiveFailures: 0 };
  }
  return proxyCrashRecovery[name];
}

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

// ==================== Proxy Lifecycle Helpers ====================

// Allowed base directories for proxy spawning
const ALLOWED_CWD_PREFIXES = [
  path.join(__dirname, '..'),
];

/**
 * Validate that a candidate path is safely within an allowed directory.
 * Prevents path traversal attacks.
 */
function isSafePath(candidate) {
  const resolved = path.resolve(candidate);
  return ALLOWED_CWD_PREFIXES.some(prefix => resolved === path.resolve(prefix) || resolved.startsWith(path.resolve(prefix) + path.sep));
}

// Allowed spawn commands (deny arbitrary binaries)
const ALLOWED_COMMANDS = new Set(['node', 'python3']);

// Allowed startArgs: arrays of safe string tokens only
function isValidStartArgs(args) {
  if (!Array.isArray(args)) return false;
  return args.every(a => typeof a === 'string' && /^[a-zA-Z0-9_./-]+$/.test(a));
}

/**
 * Spawn a proxy process with stdio forwarding and crash-recovery close handler.
 * Used by both the manual start route and the auto-restart path.
 */
function spawnProxy(name) {
  const config = PROXY_CONFIGS[name];
  if (!config) throw new Error(`Unknown proxy: ${name}`);

  // Validate cwd is within allowed project directories
  if (!isSafePath(config.cwd)) {
    throw new Error('Spawn rejected: cwd is outside allowed project directories');
  }

  // Validate startCommand is in the allowlist
  const cmd = path.basename(config.startCommand);
  if (!ALLOWED_COMMANDS.has(cmd)) {
    throw new Error('Spawn rejected: startCommand "' + cmd + '" is not in the allowlist');
  }

  // Validate startArgs contain no dangerous characters
  if (!isValidStartArgs(config.startArgs)) {
    throw new Error('Spawn rejected: startArgs contain invalid characters');
  }

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

  // Attach crash-recovery handler
  proc.on('close', async (code) => {
    delete proxyProcesses[name];

    const recovery = getCrashRecovery(name);

    if (code === 0) {
      // Graceful exit: reset counter
      recovery.restartCount = 0;
      recovery.consecutiveFailures = 0;
      return;
    }

    // Non-zero exit: trigger exponential backoff restart
    recovery.consecutiveFailures++;
    recovery.lastRestartTime = Date.now();

    if (recovery.consecutiveFailures >= 5) {
      appendLog('error', name, `Process crashed 5 times consecutively — entering fault state`);
      console.log(`[${config.name}] FAULT: 5 consecutive crashes`);
      return;
    }

    const backoff = Math.min(1000 * Math.pow(2, recovery.restartCount), 16000);
    recovery.restartCount++;
    appendLog('warn', name, `Process crashed (exit code ${code}), restarting in ${backoff}ms (attempt ${recovery.restartCount})`);
    console.log(`[${config.name}] Crashed, retrying in ${backoff}ms`);

    await waitForPortFree(config.port, 3000);
    restartProxy(name, backoff);
  });

  return proc;
}

/**
 * Stop a proxy: SIGTERM → wait → SIGKILL. Resets crash recovery state.
 */
async function stopProxy(name) {
  const config = PROXY_CONFIGS[name];
  if (!config) return false;

  // Try to kill via tracked process first
  const proc = proxyProcesses[name];
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    delete proxyProcesses[name];
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
  if (!stillRunning) {
    proxyCrashRecovery[name] = { restartCount: 0, lastRestartTime: 0, consecutiveFailures: 0 };
  }
  return !stillRunning;
}

// ==================== Crash Recovery ====================

/**
 * Restart a proxy with exponential backoff. Used by both the initial spawn's
 * close handler and subsequent auto-restarts.
 * @param {string} name - proxy name (e.g. 'codex')
 * @param {number} delay - ms to wait before spawning (0 = immediate)
 */
async function restartProxy(name, delay = 0) {
  const config = PROXY_CONFIGS[name];
  if (!config) return;

  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  if (isProcessRunning(name)) return;
  const recovery = getCrashRecovery(name);
  if (recovery.consecutiveFailures >= 5) return;

  try {
    spawnProxy(name);

    const bound = await waitForPortBound(config.port, 5000);
    if (!bound) {
      appendLog('error', name, `Failed to start (port not bound)`);
      recovery.consecutiveFailures++;
      recovery.lastRestartTime = Date.now();
      delete proxyProcesses[name];
      if (proxyProcesses[name]) proxyProcesses[name].kill('SIGKILL');
    }
  } catch (err) {
    appendLog('error', name, `Auto-restart failed: ${err.message}`);
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

    const recovery = getCrashRecovery(name);
    status[name] = {
      running,
      health,
      port: config.port,
      name: config.name,
      scriptPath: config.scriptPath,
      fault: recovery.consecutiveFailures >= 5,
    };
  }

  res.json(status);
});

// 启动代理
app.post('/api/start/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const config = PROXY_CONFIGS[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  if (isProcessRunning(name)) {
    return res.json({ success: true, message: `${config.name} is already running`, running: true });
  }

  // Reset crash recovery state on manual start
  proxyCrashRecovery[name] = { restartCount: 0, lastRestartTime: 0, consecutiveFailures: 0 };

  appendLog('info', name, `Starting proxy via manager`);

  try {
    spawnProxy(name);

    const bound = await waitForPortBound(config.port, 5000);
    if (bound) {
      appendLog('info', name, `Started successfully`);
      res.json({ success: true, message: `${config.name} started`, running: true });
    } else {
      appendLog('error', name, `Failed to start (port not bound)`);
      delete proxyProcesses[name];
      if (proxyProcesses[name]) proxyProcesses[name].kill('SIGKILL');
      res.status(500).json({ success: false, error: `${config.name} failed to start` });
    }
  } catch (error) {
    appendLog('error', name, `Start failed: ${error.message}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 停止代理
app.post('/api/stop/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const config = PROXY_CONFIGS[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  if (!isProcessRunning(name)) {
    return res.json({ success: true, message: `${config?.name || name} is not running`, running: false });
  }

  appendLog('info', name, `Stopping proxy via manager`);

  const stopped = await stopProxy(name);
  if (stopped) {
    appendLog('info', name, `Stopped successfully`);
    res.json({ success: true, message: `${config.name} stopped`, running: false });
  } else {
    appendLog('warn', name, `Stop failed, port still in use`);
    res.json({ success: false, error: `Failed to stop ${config.name}, process still running` });
  }
});

// 重启代理
app.post('/api/restart/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const config = PROXY_CONFIGS[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  appendLog('info', name, `Restarting proxy via manager`);

  try {
    // Stop
    await stopProxy(name);

    // Start
    spawnProxy(name);

    const bound = await waitForPortBound(config.port, 5000);
    if (bound) {
      appendLog('info', name, `Restarted successfully`);
      res.json({ success: true, message: `${config.name} restarted`, running: true });
    } else {
      appendLog('error', name, `Restart failed`);
      delete proxyProcesses[name];
      if (proxyProcesses[name]) proxyProcesses[name].kill('SIGKILL');
      res.status(500).json({ success: false, error: `${config.name} failed to restart` });
    }
  } catch (error) {
    appendLog('error', name, `Restart failed: ${error.message}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
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
    res.json({ logs: '', count: 0, success: false, error: 'Internal server error' });
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
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/logs/clear', requireAuth, (_req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, '');
    appendLog('info', 'system', 'Logs cleared');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 转发 API 请求到代理（通用）
async function forwardProxy(req, res) {
  const proxyName = req.params.proxy;
  const rest = req.params[0];
  const config = PROXY_CONFIGS[proxyName];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${proxyName}` });
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
      res.status(error.response.status).json({ success: false, error: error.response.statusText, data: error.response.data });
    } else {
      res.status(503).json({ success: false, error: `${config.name} is not reachable` });
    }
  }
}

// ==================== Rate Limiting ====================

// Strict rate limit on login endpoint: 5 attempts per minute window
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'Too many login attempts. Please try again later.' });
  },
});

// Longer lockout after many rapid failures: 5 failed logins in 15 minutes
const lockoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'Account locked due to too many failed attempts. Try again in 15 minutes.' });
  },
});

// ==================== Auth Routes ====================

// POST /api/auth/login
app.post('/api/auth/login', lockoutLimiter, authLimiter, function(req, res) {
  const { password } = req.body;
  // DoS protection: reject passwords > 1KB
  if (password && Buffer.byteLength(password, 'utf8') > 1024) {
    return res.status(413).json({ success: false, error: 'Password too long (max 1KB)' });
  }
  if (!password) {
    return res.status(400).json({ success: false, error: 'Password required' });
  }

  const envPassword = process.env.MANAGER_PASSWORD;
  if (envPassword && envPassword.length > 0) {
    if (password === envPassword) {
      return res.json({ success: true, token: generateToken(password) });
    }
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

  // Setup mode or verify
  if (needsPasswordSetup()) {
    try {
      const hash = bcrypt.hashSync(password, 10);
      setPassword(hash);
      console.log('[Auth] Password set successfully');
      return res.json({ success: true, token: generateToken(password), setup: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  if (verifyPassword(password)) {
    return res.json({ success: true, token: generateToken(password) });
  }
  res.status(401).json({ success: false, error: 'Invalid password' });
});

// GET /api/auth/status
app.get('/api/auth/status', (_req, res) => {
  try {
    const hasPassword = getPassword() !== null || (process.env.MANAGER_PASSWORD && process.env.MANAGER_PASSWORD.length > 0);
    res.json({
      needsSetup: needsPasswordSetup(),
      hasPassword: hasPassword,
    });
  } catch (e) {
    res.json({ needsSetup: true, hasPassword: false, error: 'Internal server error' });
  }
});

// Forward proxy whitelist - only allow known endpoints
const FORWARD_ENDPOINTS = {
  codex: {
    GET: ['/v1/models', '/health', '/api/config', '/api/routing-mode', '/api/providers/status', '/api/balances', '/api/history', '/api/test-connection'],
    POST: ['/v1/chat/completions', '/api/set-routing-mode', '/api/switch-model', '/api/clear-history'],
  },
  hermes: {
    GET: ['/v1/models', '/health', '/api/config', '/api/routing-mode', '/api/providers/status', '/api/balances', '/api/history', '/api/test-connection'],
    POST: ['/v1/chat/completions', '/api/set-routing-mode', '/api/switch-model', '/api/clear-history'],
  },
  cursor: {
    GET: ['/v1/models', '/health', '/v1/chat/completions', '/admin-api/providers', '/admin-api/models', '/admin-api/routes', '/admin-api/logs', '/admin-api/health', '/admin-api/settings'],
    POST: ['/v1/chat/completions', '/admin-api/providers', '/admin-api/models', '/admin-api/routes', '/admin-api/settings'],
    PUT: ['/admin-api/providers/:id', '/admin-api/settings'],
    DELETE: ['/admin-api/providers/:id', '/admin-api/models/:id'],
  },
};

function isAllowedEndpoint(proxy, method, path) {
  const config = FORWARD_ENDPOINTS[proxy];
  if (!config) return false;
  const allowed = config[method.toUpperCase()] || config[(method.toUpperCase())];
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
          // Only accept safe ID formats: hex strings, alphanum, or short alphanumeric
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pathParts[i])) {
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

app.all('/api/:proxy/*', (req, res, next) => {
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



// ==================== 模型列表获取 ====================

/** Normalize raw provider response to canonical {id, name, displayName} */
function normalizeModels(rawModels, format) {
  var list = [];
  if (format === 'openai') {
    for (var i = 0; i < rawModels.length; i++) {
      var m = rawModels[i];
      list.push({ id: m.id, name: m.id, displayName: m.id });
    }
  } else if (format === 'anthropic') {
    for (var i = 0; i < rawModels.length; i++) {
      var m = rawModels[i];
      list.push({ id: m.identifier, name: m.identifier, displayName: m.name || m.identifier });
    }
  } else if (format === 'gemini') {
    for (var i = 0; i < rawModels.length; i++) {
      var m = rawModels[i];
      var id = m.name.replace('models/', '');
      var displayName = m.displayName || id;
      list.push({ id: id, name: id, displayName: displayName });
    }
  } else if (format === 'ollama') {
    for (var i = 0; i < rawModels.length; i++) {
      var m = rawModels[i];
      list.push({ id: m.name, name: m.name, displayName: m.name });
    }
  }
  return list;
}

app.post('/api/fetch-models', requireAuth, async (req, res) => {
  var providerId = (req.body.providerId || '').toLowerCase();
  var apiKey = req.body.apiKey || '';
  var baseUrl = (req.body.baseUrl || '').replace(/\/$/, '');

  if (!apiKey) {
    return res.status(400).json({ success: false, error: 'API Key 不能为空' });
  }

  var url, headers, format;

  if (providerId === 'openai-compatible' || providerId === 'openai' || providerId === 'azure') {
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
    appendLog('warn', 'fetch-models', 'Failed to fetch models: ' + err.message);
    res.status(502).json({ success: false, error: '无法连接到供应商 API，请检查地址和密钥' });
  }
});

// ==================== 开机自启管理 ====================
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.multi-proxy-manager.plist');
const INSTALL_SH = path.join(__dirname, '..', 'install.sh');

app.get('/api/autostart', (_req, res) => {
  res.json({ enabled: fs.existsSync(LAUNCHD_PLIST) });
});

app.post('/api/autostart', requireAuth, async (req, res) => {
  try {
    const { enable } = req.body;
    if (enable) {
      const { exec } = require('child_process');
      exec(`bash "${INSTALL_SH}" --autostart`, (error) => {
        if (error) {
          res.status(500).json({ success: false, error: 'Internal server error' });
        } else {
          res.json({ success: true, enabled: true });
        }
      });
    } else {
      const { exec } = require('child_process');
      exec(`bash "${INSTALL_SH}" --autostop`, (error) => {
        if (error) {
          res.status(500).json({ success: false, error: 'Internal server error' });
        } else {
          res.json({ success: true, enabled: false });
        }
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 版本信息
app.get('/api/version', (_req, res) => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    res.json({
      version: pkg.version || '1.0.0',
      date: '2026-06-27',
      proxies: {
        codex: '1.0.0',
        hermes: '1.0.0',
        cursor: '1.0.0',
      },
    });
  } catch (e) {
    res.json({ version: '1.0.0', date: '2026-06-27', proxies: {} });
  }
});

// 已安装的代理列表
app.get('/api/installed', (_req, res) => {
  res.json(Object.keys(PROXY_CONFIGS));
});

// API Key 完整性检查
app.get('/api/env-check', (_req, res) => {
  const baseDir = path.join(__dirname, '..');
  const emptyKeys = [];

  for (const proxy of ['codex-proxy', 'hermes-proxy']) {
    const envPath = path.join(baseDir, proxy, '.env');
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const key of ['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'AGNES_API_KEY']) {
        const match = content.match(new RegExp(`^${key}=(.*)`, 'm'));
        const val = match ? match[1].trim() : '';
        if (!val) {
          emptyKeys.push({ proxy, key });
        }
      }
    } catch (e) {
      // skip unreadable files
    }
  }

  res.json({ emptyKeys, totalCount: emptyKeys.length });
});

// SPA fallback: serve correct HTML page based on route
// Placed AFTER all route handlers so explicit routes like /health take priority
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && req.path.indexOf('.') === -1) {
    // Map routes to HTML files
    const routeMap = {
      '/': 'dashboard.html',
      '/dashboard': 'dashboard.html',
      '/logs': 'logs.html',
      '/proxy-config': 'proxy-config.html',
    };
    const page = routeMap[req.path] || 'dashboard.html';
    return res.sendFile(path.join(__dirname, 'public', page));
  }
  next();
});

// 启动服务（跳过测试环境）
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log('\n========================================');
  console.log('  Multi-Proxy Manager Shell');
  console.log(`  Access: http://localhost:${PORT}`);
  console.log(`  Managed proxies: ${Object.keys(PROXY_CONFIGS).join(', ') || 'none'}`);
  console.log('========================================\n');
});
}


module.exports = app;
