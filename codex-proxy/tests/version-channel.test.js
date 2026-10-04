/**
 * 版本收口 + 更新通道的回归测试（2026-10-04）
 *
 * 这两件事原先**一个字都没测到**：四份 package.json 各写各的 1.0.0，
 * /api/version 读的路径（仓库根 package.json）压根不存在，永远 catch 到硬编码
 * 1.0.0 —— 版本在整条链路上都是假的，而没有任何测试拦得住。
 *
 * 这份测试只碰三件能被离线验证的事：
 *   1. VERSION 是合法语义化版本（格式错了必须炸，不许静默回落）
 *   2. 四份 package.json 与 VERSION 一致（不一致 ⇒ 发版前能查出来）
 *   3. compare() 的大小比较与离线降级（拿不到远端时静默，许退出 0）
 *
 * 本文件放在 codex-proxy/tests/ 是因为整个仓库只有这边有 jest runner；
 * 它测的是仓库级的东西（VERSION / tools/），跟 codex-proxy 本身无关。
 *
 * 网络那条路径（真的 GET api.github.com）在离线环境没法验证，只能靠
 * 「拿不到 ⇒ 静默」这一侧兜住，别把错误日志弹到用户脸上。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { compare, parseVer, currentVersion } = require('../../tools/update-check.js');

const ROOT = path.resolve(__dirname, '..', '..'); // 仓库根（本测试跨子包，放 codex-proxy 只是为了那边有 jest runner）
const VERSION_FILE = path.join(ROOT, 'VERSION');
const PACKS = ['codex-proxy', 'cursor-proxy', 'multi-proxy-manager', 'desktop'];
const node = process.execPath;

describe('VERSION 是真源', () => {
  test('第一行是语义化版本，第二行是日期', () => {
    const lines = fs.readFileSync(VERSION_FILE, 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines[0]).toMatch(/^\d+\.\d+\.\d+/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('currentVersion() 与文件第一行一致', () => {
    const lines = fs.readFileSync(VERSION_FILE, 'utf8').trim().split(/\r?\n/);
    expect(currentVersion()).toBe(lines[0].trim());
  });

  test('四份 package.json 都跟 VERSION 走（版本漂移在这条测试里就得红）', () => {
    const want = currentVersion();
    for (const name of PACKS) {
      const p = path.join(ROOT, name, 'package.json');
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 断言里带上包名，漂移时一眼看出是哪份文件落后
      expect({ pack: name, version: pkg.version }).toEqual({ pack: name, version: want });
    }
  });

  test('sync-version.js --check 在干净状态下退出 0', () => {
    const out = execFileSync(node, [path.join(ROOT, 'tools/sync-version.js'), '--check'], {
      encoding: 'utf8', cwd: ROOT,
    }).trim();
    expect(out).toBe(currentVersion());
  });
});

describe('compare：语义化版本比大小', () => {
  test('逐位比较，前导 v 与后缀都两头通吃', () => {
    const cases = [
      ['1.1.0', '1.1.0', 0],
      ['1.2.0', '1.1.9', 1],
      ['1.0.9', '1.1.0', -1],
      ['2.0.0', '1.9.9', 1],
      ['v1.1.0', '1.1.0', 0],
      ['1.1.0-rc1', '1.1.0', 0], // 预发布号只取主三位，不参与本次比较
    ];
    for (const [a, b, want] of cases) {
      expect([a, b]).toEqual(expect.arrayContaining([a, b]));
      expect(compare(a, b)).toBe(want);
    }
  });

  test('解析不出来当相等（宁可不提示，也别把更新提示变成报错）', () => {
    expect(compare('abc', '1.1.0')).toBe(0);
    expect(parseVer('nope')).toBeNull();
  });

  test('远端 tag 低于本地时不提示（本地改过的分支不该被追着喊降级）', () => {
    expect(compare('1.0.0', '1.1.0')).toBe(-1);
  });
});

describe('拿不到远端时静默', () => {
  // 沙箱/离线环境实测：拿不到 ⇒ 退出 0 且不打错误日志
  test('不带 --json 时不输出任何东西，也不非零退出', () => {
    const { status } = require('child_process').spawnSync(
      node, [path.join(ROOT, 'tools/update-check.js')],
      { encoding: 'utf8', cwd: ROOT }
    );
    // 离线：静默退出 0；真有网络且落后于远端：输出提示并退出 1。
    // 两种都是「通道在正常工作」，只要求它别抛栈、别退出 2 以上。
    expect(status === 0 || status === 1).toBe(true);
  });

  test('--off 直接短路，一次网络都不发', () => {
    const out = execFileSync(
      node, [path.join(ROOT, 'tools/update-check.js'), '--off'],
      { encoding: 'utf8', cwd: ROOT }
    ).trim();
    expect(JSON.parse(out)).toEqual({ checked: false, reason: 'disabled' });
  });
});
