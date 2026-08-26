// ==================== 路由：代理生命周期 + 日志 API ====================
const express = require('express');
const fs = require('fs');

const { requireAuth } = require('../lib/auth');
const { appendLog, LOG_FILE } = require('../lib/logger');
const pm = require('../lib/process-manager');
const { detectOccupancy, detectAll } = require('../lib/agent-owner');

const router = express.Router();

// 全局代理冲突检测：打开应用时调用，报告哪些 agent 被其它工具占用。
// 返回 { conflicts: { codex: {...}, hermes: {...}, cursor: {...} }, any: bool }
router.get('/conflicts', requireAuth, (_req, res) => {
  const all = detectAll();
  const any = Object.values(all).some(c => c.occupied);
  res.json({ conflicts: all, any });
});

// 获取所有代理状态
router.get('/status', async (_req, res) => {
  const PROXY_CONFIGS = pm.getProxyConfigs();
  const status = {};

  for (const [name, config] of Object.entries(PROXY_CONFIGS)) {
    const running = pm.isProcessRunning(name);

    let health = null;
    try {
      health = await pm.fetchProxyApi(name, '/health');
    } catch { /* ignore */ }

    const recovery = pm.getCrashRecovery(name);
    status[name] = {
      running,
      health,
      port: config.port,
      name: config.name,
      fault: recovery.consecutiveFailures >= 5,
    };
  }

  res.json(status);
});

// 启动代理
router.post('/start/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const config = pm.getProxyConfigs()[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  // 冲突检测：若该 agent 的 base_url 已被其它代理工具（如 cc-switch）占用，
  // 拒绝开启，并要求先关掉那个工具，避免两个代理器“打架”把流量指向死链。
  const occ = detectOccupancy(name);
  if (occ.occupied) {
    appendLog('warn', name, `Start blocked: agent base_url occupied by other tool (${occ.by}, ${occ.baseUrl})`);
    return res.status(409).json({
      success: false,
      conflict: true,
      error: `无法开启 ${config.name}：${name} 的代理已被其它工具占用（base_url 指向 ${occ.by}）。` +
             `请先关闭该工具对 ${name} 的代理，再开启本服务的开关。`,
      occupiedBy: occ.by,
      baseUrl: occ.baseUrl,
    });
  }

  if (pm.isProcessRunning(name)) {
    return res.json({ success: true, message: `${config.name} is already running`, running: true });
  }

  pm.proxyCrashRecovery[name] = { restartCount: 0, lastRestartTime: 0, consecutiveFailures: 0 };
  pm.saveCrashRecoveryState();

  appendLog('info', name, `Starting proxy via manager`);

  try {
    if (pm.IS_DOCKER) {
      const containerName = pm.DOCKER_CONTAINER_NAMES[name];
      if (!containerName) {
        return res.status(500).json({ success: false, error: `Unknown service: ${name}` });
      }
      const { execSync } = require('child_process');
      execSync(`docker start ${containerName} 2>/dev/null`, { stdio: 'pipe', timeout: 30000 });
      appendLog('info', name, `Started successfully`);
      return res.json({ success: true, message: `${config.name} started`, running: true });
    }

    pm.spawnProxy(name);

    const bound = await pm.waitForPortBound(config.port, 5000);
    if (bound) {
      appendLog('info', name, `Started successfully`);
      res.json({ success: true, message: `${config.name} started`, running: true });
    } else {
      appendLog('error', name, `Failed to start (port not bound)`);
      if (pm.proxyProcesses[name]) pm.proxyProcesses[name].kill('SIGKILL');
      delete pm.proxyProcesses[name];
      res.status(500).json({ success: false, error: `${config.name} failed to start` });
    }
  } catch (error) {
    appendLog('error', name, `Start failed: ${error.message}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 停止代理
router.post('/stop/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const config = pm.getProxyConfigs()[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  if (!pm.isProcessRunning(name)) {
    return res.json({ success: true, message: `${config?.name || name} is not running`, running: false });
  }

  appendLog('info', name, `Stopping proxy via manager`);

  const stopped = await pm.stopProxy(name);
  if (stopped) {
    appendLog('info', name, `Stopped successfully`);
    res.json({ success: true, message: `${config.name} stopped`, running: false });
  } else {
    appendLog('warn', name, `Stop failed, port still in use`);
    res.json({ success: false, error: `Failed to stop ${config.name}, process still running` });
  }
});

// 重启代理
router.post('/restart/:name', requireAuth, async (req, res) => {
  const { name } = req.params;
  const config = pm.getProxyConfigs()[name];

  if (!config) {
    return res.status(404).json({ success: false, error: `Unknown proxy: ${name}` });
  }

  appendLog('info', name, `Restarting proxy via manager`);

  try {
    if (pm.IS_DOCKER) {
      const containerName = pm.DOCKER_CONTAINER_NAMES[name];
      if (containerName) {
        const { execSync } = require('child_process');
        execSync(`docker restart ${containerName} 2>/dev/null`, { stdio: 'pipe', timeout: 30000 });
        appendLog('info', name, `Restarted successfully`);
        return res.json({ success: true, message: `${config.name} restarted`, running: true });
      }
    }

    // Stop
    await pm.stopProxy(name);

    // Start
    pm.spawnProxy(name);

    const bound = await pm.waitForPortBound(config.port, 5000);
    if (bound) {
      appendLog('info', name, `Restarted successfully`);
      res.json({ success: true, message: `${config.name} restarted`, running: true });
    } else {
      appendLog('error', name, `Restart failed`);
      if (pm.proxyProcesses[name]) pm.proxyProcesses[name].kill('SIGKILL');
      delete pm.proxyProcesses[name];
      res.status(500).json({ success: false, error: `${config.name} failed to restart` });
    }
  } catch (error) {
    appendLog('error', name, `Restart failed: ${error.message}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==================== 日志 API ====================
router.get('/logs', requireAuth, (req, res) => {
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

router.get('/logs/raw', requireAuth, (_req, res) => {
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

router.post('/logs/clear', requireAuth, (_req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, '');
    appendLog('info', 'system', 'Logs cleared');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
