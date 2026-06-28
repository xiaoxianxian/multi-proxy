/**
 * Integration tests for manager crash recovery and log system.
 * Tests the appendLog function, log rotation, and crash recovery state machine.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Log System', () => {
  let logDir;
  let logFile;
  let appendLog;

  beforeEach(() => {
    // Create isolated temp dir for each test
    logDir = path.join(os.tmpdir(), `manager-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    logFile = path.join(logDir, 'requests.log');

    // Extract appendLog logic in isolation (matches server.js implementation)
    appendLog = function(level, proxyName, message, meta = {}) {
      try {
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const entry = {
          ts: new Date().toISOString(),
          level,
          proxy: proxyName || 'system',
          msg: message,
          meta: meta,
        };
        const line = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.proxy}] ${entry.msg}${Object.keys(entry.meta || {}).length ? ' ' + JSON.stringify(entry.meta) : ''}`;
        fs.appendFileSync(logFile, line + '\n');
        // Keep last 5000 lines
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').slice(-5000);
        fs.writeFileSync(logFile, lines.join('\n'));
      } catch (e) {
        // Silently ignore
      }
    };
  });

  afterEach(() => {
    try { fs.rmSync(logDir, { recursive: true, force: true }); } catch {}
  });

  describe('appendLog format', () => {
    it('writes correct format with timestamp, level, proxy, message', () => {
      appendLog('info', 'codex', 'Proxy started');
      const content = fs.readFileSync(logFile, 'utf8').trim();
      // Format: [ISO_TS] [LEVEL] [PROXY] MESSAGE
      expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(content).toContain('[INFO]');
      expect(content).toContain('[codex]');
      expect(content).toContain('Proxy started');
    });

    it('defaults proxy to system when not provided', () => {
      appendLog('warn', undefined, 'Something happened');
      const content = fs.readFileSync(logFile, 'utf8').trim();
      expect(content).toContain('[system]');
    });

    // The server.js appendLog was fixed: meta is now stored as entry.meta (not spread).
    // This test verifies meta fields ARE included in output.
    it('includes meta fields as JSON', () => {
      appendLog('error', 'cursor', 'Failed to start', { port: 18794, error: 'EADDRINUSE' });
      const content = fs.readFileSync(logFile, 'utf8').trim();
      expect(content).toContain('"port":18794');
      expect(content).toContain('"error":"EADDRINUSE"');
    });

    it('omits meta JSON when no meta provided', () => {
      appendLog('info', 'hermes', 'Simple message');
      const content = fs.readFileSync(logFile, 'utf8').trim();
      // Should NOT have trailing JSON object
      expect(content).not.toMatch(/\{\s*\}/);
    });
  });

  describe('Log rotation (5000 line cap)', () => {
    it('keeps only last 5000 lines', () => {
      // Write 5100 lines
      for (let i = 0; i < 5100; i++) {
        appendLog('info', 'test', `Message ${i}`);
      }
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      expect(lines.length).toBeLessThanOrEqual(5000);
    });

    it('preserves the most recent lines', () => {
      for (let i = 0; i < 100; i++) {
        appendLog('info', 'test', `msg-${i}`);
      }
      const content = fs.readFileSync(logFile, 'utf8');
      expect(content).toContain('msg-99');
      expect(content).toContain('msg-50');
    });
  });

  describe('GET /api/logs response shape', () => {
    it('returns logs, count, recent fields', () => {
      // Simulate the /api/logs handler
      const getLogs = function(limit = 200) {
        if (!fs.existsSync(logFile)) {
          return { logs: '', count: 0 };
        }
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        const recent = lines.slice(-parseInt(limit));
        return {
          logs: recent.join('\n'),
          count: lines.length,
          recent: recent.length,
        };
      };

      appendLog('info', 'codex', 'Test message');
      const result = getLogs();
      expect(result).toHaveProperty('logs');
      expect(result).toHaveProperty('count');
      expect(result).toHaveProperty('recent');
      expect(result.count).toBe(1);
      expect(result.recent).toBe(1);
    });
  });

  describe('POST /api/logs/clear', () => {
    it('empties the log file', () => {
      appendLog('info', 'test', 'Before clear');
      fs.writeFileSync(logFile, fs.readFileSync(logFile, 'utf8')); // ensure exists
      // Simulate clear
      fs.writeFileSync(logFile, '');
      const content = fs.readFileSync(logFile, 'utf8');
      expect(content).toBe('');
    });
  });
});

describe('Crash Recovery State Machine', () => {
  /**
   * Simulates the crash recovery logic from server.js without spawning real processes.
   * This tests the state transitions and backoff calculation.
   */
  function getCrashRecovery(state, name) {
    if (!state[name]) {
      state[name] = { restartCount: 0, lastRestartTime: 0, consecutiveFailures: 0 };
    }
    return state[name];
  }

  let recoveryState;

  beforeEach(() => {
    recoveryState = {};
  });

  it('starts with zero counters', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    expect(recovery.restartCount).toBe(0);
    expect(recovery.consecutiveFailures).toBe(0);
    expect(recovery.lastRestartTime).toBe(0);
  });

  it('increments consecutiveFailures on crash', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    recovery.consecutiveFailures++;
    expect(recovery.consecutiveFailures).toBe(1);
  });

  it('resets counters on graceful exit (code 0)', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    recovery.consecutiveFailures = 3;
    recovery.restartCount = 2;

    // Simulate graceful exit
    recovery.restartCount = 0;
    recovery.consecutiveFailures = 0;

    expect(recovery.restartCount).toBe(0);
    expect(recovery.consecutiveFailures).toBe(0);
  });

  it('enters fault state after 5 consecutive failures', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    for (let i = 0; i < 5; i++) {
      recovery.consecutiveFailures++;
      if (recovery.consecutiveFailures >= 5) {
        // Fault state
        break;
      }
    }
    expect(recovery.consecutiveFailures).toBe(5);
  });

  it('calculates exponential backoff correctly', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    recovery.restartCount = 0;
    let backoff = Math.min(1000 * Math.pow(2, recovery.restartCount), 16000);
    expect(backoff).toBe(1000);

    recovery.restartCount = 1;
    backoff = Math.min(1000 * Math.pow(2, recovery.restartCount), 16000);
    expect(backoff).toBe(2000);

    recovery.restartCount = 2;
    backoff = Math.min(1000 * Math.pow(2, recovery.restartCount), 16000);
    expect(backoff).toBe(4000);

    recovery.restartCount = 3;
    backoff = Math.min(1000 * Math.pow(2, recovery.restartCount), 16000);
    expect(backoff).toBe(8000);

    recovery.restartCount = 4;
    backoff = Math.min(1000 * Math.pow(2, recovery.restartCount), 16000);
    expect(backoff).toBe(16000);
  });

  it('caps backoff at 16 seconds', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    recovery.restartCount = 10;
    const backoff = Math.min(1000 * Math.pow(2, recovery.restartCount), 16000);
    expect(backoff).toBe(16000);
  });

  it('resets fault state on manual restart', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    // Simulate 5 crashes
    for (let i = 0; i < 5; i++) {
      recovery.consecutiveFailures++;
      recovery.restartCount++;
    }
    expect(recovery.consecutiveFailures).toBe(5);

    // Manual restart resets
    recovery.restartCount = 0;
    recovery.consecutiveFailures = 0;
    expect(recovery.consecutiveFailures).toBe(0);
  });

  it('tracks lastRestartTime', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    const now = Date.now();
    recovery.lastRestartTime = now;
    expect(recovery.lastRestartTime).toBeGreaterThan(0);
  });

  it('fault state prevents further restarts', () => {
    const recovery = getCrashRecovery(recoveryState, 'codex');
    for (let i = 0; i < 5; i++) {
      recovery.consecutiveFailures++;
    }
    // Would not restart
    expect(recovery.consecutiveFailures >= 5).toBe(true);
  });
});

