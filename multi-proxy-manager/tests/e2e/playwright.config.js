// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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
  retries: 2,
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
