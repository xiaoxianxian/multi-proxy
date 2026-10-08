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
  coverageThreshold: { global: { branches: 60, functions: 70, lines: 70 } },
};
