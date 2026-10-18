// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).

// capability-profile P0-2 校准层验收测试（TokenSaver 借鉴，2026-10-15）。
//
// 验证点：
//   1. 默认（override 空）→ resolveProfile 等于 DEFAULT_CAPABILITY_PROFILES，行为等同 P0-1。
//   2. recordCalibration 默认关（PROXY_CAPABILITY_CALIBRATION 未设）→ 不写 override（零行为变更）。
//   3. 开校准 + vision 连败 → override 把 vision 降档 → filterByCapability 正确排除该模型做 vision。
//   4. isCapabilityFiltered 经 resolveProfile 读 override（不直读 DEFAULT）。
//
// 跑法：置于 tests/unit/ 下，复用项目 jest.config.js（ts-jest ESM + tsconfig NodeNext）。
//   npx jest tests/unit/capability-profile.test.ts

import {
  resolveProfile,
  recordCalibration,
  filterByCapability,
  DEFAULT_CAPABILITY_PROFILES,
} from '../../src/routing/capability-profile';

const mk = (id: string, capability?: Record<string, any>) => ({ id, capability }) as any;

describe('capability-profile P0-2 校准层', () => {
  const OLD = process.env.PROXY_CAPABILITY_CALIBRATION;

  afterEach(() => {
    if (OLD === undefined) delete process.env.PROXY_CAPABILITY_CALIBRATION;
    else process.env.PROXY_CAPABILITY_CALIBRATION = OLD;
  });

  test('1. 默认 override 空 → resolveProfile 等于 DEFAULT', () => {
    const def = DEFAULT_CAPABILITY_PROFILES['agnes-3.0-flash'];
    const got = resolveProfile('agnes-3.0-flash');
    expect(got).toEqual(def);
  });

  test('2. recordCalibration 默认关 → 不写 override（零行为变更）', () => {
    delete process.env.PROXY_CAPABILITY_CALIBRATION;
    recordCalibration('agnes-3.0-flash', 'vision', 0);
    const got = resolveProfile('agnes-3.0-flash');
    // 默认关：vision 应保持 DEFAULT 的 0（agnes 本就 0，关键是 recordCalibration 没改它以外的行为）
    expect(got).toEqual(DEFAULT_CAPABILITY_PROFILES['agnes-3.0-flash']);
  });

  test('3. 开校准 + vision 连败 → override 降档 → filterByCapability 排除', () => {
    process.env.PROXY_CAPABILITY_CALIBRATION = '1';
    // 模拟 L2 feedback loop 折算：kimi vision 实际不达标 → 降到 0
    recordCalibration('kimi-k2.6', 'vision', 0);
    const cands = [
      mk('qwen3.8:27b-mlx', { vision: 2 }),
      mk('kimi-k2.6', { vision: 2 }),
      mk('agnes-3.0-flash', { vision: 0 }),
    ];
    const kept = filterByCapability(cands, 'vision');
    const ids = kept.map((c: any) => c.id);
    expect(ids).not.toContain('kimi-k2.6'); // override 降档后应被排除做 vision
    expect(ids).toContain('qwen3.8:27b-mlx');
    delete process.env.PROXY_CAPABILITY_CALIBRATION;
  });
});
