// multi-proxy/cursor-proxy — jest 最小化配置（2026-10-15 补，仅为跑通 TS 单测）。
// 设计：ts-jest 以 isolatedModules 逐文件转译为 CommonJS，不依赖全量 tsconfig / ESM 链路，
//   避免改动项目既有 ESM jest.config.js，也不依赖 ts-jest ESM 预设是否可用。
// 用 `npx jest --config jest.config.cjs <test>` 显式指定本配置运行，绕过自动探测的多配置冲突。

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'es2022',
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          allowJs: true,
          strict: false,
          skipLibCheck: true,
          isolatedModules: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    // 2026-10-18 修正：原正则 ^(\.[\\/].*)\.js$ 匹配不了 `../../` 多级相对路径
    // （`.` 后接的是 `.` 不是 `/`），导致 import '../../src/..js' 解析失败、整套路由测试跑不起来。
    // 改为允许 1~2 个前导点 + 分隔符，覆盖 `./` 与 `../`。
    '^(\\.{1,2}[\\\\/].*)\\.js$': '$1',
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
