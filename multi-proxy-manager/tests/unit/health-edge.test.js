/**
 * M1 方向一：health.js 持久化 fs 边界回归测试。
 *
 * 针对 5753b5e「mock 掩盖生产缺陷」类——现有 health-graph.test.js 的持久化块用
 * os.tmpdir()（恒存在）+ 只断裁剪后「行数区间」，从不触碰：
 *   A. 裁剪原子性：trimHistory 用 tmp→renameSync（原子写），但残骸 .tmp 是否被清
 *      （现有 trim 测试只断行数 [MAX,MAX+500]，不断 .tmp 残骸）
 *   B. ensureDir 干净嵌套目录自动建（现有用 os.tmpdir() 恒存在，mkdir 分支从不触发）
 *   C. 文件不存在 / 空文件 readRecentHealth 返 []、trimHistory 在缺失文件 no-op 不崩
 *
 * health.js 是全栈少数有【原子写】的持久化模块（tmp→rename，同 session-store）——
 * .tmp 残骸断言在此有真实价值。全部写 tmp 目录，绝不污染真实 ~/.multi-proxy-manager。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const health = require('../../lib/health');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'h-edge-'));
}

describe('health — 裁剪原子性（A）', () => {
  test('trimHistory 经 tmp→rename 完成，裁剪后无 .tmp 残骸且文件不撕裂', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'health-history.jsonl');
    health.setHistoryFile(file);

     // 写 MAX+550 行，跨越多个 500 触发点，最后一次 trim 时文件 > MAX → 真裁
    const total = health.MAX_HISTORY_LINES + 550;
    for (let i = 0; i < total; i++) {
      health.persistHealthHistory({ proxy: 'codex', n: i });
      }

    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
     // 原子写收尾：绝不残留 .tmp（崩溃中途也会 rename 收口，不留半文件）
    expect(fs.existsSync(file + '.tmp')).toBe(false);
     // 行数落回 [MAX, MAX+500] 区间（计数触发式保留最后 MAX）
    expect(lines.length).toBeGreaterThanOrEqual(health.MAX_HISTORY_LINES);
    expect(lines.length).toBeLessThanOrEqual(health.MAX_HISTORY_LINES + 500);
     // 文件始终可逐行解析（rename 原子切换，不撕裂）
    lines.forEach((l) => expect(() => JSON.parse(l)).not.toThrow());
     // 最新条目在末尾
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.n).toBe(total - 1);
   });
});

describe('health — ensureDir 干净嵌套目录（B）', () => {
  test('两层嵌套目录不存在时 persist 自动 mkdir recursive + 写入（clean HOME 不 ENOENT）', () => {
    const dir = tmpDir();
    const nested = path.join(dir, 'deep', 'nested'); // 两层均不存在
    const file = path.join(nested, 'health-history.jsonl');
    health.setHistoryFile(file);

     // 目录不存在时不抛（ensureDir 的 mkdir recursive 分支）
    let threw = false;
    try {
      health.persistHealthHistory({ proxy: 'hermes', status: 'degraded', n: 1 });
       } catch (e) {
      threw = true;
       }
    expect(threw).toBe(false);
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
     // 读出可解析
    const recent = health.readRecentHealth(10);
    expect(recent.length).toBe(1);
    expect(recent[0].proxy).toBe('hermes');
   });
});

describe('health — 容错边界（C）', () => {
  test('文件不存在 / 空文件 readRecentHealth 返 []（best-effort 不崩）', () => {
    const dir = tmpDir();

     // 文件不存在
    health.setHistoryFile(path.join(dir, 'nonexistent-history.jsonl'));
    expect(health.readRecentHealth(10)).toEqual([]);

     // 空文件
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    health.setHistoryFile(empty);
    expect(health.readRecentHealth(10)).toEqual([]);
    });

  test('trimHistory 在文件缺失 / 空时 no-op 不崩（best-effort catch）', () => {
    const dir = tmpDir();
    let threw = false;
    try {
      // 文件不存在
      health.setHistoryFile(path.join(dir, 'missing.jsonl'));
      health.trimHistory();
      // 空文件
      const empty = path.join(dir, 'empty2.jsonl');
      fs.writeFileSync(empty, '');
      health.setHistoryFile(empty);
      health.trimHistory();
       } catch (e) {
      threw = true;
       }
    expect(threw).toBe(false);
   });

  test('readRecentHealth 跳过关行坏 JSON 但不崩（整文件容错，非仅行级）', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'health-history.jsonl');
    health.setHistoryFile(file);
    fs.writeFileSync(file,
       JSON.stringify({ proxy: 'codex', n: 1 }) + '\n' +
       '{ this is corrupt json ]xx\n' +
       JSON.stringify({ proxy: 'cursor', n: 3 }) + '\n');
    const recent = health.readRecentHealth(10);
     // 坏行被过滤，两条好行保留（倒序：cursor 在前）
    expect(recent.length).toBe(2);
    expect(recent[0].proxy).toBe('cursor');
    expect(recent[1].proxy).toBe('codex');
   });
});
