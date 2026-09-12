/**
 * M4 方向三：error-patterns 边界/持久化回归测试。
 *
 * 针对 5753b5e「mock 掩盖生产缺陷」这类——现有 error-patterns.test.js 用
 * resetErrorPatterns + 内存 setPatterns + persist:false，从未触碰真实磁盘，
 * 因此下列三类 fs/持久化边界零覆盖：
 *   A. 磁盘 error-patterns.json 与种子合并（loadPatterns 的 try/merge 路径）
 *   B. 磁盘 pattern 文件损坏时不丢种子（catch 静默 + 种子先于 try 赋值）
 *   C. appendHistory 计数触发式裁剪（每 500 次一次 trim，无写放大）
 *
 * 模块用可注入文件路径（setPatternFile / setHistoryFile），非构造器 DI；
 * 全部写 tmp 目录，绝不污染真实 ~/.multi-proxy-manager。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ep = require('../../lib/error-patterns');

const seedCount = ep.SEED_PATTERNS.length;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ep-edge-'));
}

describe('error-patterns — 磁盘合并（A）', () => {
  test('磁盘 pattern 数组合并进种子，新 id 追加 + 已有 id 字段覆盖', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'pattern.json');
    fs.writeFileSync(file, JSON.stringify([
      { id: 'user-x', pattern: 'userx', resolution: 'user custom', first_seen: '2026-01-01' },
      { id: 'better-sqlite3-mismatch', resolution: 'OVERRIDE resolution' },
    ]));

    ep.setPatternFile(file);
    ep.resetErrorPatterns();
    ep.loadPatterns();

    const merged = ep.getPatterns();
    // 8 种子 + 1 新 id(user-x) + 1 已存在覆盖(不新增) = 9
    expect(merged).toHaveLength(seedCount + 1);
    expect(merged.some((p) => p.id === 'user-x')).toBe(true);
    // 已存在 id 的字段被磁盘覆盖
    const sql = merged.find((p) => p.id === 'better-sqlite3-mismatch');
    expect(sql.resolution).toBe('OVERRIDE resolution');
    // 种子仍全在（合并不丢种子）
    expect(merged.every((p) => ep.SEED_PATTERNS.some((s) => s.id === p.id) || p.id === 'user-x')).toBe(true);
  });

  test('磁盘文件非数组时不影响种子加载', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'pattern.json');
    fs.writeFileSync(file, JSON.stringify({ not: 'an array' }));

    ep.setPatternFile(file);
    ep.resetErrorPatterns();
    ep.loadPatterns();

    expect(ep.getPatterns()).toHaveLength(seedCount);
  });
});

describe('error-patterns — 损坏文件容错（B）', () => {
  test('error-patterns.json 损坏时，loadPatterns 静默跳过且不丢种子', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'pattern.json');
    fs.writeFileSync(file, '{ this is not valid json ]');

    ep.setPatternFile(file);
    ep.resetErrorPatterns();
    ep.loadPatterns();

    const merged = ep.getPatterns();
    expect(merged).toHaveLength(seedCount); // 不丢种子
    expect(merged.some((p) => p.id === 'better-sqlite3-mismatch')).toBe(true);
    // 种子本身仍能匹配真实错误文案
    expect(ep.matchError('The module better-sqlite3 was compiled against a different Node.js version')).not.toBeNull();
  });
});

describe('error-patterns — 历史裁剪（C）', () => {
  test('appendHistory 计数触发式裁剪：超过 MAX(2000) 行裁到 ≤2000，原子写无 .tmp 残骸，最新保留', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'history.jsonl');
    ep.setPatternFile(path.join(tmpDir(), 'pattern.json')); // 隔离频次文件
    ep.setHistoryFile(file); // linesSinceTrim 归零

      // pre-seed 2000 行（= MAX），trim 触发时文件 2500 行 > 2000 → 真裁到 2000
      const preLines = [];
      for (let i = 0; i < 2000; i++) preLines.push(JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', proxy: 'old', level: 'ERROR', error_type: 'old', pattern_id: null }));
      fs.writeFileSync(file, preLines.join('\n') + '\n');

      // 500 次 append → 第 500 次 linesSinceTrim 满触发一次 trim（此刻文件 2500 行 > 2000 → 裁到 2000）
    for (let i = 0; i < 500; i++) {
      ep.recordError({ proxy: 'cursor', rawMessage: 'ECONNREFUSED ' + i, ts: `2026-09-09T00:00:${String(i % 60).padStart(2, '0')}.000Z`, persist: true });
      }

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      // 裁剪正确：裁到 MAX_HISTORY_LINES(2000)，不涨到 2100
    expect(lines.length).toBeLessThanOrEqual(2000);
    expect(lines.length).toBe(2000);
    // 原子写收尾：无 .tmp 残骸
    expect(fs.existsSync(file + '.tmp')).toBe(false);
    // 最新条目保留在文件末尾
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.proxy).toBe('cursor');
    // 文件始终可逐行解析（不撕裂）
    lines.forEach((l) => expect(() => JSON.parse(l)).not.toThrow());
  });

  test('500 次 append 未超 MAX 时不裁剪，文件行数 = 500（write-amplification 修复回归）', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'history.jsonl');
    ep.setPatternFile(path.join(tmpDir(), 'pattern.json'));
    ep.setHistoryFile(file);
    fs.writeFileSync(file, ''); // 空起点

    for (let i = 0; i < 500; i++) {
      ep.recordError({ proxy: 'codex', rawMessage: 'ETIMEDOUT', ts: `2026-01-01T00:00:00.000Z`, persist: true });
    }
    // 恰好 500，未触发裁剪（500 不 > 500），全部保留
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(500);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });
});
