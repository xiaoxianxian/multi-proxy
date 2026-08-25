// ==================== 代理配置 + 进程管理 ====================
const path = require('path');
const axios = require('axios');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const { appendLog } = require('./logger');

// ==================== 代理配置 ====================
function buildProxyConfigs() {
  const baseDir = path.join(__dirname, '..', '..');
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
const CRASH_RECOVERY_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'crash-recovery.json');

/** Ensure the persistence directory exists */
function ensureCrashRecoveryDir() {
  const dir = path.dirname(CRASH_RECOVERY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Read crash-recovery state from disk; returns empty object on failure */
function loadCrashRecoveryState() {
  try {
    ensureCrashRecoveryDir();
    if (fs.existsSync(CRASH_RECOVERY_FILE)) {
      const data = fs.readFileSync(CRASH_RECOVERY_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[CrashRecovery] Failed to load state:', e.message);
  }
  return {};
}

/** Write crash-recovery state to disk */
function saveCrashRecoveryState() {
  try {
    ensureCrashRecoveryDir();
    fs.writeFileSync(CRASH_RECOVERY_FILE, JSON.stringify(proxyCrashRecovery, null, 2));
  } catch (e) {
    console.error('[CrashRecovery] Failed to save state:', e.message);
  }
}

function getCrashRecovery(name) {
  if (!proxyCrashRecovery[name]) {
    proxyCrashRecovery[name] = { restartCount: 0, lastRestartTime: 0, consecutiveFailures: 0 };
  }
  return proxyCrashRecovery[name];
}

// Load persisted crash-recovery state on startup
const persisted = loadCrashRecoveryState();
for (const name of Object.keys(persisted)) {
  proxyCrashRecovery[name] = persisted[name];
}
if (Object.keys(persisted).length > 0) {
  console.log('[CrashRecovery] Loaded state for:', Object.keys(persisted).join(', '));
}

// ==================== Docker detection ====================
const IS_DOCKER = fs.existsSync('/.dockerenv');

// Docker Compose service names (used for inter-container networking via hostname)
const DOCKER_SERVICE_NAMES = {
  codex: 'codex-proxy',
  hermes: 'hermes-proxy',
  cursor: 'cursor-proxy',
};

// Container names (used for docker start/stop/inspect commands)
const DOCKER_CONTAINER_NAMES = {
  codex: 'proxy-rebuild-codex',
  hermes: 'proxy-rebuild-hermes',
  cursor: 'proxy-rebuild-cursor',
};

// ==================== 辅助函数 ====================
const LSOF = '/usr/sbin/lsof';

function isProcessRunning(name) {
  const config = PROXY_CONFIGS[name];
  if (!config) return false;

  if (IS_DOCKER) {
    try {
      const containerName = DOCKER_CONTAINER_NAMES[name];
      if (containerName) {
        const { execSync } = require('child_process');
        const status = execSync(`docker container inspect -f {{.State.Status}} ${containerName} 2>/dev/null`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
        if (status === 'running') return true;
      }
    } catch {}
    return false;
  }

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

function waitForDockerStop(containerName, timeout = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      try {
        const { execSync } = require('child_process');
        const status = execSync(`docker container inspect -f {{.State.Status}} ${containerName} 2>/dev/null`, { stdio: 'pipe', timeout: 3000 }).toString().trim();
        if (status !== 'running') {
          resolve(true);
        } else if (Date.now() - start < timeout) {
          setTimeout(check, 300);
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
    const host = IS_DOCKER ? DOCKER_SERVICE_NAMES[proxyName] || proxyName : '127.0.0.1';
    const axiosConfig = {
      baseURL: `http://${host}:${config.port}`,
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
  path.join(__dirname, '..', '..'),
];

/**
 * Validate that a candidate path is safely within an allowed directory.
 * Prevents path traversal attacks.
 * A10: Added realpath resolution + symlink check to prevent escape via symlinks.
 */
function isSafePath(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    return ALLOWED_CWD_PREFIXES.some(prefix => {
      const prefixResolved = path.resolve(prefix);
      return resolved === prefixResolved || resolved.startsWith(prefixResolved + path.sep);
    });
  } catch (e) {
    // realpathSync fails for non-existent paths — fall back to resolve()
    const resolved = path.resolve(candidate);
    return ALLOWED_CWD_PREFIXES.some(prefix => resolved === path.resolve(prefix) || resolved.startsWith(path.resolve(prefix) + path.sep));
  }
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
      saveCrashRecoveryState();
      return;
    }

    // Non-zero exit: trigger exponential backoff restart
    recovery.consecutiveFailures++;
    recovery.lastRestartTime = Date.now();
    saveCrashRecoveryState();

    if (recovery.consecutiveFailures >= 5) {
      appendLog('error', name, `Process crashed 5 times consecutively — entering fault state`);
      console.log(`[${config.name}] FAULT: 5 consecutive crashes`);
      return;
    }

    const backoff = Math.min(1000 * Math.pow(2, recovery.restartCount), 16000);
    recovery.restartCount++;
    saveCrashRecoveryState();
    appendLog('warn', name, `Process crashed (exit code ${code}), restarting in ${backoff}ms (attempt ${recovery.restartCount})`);
    console.log(`[${config.name}] Crashed, retrying in ${backoff}ms`);

    await waitForPortFree(config.port, 3000);
    restartProxy(name, backoff);
  });

  return proc;
}

/**
 * Stop a proxy: SIGTERM → wait → SIGKILL. Resets crash recovery state.
 * In Docker, uses docker compose stop.
 */
async function stopProxy(name) {
  const config = PROXY_CONFIGS[name];
  if (!config) return false;

  if (IS_DOCKER) {
    try {
      const containerName = DOCKER_CONTAINER_NAMES[name];
      if (containerName) {
        const { execSync } = require('child_process');
        execSync(`docker stop ${containerName} 2>/dev/null`, { stdio: 'pipe', timeout: 30000 });
        // Verify the container actually stopped
        const stopped = await waitForDockerStop(containerName, 8000);
        if (stopped) {
          proxyCrashRecovery[name] = { restartCount: 0, lastRestartTime: 0, consecutiveFailures: 0 };
          saveCrashRecoveryState();
        }
        return stopped;
      }
    } catch (e) {
      appendLog('error', name, `Docker stop failed: ${e.message}`);
    }
    return false;
  }

  // Collect the set of PIDs we are authorized to kill for this proxy
  const allowedPids = new Set();

  // Add tracked process PID
  const proc = proxyProcesses[name];
  if (proc) {
    allowedPids.add(proc.pid);
    try { proc.kill('SIGTERM'); } catch {}
    delete proxyProcesses[name];
  }

  // Collect children of allowed PIDs via /proc on Linux, or ps on macOS
  try {
    const { execSync } = require('child_process');
    for (const pid of allowedPids) {
      try {
        let children = [];
        let pending = [pid];
        while (pending.length > 0) {
          const childCmd = `/bin/ps -o pid= --ppid ${pending.join(' ')}`;
          const output = execSync(childCmd, { stdio: 'pipe' }).toString().trim();
          children = children.concat(output.split('\n').map(l => l.trim()).filter(Boolean));
          pending = children.slice(children.length - pending.length);
        }
        children.forEach(c => allowedPids.add(parseInt(c)));
      } catch {}
    }
  } catch {}

  // Kill via port with PID whitelist: only kill PIDs that belong to this proxy
  try {
    const { execSync } = require('child_process');
    const pids = execSync(`${LSOF} -ti :${config.port}`, { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean);
    // Fallback for externally-started proxies (e.g. via manage.sh nohup):
    // proxyProcesses is empty then, so authorize port PIDs only when the
    // process's working directory matches this proxy's configured cwd.
    if (allowedPids.size === 0 && config.cwd) {
      for (const pid of pids) {
        try {
          const cwdOut = execSync(`${LSOF} -a -p ${pid} -d cwd`, { stdio: 'pipe' }).toString();
          if (cwdOut.includes(config.cwd)) allowedPids.add(parseInt(pid));
        } catch {}
      }
    }
    for (const pid of pids) {
      const pidNum = parseInt(pid);
      if (!allowedPids.has(pidNum)) continue;
      try { process.kill(pidNum, 'SIGTERM'); } catch {}
    }
  } catch {}

  // Wait for port to free
  const freed = await waitForPortFree(config.port, 5000);
  if (!freed) {
    try {
      const { execSync } = require('child_process');
      const pids = execSync(`${LSOF} -ti :${config.port}`, { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        const pidNum = parseInt(pid);
        if (!allowedPids.has(pidNum)) continue;
        try { process.kill(pidNum, 'SIGKILL'); } catch {}
      }
      await waitForPortFree(config.port, 2000);
    } catch {}
  }

  const stillRunning = isProcessRunning(name);
  if (!stillRunning) {
    proxyCrashRecovery[name] = { restartCount: 0, lastRestartTime: 0, consecutiveFailures: 0 };
    saveCrashRecoveryState();
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

  // Guard: if another spawn/restart already tracks this process, skip
  const existing = proxyProcesses[name];
  if (existing && existing.kill) return;

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
      saveCrashRecoveryState();
      if (proxyProcesses[name]) proxyProcesses[name].kill('SIGKILL');
      delete proxyProcesses[name];
    }
  } catch (err) {
    appendLog('error', name, `Auto-restart failed: ${err.message}`);
  }
}

module.exports = {
  getProxyConfigs: () => PROXY_CONFIGS,
  proxyProcesses,
  proxyCrashRecovery,
  IS_DOCKER,
  DOCKER_SERVICE_NAMES,
  DOCKER_CONTAINER_NAMES,
  LSOF,
  isProcessRunning,
  waitForPortFree,
  waitForDockerStop,
  waitForPortBound,
  fetchProxyApi,
  spawnProxy,
  stopProxy,
  restartProxy,
  getCrashRecovery,
  saveCrashRecoveryState,
};
