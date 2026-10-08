// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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

// ==================== 版本信息 ====================
// 原先这里读 `../../..` + `package.json`：从 routes 上溯三级已经跑到仓库**外面**那一层了
// （routes → manager → 仓库根 → 上一级目录），再加仓库根本来就没有 package.json，
// 于是每次都 catch 到硬编码 1.0.0：概览页那个版本号从来就是假的，也没人发现。
// 2026-10-04 收口：仓库根放 VERSION 当唯一版本源（上溯两级即到），子包各读各自的 package.json。
// 读不到的写 'unknown'，不许拿一个像样的假数糊过去（跟 C0-3 那条假成本数字同一个毛病）。
const ROOT_DIR = path.join(__dirname, '..', '..');

function readRootVersion() {
  try {
    const lines = fs.readFileSync(path.join(ROOT_DIR, 'VERSION'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!/^\d+\.\d+\.\d+/.test(lines[0] || '')) return { version: 'unknown', date: null };
    return { version: lines[0], date: lines[1] || null };
  } catch (e) {
    return { version: 'unknown', date: null };
  }
}

function readPackVersion(packDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, packDir, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch (e) {
    // hermes-proxy 是 Python 项目，压根没有 package.json。一次发版是同一个版本号，
    // 读不到就跟着仓库的 VERSION 走（比显示 unknown 更接近事实），
    // 仓库 VERSION 也读不到时自然落到 'unknown'。
    return readRootVersion().version;
  }
}

router.get('/version', (_req, res) => {
  const root = readRootVersion();
  res.json({
    version: root.version,
    date: root.date,   // VERSION 第二行；以前是硬编码 2026-06-27，改一次版本就得记得改代码
    proxies: {
      codex: readPackVersion('codex-proxy'),
      hermes: readPackVersion('hermes-proxy'),
      cursor: readPackVersion('cursor-proxy'),
    },
  });
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

// ==================== M3 方向三：错误模式库查询（只读） ====================
// /api/errors/patterns  — 全部模式（按频次降序），前端"常见问题"面板用
// /api/errors/history   — 结构化错误历史（最新在前），支持 ?q= 关键词检索
// 只读 GET，不需 auth（与本文件其它元信息端点一致）
const errorPatterns = require('../lib/error-patterns');

router.get('/errors/patterns', (_req, res) => {
  try {
    res.json({ patterns: errorPatterns.getPatterns(true) });
   } catch (e) {
    res.status(500).json({ error: '读取错误模式失败', detail: e.message });
   }
});

router.get('/errors/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const history = q ? errorPatterns.searchHistory(q, limit) : errorPatterns.getHistory(limit);
    res.json({ history });
   } catch (e) {
    res.status(500).json({ error: '读取错误历史失败', detail: e.message });
   }
});

module.exports = router;
