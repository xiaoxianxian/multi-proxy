module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
  roots: ['<rootDir>'],
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    "^../server$": "<rootDir>/server",
  },
  clearMocks: true,
  coverageThreshold: { global: { branches: 60, functions: 70, lines: 70 } },
};
