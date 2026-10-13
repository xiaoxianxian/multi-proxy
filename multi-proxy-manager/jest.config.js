// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
  roots: ['<rootDir>'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup-afterenv.js'],
  moduleNameMapper: {
    "^../server$": "<rootDir>/server",
  },
  clearMocks: true,
  // 真 HTTP 回环 / Express 启动类用例在内存争抢（Ollama/H3 同机）时偶发 >5s；
  // 提到 30s 吸收正常时序方差，仍可捕获真正的卡死。
  // 交付回归前请先暂停 Ollama/H3，避免极端内存争抢（实测空闲内存<200MB 时偶发>20s）。
  testTimeout: 30000,
  coverageThreshold: { global: { branches: 60, functions: 70, lines: 70 } },
};
