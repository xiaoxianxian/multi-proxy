// ==================== 路由：元信息（autostart / health / version / installed / env-check） ====================
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { requireAuth } = require('../lib/auth');
const pm = require('../lib/process-manager');
const { readRecentHealth } = require('../lib/health');

const router = express.Router();

// ==================== 开机自启管理 ====================
const LAUNCHD_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.multi-proxy-manager.plist');
const INSTALL_SH = path.join(__dirname, '..', '..', 'install.sh');

router.get('/autostart', (_req, res) => {
  res.json({ enabled: fs.existsSync(LAUNCHD_PLIST) });
});

router.post('/autostart', requireAuth, async (req, res) => {
  try {
    const { enable } = req.body;
    if (enable) {
      execFile('bash', [INSTALL_SH, '--autostart'], (error) => {
        if (error) {
          res.status(500).json({ success: false, error: 'Internal server error' });
        } else {
          res.json({ success: true, enabled: true });
        }
      });
    } else {
      execFile('bash', [INSTALL_SH, '--autostop'], (error) => {
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
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// M1: 健康历史回溯（最近 N 条 /api/status 持久化的归一化健康记录，倒序）
router.get('/health-history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  res.json({ history: readRecentHealth(limit) });
});

// 版本信息
router.get('/version', (_req, res) => {
  try {
    const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
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
router.get('/installed', (_req, res) => {
  res.json(Object.keys(pm.getProxyConfigs()));
});

// API Key 完整性检查
router.get('/env-check', (_req, res) => {
  const baseDir = path.join(__dirname, '..', '..', '..');
  const emptyKeys = [];

  for (const proxy of ['codex-proxy', 'hermes-proxy']) {
    const envPath = path.join(baseDir, proxy, '.env');
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      // Parse .env line-by-line, splitting on first '=' to handle values with spaces
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const k = trimmed.substring(0, eqIdx).trim();
        const v = trimmed.substring(eqIdx + 1).trim();
        if (['DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'AGNES_API_KEY'].includes(k) && !v) {
          emptyKeys.push({ proxy, key: k });
        }
      }
    } catch (e) {
      // skip unreadable files
    }
  }

  res.json({ emptyKeys, totalCount: emptyKeys.length });
});

module.exports = router;
