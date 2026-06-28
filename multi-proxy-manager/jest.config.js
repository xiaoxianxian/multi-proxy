module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
  roots: ['<rootDir>'],
  moduleNameMapper: {
    "^../server$": "<rootDir>/server",
  },
  clearMocks: true,
  coverageThreshold: { global: { branches: 60, functions: 70, lines: 70 } },
};
