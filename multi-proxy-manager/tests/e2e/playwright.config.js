const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: path.join(__dirname, '.'),
  testMatch: '**/*.test.ts',
  fullyParallel: true,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:18792',
    actionTimeout: 5000,
    navigationTimeout: 10000,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  retries: 0,
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
