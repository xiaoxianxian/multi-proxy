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
  requireAuth,
};
