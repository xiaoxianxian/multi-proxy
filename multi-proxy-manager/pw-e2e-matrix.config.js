// multi-proxy — E2E MATRIX (50-case) isolated harness config
// Authored for the 10-16 RESUME-MATRIX-REGEN task. Runs the stale 50-case
// tests/e2e suite in a THROWAWAY HOME + non-production port so it can never
// touch the real ~/.multi-proxy-manager/*. See DANGER.md.
//
// Isolation recipe (proven safe, 07:xx 10-16 isolation run):
//   1) worktree at HEAD + symlink node_modules
//   2) MP_TEST_HOME = throwaway HOME (rm-guard + server auth store both land here)
//   3) BASE_URL = 127.0.0.1:18801 (NOT 18792 prod)
//   4) MP_CONSENT_BYPASS=1 (page-only; API stays non-invasive)
//   5) channel:'chrome' (system Chrome, no 182MB download)
const { defineConfig } = require('@playwright/test');
const path = require('path');
const os = require('os');

const THROW = process.env.MP_TEST_HOME || path.join(os.homedir(), 'mpi-throwaway-1016');
const PORT = process.env.MP_TEST_PORT || '18801';
const BASE = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  // Only the matrix; the e2e/ real-browser smoke specs are a SEPARATE matrix.
  testDir: path.resolve(__dirname, 'tests', 'e2e'),
  testMatch: '**/*.test.ts',
  // Per-file sequential (each file has its own login/setup cascade); shard at CLI.
  fullyParallel: false,
  workers: process.env.MP_WORKERS ? parseInt(process.env.MP_WORKERS, 10) : 1,
  timeout: 30000,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'matrix-results/matrix.json' }],
  ],
  outputFolder: 'matrix-results',
  // 10-19: 1.63.0 静态 env 块（顶层+项目级）到不了 worker（探针证实）；
  // globalSetup 改 runner 的 process.env，worker fork 后继承。
  globalSetup: path.join(__dirname, 'pw-e2e-matrix.setup.js'),
  // 探针文件仅供 pw-e2e-probe.config.js 使用；矩阵 50 条不含它。
  testIgnore: ['__probe__.test.ts'],
  // Test workers: throwaway HOME + guard + non-prod port.
  // NB: Playwright 1.63.0 NEITHER top-level NOR project-level static `env`
  // blocks reach test workers (probe-verified 10-19: worker MP_TEST_HOME was
  // undefined in both runs; TestProject type has no `env` key). Worker env is
  // injected by globalSetup (pw-e2e-matrix.setup.js, see above); server-side
  // env comes from webServer.env. The project-level `env` below is kept inert
  // as documentation / forward-compat only.
  use: {
    baseURL: BASE,
    actionTimeout: 10000,
    navigationTimeout: 15000,
    headless: true,
    channel: 'chrome', // system Chrome — avoids the 182MB chromium download
    trace: 'on-first-retry',
  },
  // Server: throwaway HOME so its password/agent-token land in the throwaway,
  // never the real ~/.multi-proxy-manager. MP_CONSENT_BYPASS keeps the first-launch
  // consent page from redirecting /login.html and friends.
  webServer: {
    command: `HOME=${THROW} MP_CONSENT_BYPASS=1 PORT=${PORT} node server.js`,
    cwd: __dirname, // multi-proxy-manager/
    url: `${BASE}/api/auth/status`,
    timeout: 30000,
    reuseExistingServer: true,
    env: { HOME: THROW, MP_TEST_HOME: THROW, MP_CONSENT_BYPASS: '1', AUTH_RATE_MAX: '100000', AUTH_RATE_WINDOW_MS: '60000', AUTH_LOCKOUT_MAX: '100000', AUTH_LOCKOUT_WINDOW_MS: '9999999' },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      // ⚠️ 10-19 探针证实：1.63.0 项目级 env 同样到不了 worker（TestProject
      // 类型无 env 键）；本块保留作文档/前瞻兼容，实际注入走 globalSetup。
      // 下方 AUTH_RATE_* 说明仍有效（关服务端限流参数，服务端经 webServer.env 生效）。
      // 10-19: P1 enabler — 关掉服务端 rate-limit/lockout（都按 req.ip=127.0.0.1 建 key）。
      // 50 条矩阵每条 login 共享同一 key，默认 5/min 立刻 429/lockout。
      // 生产不设这些 env → 默认 5/60s·5/15min 0 改变（§3 门控默认关）。
      env: {
        HOME: THROW,
        MP_TEST_HOME: THROW,
        MP_CONSENT_BYPASS: '1',
        BASE_URL: BASE,
        MP_TEST_PORT: PORT,
        AUTH_RATE_MAX: '100000',
        AUTH_RATE_WINDOW_MS: '60000',
        AUTH_LOCKOUT_MAX: '100000',
        AUTH_LOCKOUT_WINDOW_MS: '9999999',
      },
    },
  ],
});
