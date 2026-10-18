// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * E2E MATRIX globalSetup (10-19).
 *
 * Playwright 1.63.0: 静态 `env:` 块（顶层 + 项目级）都到不了 test worker
 * （探针证实，见 MEMORY-2026-10-19.md「修复方案」）。官方模式：globalSetup
 * 里改 process.env —— runner fork 出的 worker 继承，webServer 子进程经
 * env 合并同样继承，server 与 worker 一致。
 *
 * 安全红线：只认 throwaway HOME，绝不碰 ~/.multi-proxy-manager 真凭据。
 */
const path = require('path');
const os = require('os');

module.exports = async function globalSetup() {
  // 与 pw-e2e-matrix.config.js 同逻辑：外部传 MP_TEST_HOME/PORT 则尊重，否则默认 throwaway。
  const THROW = process.env.MP_TEST_HOME || path.join(os.homedir(), 'mpi-throwaway-1016');
  const PORT = process.env.MP_TEST_PORT || '18801';
  const BASE = `http://127.0.0.1:${PORT}`;
  Object.assign(process.env, {
    HOME: THROW,
    MP_TEST_HOME: THROW,
    MP_CONSENT_BYPASS: '1',
    BASE_URL: BASE,
    MP_TEST_PORT: PORT,
    // P1 enabler: 关服务端限流/锁死(全按 req.ip=127.0.0.1 计 key)。50 test 共一个登录 key。
    // 生产不设这些 env → 默认 5/60s·5/15min 不变。
    AUTH_RATE_MAX: '100000',
    AUTH_RATE_WINDOW_MS: '60000',
    AUTH_LOCKOUT_MAX: '100000',
    AUTH_LOCKOUT_WINDOW_MS: '9999999',
  });
};