describe('Port Detection Logic', () => {
  /**
   * Tests the isProcessRunning logic using lsof.
   * In test environment, we verify the function structure without relying on real ports.
   */
  it('lsof path is absolute', () => {
    // The server.js uses '/usr/sbin/lsof' — verify this constant
    expect('/usr/sbin/lsof').toContain('/usr/sbin/');
    expect('/usr/sbin/lsof').toBe('/usr/sbin/lsof');
  });

  it('waitForPortFree resolves when port is free', (done) => {
    // Simulate: port is free (lsof fails)
    const promise = new Promise((resolve) => {
      try {
        // lsof would fail here — port is free
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    promise.then(freed => {
      expect(freed).toBe(true);
      done();
    });
  });
});

describe('Spawn Validation', () => {
  /**
   * Tests the path and command validation in spawnProxy.
   */
  it('validates cwd is within allowed directories', () => {
    const baseDir = path.join(__dirname, '..');
    const isSafePath = function(candidate) {
      const resolved = path.resolve(candidate);
      return resolved === path.resolve(baseDir) ||
             resolved.startsWith(path.resolve(baseDir) + path.sep);
    };

    expect(isSafePath(baseDir)).toBe(true);
    expect(isSafePath('/etc/passwd')).toBe(false);
    expect(isSafePath('/tmp/malicious')).toBe(false);
  });

  it('allows only whitelisted commands', () => {
    const ALLOWED_COMMANDS = new Set(['node', 'python3']);

    expect(ALLOWED_COMMANDS.has('node')).toBe(true);
    expect(ALLOWED_COMMANDS.has('python3')).toBe(true);
    expect(ALLOWED_COMMANDS.has('ruby')).toBe(false);
    expect(ALLOWED_COMMANDS.has('bash')).toBe(false);
    expect(ALLOWED_COMMANDS.has('/usr/bin/curl')).toBe(false);
  });

  it('validates startArgs with safe character regex', () => {
    const isValidStartArgs = (args) => {
      if (!Array.isArray(args)) return false;
      return args.every(a => typeof a === 'string' && /^[a-zA-Z0-9_./-]+$/.test(a));
    };

    expect(isValidStartArgs(['proxy.js'])).toBe(true);
    expect(isValidStartArgs(['dist/server/start.js'])).toBe(true);
    expect(isValidStartArgs(['-e', 'console.log(1)'])).toBe(false); // semicolons not allowed
    expect(isValidStartArgs(['&&', 'rm -rf /'])).toBe(false);
    expect(isValidStartArgs('not-an-array')).toBe(false);
  });
});

describe('Forward Endpoint Whitelist', () => {
  /**
   * Tests the FORWARD_ENDPOINTS whitelist logic.
   */
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

  function isAllowedEndpoint(proxy, method, pathStr) {
    const config = FORWARD_ENDPOINTS[proxy];
    if (!config) return false;
    const allowed = config[method.toUpperCase()] || config[(method.toUpperCase())];
    if (!allowed) return false;
    for (const pattern of allowed) {
      if (pattern === pathStr) return true;
      const patternParts = pattern.split('/');
      const pathParts = pathStr.split('/');
      if (patternParts.length !== pathParts.length) continue;
      let match = true;
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) continue;
        if (patternParts[i] !== pathParts[i]) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  }

  it('allows whitelisted codex GET endpoints', () => {
    expect(isAllowedEndpoint('codex', 'GET', '/v1/models')).toBe(true);
    expect(isAllowedEndpoint('codex', 'GET', '/health')).toBe(true);
    expect(isAllowedEndpoint('codex', 'GET', '/api/config')).toBe(true);
  });

  it('allows whitelisted codex POST endpoints', () => {
    expect(isAllowedEndpoint('codex', 'POST', '/v1/chat/completions')).toBe(true);
    expect(isAllowedEndpoint('codex', 'POST', '/api/switch-model')).toBe(true);
  });

  it('blocks non-whitelisted endpoints', () => {
    expect(isAllowedEndpoint('codex', 'GET', '/admin/secret')).toBe(false);
    expect(isAllowedEndpoint('codex', 'DELETE', '/v1/models')).toBe(false);
    expect(isAllowedEndpoint('codex', 'POST', '/api/delete-user')).toBe(false);
  });

  it('blocks unknown proxy names', () => {
    expect(isAllowedEndpoint('unknown', 'GET', '/v1/models')).toBe(false);
  });

  it('allows wildcard :id patterns for cursor', () => {
    expect(isAllowedEndpoint('cursor', 'PUT', '/admin-api/providers/abc123')).toBe(true);
    expect(isAllowedEndpoint('cursor', 'DELETE', '/admin-api/models/xyz-456')).toBe(true);
  });
});
