/**
 * Tests for real process management using child_process.spawn().
 *
 * These tests spawn actual node processes to verify:
 * - spawnProxy-like functionality works with real OS processes
 * - stopProxy (SIGTERM) terminates processes correctly
 * - waitForPortBound/waitForPortFree behave properly
 *
 * Note: These use real child_process.spawn() but test with lightweight
 * echo/print scripts — not the actual proxy servers — to keep CI fast.
 */

const { spawn } = require('child_process');
const { createServer } = require('http');
const net = require('net');

const { execSync } = require('child_process');

// TE5: lsof-based port check matching production code.
// If lsof is unavailable, fall back to net.Socket.
let _lsofAvailable = null;
function _checkLsofAvailable() {
  if (_lsofAvailable === null) {
    try {
      execSync('lsof -v', { stdio: 'ignore' });
      _lsofAvailable = true;
    } catch (e) {
      _lsofAvailable = false;
    }
  }
  return _lsofAvailable;
}
function isPortInUseViaLsof(port) {
  if (_checkLsofAvailable()) {
    try {
      execSync(`lsof -i :${port}`, { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }
  // Fallback: net.Socket check
  try {
    const net = require('net');
    const socket = new net.Socket();
    const started = socket.connect(port, '127.0.0.1', () => { socket.destroy(); });
    socket.end();
    return false;
  } catch (_) {
    return false;
  }
}

// ==================== Port helpers ====================

// TE5: lsof/ss-based port detection matching production code
// Falls back to net.Socket if neither lsof nor ss is available
function waitForPortBound(port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (isPortInUseViaLsof(port)) {
        resolve(true);
      } else if (Date.now() - start < timeout) {
        setTimeout(check, 200);
      } else {
        // Final fallback: try net.Socket
        const net = require('net');
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => { socket.destroy(); resolve(false); });
        socket.connect(port, '127.0.0.1', () => {
          socket.destroy();
          resolve(true);
        });
      }
    };
    check();
  });
}

function waitForPortFree(port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const socket = new net.Socket();
      const onFree = () => {
        socket.destroy();
        resolve(true); // Port is free
      };
      socket.setTimeout(1000);
      socket.on('timeout', onFree);
      socket.on('error', onFree);
      socket.connect(port, '127.0.0.1', () => {
        socket.destroy();
        if (Date.now() - start < timeout) {
          setTimeout(check, 200);
        } else {
          resolve(false);
        }
      });
    };
    check();
  });
}

// ==================== Tests ====================

describe('Process Management', () => {
  describe('spawn real process', () => {
    it('spawns a process that outputs data', async () => {
      const receivedOutput = [];

      const proc = spawn('node', ['-e', 'console.log("hello from child")'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (chunk) => {
        receivedOutput.push(chunk.toString());
      });

      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
      });

      expect(exitCode).toBe(0);
      expect(receivedOutput.some((o) => o.includes('hello from child'))).toBe(true);
    });

    it('spawns a process that listens on a port', async () => {
      const proc = spawn('node', [
        '-e',
        `
        const http = require('http');
        const s = http.createServer((req, res) => {
          res.writeHead(200);
          res.end('ok');
        });
        s.listen(19999, '127.0.0.1', () => {
          console.log('listening on 19999');
        });
        process.once('SIGTERM', () => {
          s.close(() => process.exit(0));
        });
        `,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      try {
        // Wait for port to become bound
        const bound = await waitForPortBound(19999, 3000);
        expect(bound).toBe(true);
      } finally {
        proc.kill('SIGTERM');
        await new Promise((resolve) => proc.on('close', resolve));
      }
    });
  });

  describe('stop via SIGTERM', () => {
    it('terminates process with SIGTERM', async () => {
      const proc = spawn('node', [
        '-e',
        'process.on("SIGTERM", () => process.exit(0));\nsetTimeout(() => {}, 60000);',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Give the process time to start
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Kill with SIGTERM
      proc.kill('SIGTERM');

      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
      });

      // Process exits with 0 (handled SIGTERM) or 128+15=143 (unhandled)
      expect([0, 143]).toContain(exitCode);
    });

    it('does not throw when killing non-existent process', () => {
      const proc = spawn('node', ['-e', 'process.exit(0);']);
      // Wait for process to exit, then kill again
      proc.on('close', () => {
        expect(() => proc.kill('SIGTERM')).not.toThrow();
      });
    });
  });

  describe('waitForPortBound', () => {
    let server;

    afterEach(async () => {
      if (server) {
        server.close();
        await new Promise((resolve) => server?.once('close', resolve));
      }
    });

    it('returns true when port becomes bound', async () => {
      server = createServer((req, res) => res.end('ok'));

      // Port should be free initially
      const free = await waitForPortBound(19998, 1500);
      expect(free).toBe(false);

      // Start listening
      await new Promise((resolve) => server.listen(19998, '127.0.0.1', resolve));

      // Should detect port is now bound
      const bound = await waitForPortBound(19998, 2000);
      expect(bound).toBe(true);
    });

    it('returns false on timeout when port never binds', async () => {
      const bound = await waitForPortBound(19997, 1000);
      expect(bound).toBe(false);
    });
  });

  describe('waitForPortFree', () => {
    let server;

    afterEach(async () => {
      if (server) {
        server.close();
        await new Promise((resolve) => server?.once('close', resolve));
      }
    });

    it('returns true when port becomes free', async () => {
      server = createServer((req, res) => res.end('ok'));

      await new Promise((resolve) => server.listen(19996, '127.0.0.1', resolve));

      // Port should be bound
      const bound = await waitForPortBound(19996, 2000);
      expect(bound).toBe(true);

      // Close the server
      await new Promise((resolve) => server.close(resolve));

      // Wait for port to become free
      const freed = await waitForPortFree(19996, 3000);
      expect(freed).toBe(true);
    });

    it('returns false when port stays occupied', async () => {
      server = createServer((req, res) => res.end('ok'));
      await new Promise((resolve) => server.listen(19995, '127.0.0.1', resolve));

      // Port should stay bound — should timeout
      const freed = await waitForPortFree(19995, 1000);
      expect(freed).toBe(false);
    });
  });
});
