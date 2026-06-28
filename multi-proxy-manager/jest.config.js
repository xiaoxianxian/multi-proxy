module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
  roots: ['<rootDir>'],
  moduleNameMapper: {
    "^../server$": "<rootDir>/server",
  },
  forceExit: true,
  clearMocks: true,
};
