// multi-proxy E2E smoke 配置（v1.0 收口，2026-10-16）
// 真浏览器加载 7 个壳页（dashboard/floor/logs/sessions/knowledge/skills/settings），
// 断言「真浏览器里能渲染、不崩」。测试服旁路首启同意门（MP_CONSENT_BYPASS=1）。
// 本机 clash 代理上游失效导致 chromium 下不动，故用「系统 Chrome」（channel: chrome）绕开下载。
// 用法：npx playwright test    （测试服 18801 由 webServer 复用；系统 Chrome 在 /Applications/Google Chrome.app）
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: true,
  workers: 4,
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        // 用本机系统 Chrome，绕开网络下载（当前 clash 代理上游失效）
        channel: 'chrome',
      },
    },
  ],
  webServer: {
    command: 'MP_CONSENT_BYPASS=1 PORT=18801 node server.js',
    url: 'http://localhost:18801/login',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  use: {
    baseURL: 'http://localhost:18801',
    channel: 'chrome',
    headless: true,
  },
});
