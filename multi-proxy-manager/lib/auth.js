// ==================== Auth ====================
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ==================== JWT Secret ====================
const JWT_SECRET_FILE = path.join(os.homedir(), '.multi-proxy-jwt-secret');

/**
 * Load JWT secret: async-first, with sync fallback for module-load-time use.
 * In async contexts (e.g., server startup), call loadJwtSecretAsync().
 * During module load (synchronous), fall back to the sync helper.
 */
async function loadJwtSecretAsync() {
  // 1. Environment variable takes highest priority
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length > 0) {
    return process.env.JWT_SECRET;
  }

  // 2. Try to read persisted secret file (async)
  try {
    const stored = await fs.promises.readFile(JWT_SECRET_FILE, 'utf8').then(s => s.trim());
    if (stored.length > 0) {
      return stored;
    }
  } catch (e) {
    // File does not exist — fall through to generation
  }

  // 3. Generate new secret and persist it
  const newSecret = crypto.randomBytes(64).toString('hex');
  try {
    await fs.promises.writeFile(JWT_SECRET_FILE, newSecret, { mode: 0o600 });
    console.log('[Auth] Generated new JWT secret, persisted to ' + JWT_SECRET_FILE);
  } catch (e) {
    console.error('[Auth] Failed to persist JWT secret:', e.message);
  }
  return newSecret;
}

/** Sync fallback for module-load-time (used when async not possible). */
function getOrGenerateJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length > 0) {
    return process.env.JWT_SECRET;
  }
  try {
    const stored = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    if (stored.length > 0) return stored;
  } catch (e) { /* file doesn't exist */ }

  const newSecret = crypto.randomBytes(64).toString('hex');
  try {
    fs.writeFileSync(JWT_SECRET_FILE, newSecret, { mode: 0o600 });
    console.log('[Auth] Generated new JWT secret, persisted to ' + JWT_SECRET_FILE);
  } catch (e) {
    console.error('[Auth] Failed to persist JWT secret:', e.message);
  }
  return newSecret;
}

// Module-load-time sync fallback
const AUTH_SECRET = getOrGenerateJwtSecret();

const TOKEN_EXPIRY = '8h';
const PASSWORD_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'password');

function getPassword() {
  try {
    if (fs.existsSync(PASSWORD_FILE)) {
      return fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    }
  } catch {}
  return null;
}

function setPassword(hash) {
  try {
    const dir = path.dirname(PASSWORD_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(PASSWORD_FILE, hash, { mode: 0o600 });
  } catch (e) {
    // P0-1: EISDIR = 密码路径被目录占用（典型：Docker 把卷挂到了文件路径，
    // Docker 自动建了目录）。给出针对性提示，别让用户去查"文件权限"。
    if (e.code === 'EISDIR') {
      console.error('[Auth] Password path is occupied by a DIRECTORY (typical cause: a Docker volume mounted at the file path). Fix the volume mount and recreate the container.');
      throw new Error('Password storage path is occupied by a directory. Check your Docker volume mounts.');
    }
    console.error('[Auth] Failed to write password file:', e.message);
    throw e;
  }
}

function needsPasswordSetup() {
  const envPassword = process.env.MANAGER_PASSWORD;
  if (envPassword && envPassword.length > 0) return false;
  return getPassword() === null;
}

async function verifyPassword(input) {
  const envPassword = process.env.MANAGER_PASSWORD;
  if (envPassword && envPassword.length > 0) {
    return input === envPassword;
  }
  const stored = getPassword();
  if (!stored) return false;
  return await bcrypt.compare(input, stored);
}

function generateToken(password) {
  const payload = { authenticated: true, ts: Date.now() };
  return jwt.sign(payload, AUTH_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function requireAuth(req, res, next) {
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

// ==================== 机器凭据（跨进程写账用） ====================
// 场景：agent 的代理进程（codex-proxy 等）要把上游 usage 写进 manager 的 cost-track。
// 这是**写端点**，不能 fail-open —— 谁能往里灌假成本，谁就能污染成本盘面。
// 但与「开盒即用」冲突：要求代理先登录拿 JWT 太重。
//
// 解法 = 复用 auth.js 已有的「首次运行落盘生成」套路（见 getOrGenerateJwtSecret）：
// manager 首次启动 mint 一个机器 token 落到 ~/.multi-proxy-manager/agent-token（0600），
// 再注入自己的 process.env —— lib/process-manager.js 的 spawnProxy 用 `{ ...process.env }`
// 拉起代理子进程，token 自动跟着走；第三方 agent 代理复制同一串进自己的 env 即可。
//
// 🔴 不是秘密的「秘密」：token 只在环回面防随手灌数。网络暴露前仍须走正经鉴权（界面 JWT / PROXY_AUTH_TOKEN）。
const AGENT_TOKEN_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'agent-token');

function getOrGenerateAgentToken() {
  if (process.env.MANAGER_AGENT_TOKEN && process.env.MANAGER_AGENT_TOKEN.length > 0) {
    return process.env.MANAGER_AGENT_TOKEN;
  }
  try {
    const stored = fs.readFileSync(AGENT_TOKEN_FILE, 'utf8').trim();
    if (stored.length > 0) return stored;
  } catch { /* 文件不存在 → 生成 */ }

  const newToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(AGENT_TOKEN_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(AGENT_TOKEN_FILE, newToken, { mode: 0o600 });
  } catch (e) {
    console.error('[Auth] Failed to persist agent token:', e.message);
  }
  return newToken;
}

/**
 * 写端点用的守卫：界面 JWT **或** 机器 token，二选一即放行。
 * 只读端点不用它（继续用 requireAuth 或直接不挂）。
 */
function requireAgentAuth(req, res, next) {
  const agentToken = req.headers['x-agent-token'];
  if (agentToken && agentToken === process.env.MANAGER_AGENT_TOKEN) return next();
  return requireAuth(req, res, next);
}

console.log('[Auth] Management auth ' + (needsPasswordSetup() ? 'disabled (first-run)' : 'enabled'));

module.exports = {
  loadJwtSecretAsync,
  AUTH_SECRET,
  TOKEN_EXPIRY,
  PASSWORD_FILE,
  getPassword,
  setPassword,
  needsPasswordSetup,
  verifyPassword,
  generateToken,
  getOrGenerateAgentToken,
  requireAuth,
  requireAgentAuth,
};
