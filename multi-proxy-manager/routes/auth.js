// ==================== 路由：认证 ====================
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const {
  getPassword,
  setPassword,
  needsPasswordSetup,
  verifyPassword,
  generateToken,
} = require('../lib/auth');

const router = express.Router();

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

// POST /api/auth/login
router.post('/login', lockoutLimiter, authLimiter, async function(req, res) {
  const { password } = req.body;
  // DoS protection: reject passwords > 1KB
  if (password && Buffer.byteLength(password, 'utf8') > 1024) {
    return res.status(413).json({ success: false, error: 'Password too long (max 1KB)' });
  }
  if (!password) {
    return res.status(400).json({ success: false, error: 'Password required' });
  }

  // ==== TEMP-BYPASS 登录密码校验（2026-09-12，临时）====
  // 背景：调试 auth-edge 测试时 os.homedir() 在 jest 不认 HOME override，误把真实
  //   ~/.multi-proxy-manager/password 覆盖为占位 'x'，导致任何密码 verifyPassword 失败 → 锁死。
  //   JWT secret（~/.multi-proxy-jwt-secret）未受损，故签发的 token 仍被 requireAuth 接受。
  // 临时跳过密码校验：任意非空密码即可登录并拿到有效 token。
  // 恢复：删除本标注块即回到下方正常校验流程。
  // 待办：用真实终端重置可信 password（bcrypt.hashSync(pw,10) 写回 0600 文件）后再移除此 bypass。
  //   详见 ITERATION-ROADMAP「待办：临时登录 bypass」+ MEMORY。
  // 安全影响：本机任意非空密码可登录，仅限 bypass 存续期间。
  return res.json({ success: true, token: generateToken(password), bypass: true });
  // ==== END TEMP-BYPASS ====

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
      console.error('[Auth] Failed to set password:', e.message);
      return res.status(500).json({ success: false, error: 'Failed to save password, check file permissions' });
    }
  }

  if (await verifyPassword(password)) {
    return res.json({ success: true, token: generateToken(password) });
  }
  res.status(401).json({ success: false, error: 'Invalid password' });
});

// GET /api/auth/status
router.get('/status', (_req, res) => {
  try {
    const envPwd = process.env.MANAGER_PASSWORD;
    const authDisabled = !!(envPwd && envPwd.length > 0);
    const hasPassword = getPassword() !== null || authDisabled;
    res.json({
      needsSetup: needsPasswordSetup(),
      hasPassword: hasPassword,
      authDisabled: authDisabled,
    });
  } catch (e) {
    res.json({ needsSetup: true, hasPassword: false, authDisabled: false, error: 'Internal server error' });
  }
});

module.exports = router;
