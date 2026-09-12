/**
 * 回归测试：锁住 D8 不变式——getNextProviderIndex 仅在 round-robin 模式推进 rr_index。
 *
 * 历史误判（2026-09-13 上轮）：曾断言「priority 模式热路径每个请求都把 rr_index 写进 DB 并
 * 推进（无条件推进）」。核对 chatHandler.ts 后推翻了该断言：
 *   - L21  getNextProviderIndex 内有 `if (mode !== 'round-robin') return 0;`，写到 L26 前即返回
 *   - L39  findProviderConfig 仅在 `if (mode === 'round-robin')` 分支才调 getNextProviderIndex
 *   → 双重保护，priority/failover 模式根本不碰 rr_index。
 *
 * 本测试锁定该不变式，三组：
 *   1. priority 模式：多次 findProviderConfig 不推进 rr_index + 同一 provider（确定性，不轮转）
 *   2. failover 模式：同上，不推进 rr_index
 *   3. round-robin 模式（对照组）：rr_index 才推进——证明 guard 是「模式选择性放行」而非「死写」
 *
 * 纪律：读真实 DB（daily-driver 单例），beforeEach/afterEach 还原 routing_mode + rr_index，
 * 测试跑完不留任何污染。
 */
import { jest } from '@jest/globals';
import { db } from '../../src/db/database.js';
import { findProviderConfig } from '../../src/server/handlers/chatHandler.js';

function getRrIndex(): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'rr_index'").get() as any;
  return row ? parseInt(String(row.value), 10) : 0;
}

function setRoutingMode(mode: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
    .run('routing_mode', mode, 'string');
}

describe('D8 回归：仅 round-robin 模式推进 rr_index', () => {
  let savedMode: string | undefined;
  let savedIndex: number;

  beforeEach(() => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'routing_mode'").get() as any;
    savedMode = row ? String(row.value) : undefined;
    savedIndex = getRrIndex();
  });

  afterEach(() => {
    if (savedMode === undefined) {
      db.prepare("DELETE FROM settings WHERE key = 'routing_mode'").run();
    } else {
      setRoutingMode(savedMode);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
      .run('rr_index', String(savedIndex), 'string');
    jest.resetAllMocks();
  });

  it('priority 模式：多次 findProviderConfig 不推进 rr_index 且落同一 provider', () => {
    setRoutingMode('priority');
    const before = getRrIndex();
    const a = findProviderConfig('qwen3.8-flash');
    const b = findProviderConfig('qwen3.8-flash');
    const c = findProviderConfig('qwen3.8-flash');
    expect(getRrIndex()).toBe(before);
    expect(a).not.toBeNull();
    expect(a!.providerId).toBe(b!.providerId);
    expect(a!.providerId).toBe(c!.providerId); // 确定性同一 provider，不轮转
  });

  it('failover 模式：不推进 rr_index', () => {
    setRoutingMode('failover');
    const before = getRrIndex();
    findProviderConfig('qwen3.8-flash');
    findProviderConfig('qwen3.8-flash');
    expect(getRrIndex()).toBe(before);
  });

  it('round-robin 模式（对照）：findProviderConfig 才推进 rr_index，证明 guard 是选择性放行', () => {
    setRoutingMode('round-robin');
    const enabledCount = (db.prepare(
      "SELECT COUNT(*) AS c FROM providers WHERE enabled = 1",
    ).get() as any).c as number;
    if (enabledCount >= 2) {
      const before = getRrIndex();
      findProviderConfig('qwen3.8-flash'); // 触发 getNextProviderIndex：current 返回、next 已写
      expect(getRrIndex()).not.toBe(before);
    } else {
      // 现实 DB 应 >=2 家 enabled；若 <2 则 next==current，不推进，此 case 跳过
      expect(enabledCount).toBeLessThan(2);
    }
  });
});
