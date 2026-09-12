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
