/**
 * M2 方向二：provider-health 持久化 fs 边界回归测试。
 *
 * 针对 5753b5e「mock 掩盖生产缺陷」类——现有 provider-health.test.js 的
 * round-trip 用 os.tmpdir()（恒存在）+ 内存 save/load，从不触碰：
 *   A. 损坏的 provider-health.json 是否毒化健康表 / require 时 module-init load 是否崩
 *   B. 磁盘混合条目（非对象标量 / 数组 / _recentFailures 非数组）被怎么宽容
 *   C. 干净嵌套目录（clean HOME）下 load/save 是否 ENOENT（ensureDir 的 mkdir 分支）
 *
 * 模块用 setHealthFile 可注入文件路径；load 是 best-effort catch 吞错。
 * 全部写 tmp 目录，绝不污染真实 ~/.multi-proxy-manager。
 *
 * 注：saveProviderHealth 是裸 writeFileSync（无 tmp→rename、无 0600）——
 * 这是全栈 known 约束（logger.js/provider-health.js 均裸写，只有 session-store
 * 等少数有原子写）。本测试不断言原子写/0600 这种不存在的不变量，只锁
 * 「load/save 不崩、不丢不毒化、目录自动建」这些真实不变量。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let ph;
let tmpFile;
let now;

function freshModule(file) {
  delete require.cache[require.resolve('../../lib/provider-health')];
  const m = require('../../lib/provider-health');
  m.resetProviderHealth();
  m.setHealthFile(file);
  m.setClock(() => now);
  m.setHealthConfig({
    failureThreshold: 3,
    isolateDelayMs: 5 * 60 * 1000,
    crossProxyThreshold: 2,
    crossProxyWindowMs: 5 * 60 * 1000,
   });
  return m;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ph-edge-'));
}

beforeEach(() => {
  now = 1_000_000;
});

describe('provider-health — 损坏文件容错（A）', () => {
  test('provider-health.json 损坏时 loadProviderHealth 不抛、健康表不被毒化', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'provider-health.json');
    fs.writeFileSync(file, '{ broken json ]');

    tmpFile = file;
    ph = freshModule(tmpFile);

    let threw = false;
    try {
      ph.loadProviderHealth();
      } catch (e) {
      threw = true;
      }
    expect(threw).toBe(false); // catch 静默吞错，不崩
    expect(ph.getProviderHealth('agnes')).toBeNull(); // 表不被毒化
    expect(ph.listIsolated(now)).toEqual([]);
   });

  test('空文件 / 非对象 json 同样宽容，不崩不毒化', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'provider-health.json');
    fs.writeFileSync(file, ''); // 空文件
    ph = freshModule(file);
    let threw = false;
    try { ph.loadProviderHealth(); } catch (e) { threw = true; }
    expect(threw).toBe(false);
    expect(ph.getProviderHealth('x')).toBeNull();
   });
});

describe('provider-health — 磁盘混合条目宽容（B）', () => {
  test('有效 record 进、非对象标量被拒、数组被 typeof===object 宽松放行、_recentFailures 非数组不污染 recentFailures', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'provider-health.json');
    fs.writeFileSync(file, JSON.stringify({
       good: { providerId: 'good', status: 'unhealthy', consecutiveFailures: 3, unhealthyUntil: 9_999_999_999_999 },
       notObj: 'string record',                  // 标量，typeof !== object → 跳过
       isArr: [1, 2, 3],                          // 数组 typeof === 'object' → 被放行进 health（真实行为）
       noRecent: { providerId: 'noRecent' },      // 有效 record，但无 _recentFailures
       badRecent: { providerId: 'badRecent', _recentFailures: 'not-an-array' }, // record 进、recentFailures 跳过
      }));

    ph = freshModule(file);
    ph.loadProviderHealth();

     // 有效 record 进
    expect(ph.getProviderHealth('good').status).toBe('unhealthy');
     // 标量被拒
    expect(ph.getProviderHealth('notObj')).toBeNull();
     // 数组被宽松放行（typeof [] === 'object'，已知宽松点，非 bug）
    expect(ph.getProviderHealth('isArr')).not.toBeNull();
     // 无 _recentFailures 字段的有效 record 仍进 health
    expect(ph.getProviderHealth('noRecent')).not.toBeNull();
     // _recentFailures 非数组的 record 进 health，但该字段被丢弃（不进 recentFailures）
    expect(ph.getProviderHealth('badRecent')).not.toBeNull();
    expect(ph.correlateCrossProxy('badRecent', now)).toEqual({ verdict: 'single-proxy', sources: [], count: 0 });
   });
});

describe('provider-health — 干净嵌套目录 ensureDir（C）', () => {
  test('三层嵌套目录不存在时 load 不 ENOENT、save 自动建目录', () => {
    const dir = tmpDir();
    const nested = path.join(dir, 'deep', 'nested', 'sub'); // 三层均不存在
    const file = path.join(nested, 'provider-health.json');

    ph = freshModule(file);
     // load 在目录不存在时不抛（ensureDir 的 mkdir recursive 分支 / 或文件不存在直接跳过）
    let threw = false;
    try { ph.loadProviderHealth(); } catch (e) { threw = true; }
    expect(threw).toBe(false);

     // 首次 save：ensureDir 创建 nested 三层目录 + 写入
    ph.recordProbe('agnes', true, { now, source: 'codex' });
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
     // 写出的文件可解析回（不撕裂）
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.agnes.status).toBe('healthy');
   });

  test('ensureDir 后文件可 round-trip 回 load（跨进程恢复不丢，clean HOME 验证）', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'provider-health.json');
    ph = freshModule(file);
    for (let i = 0; i < 3; i++) ph.recordProbe('ds', false, { now: now + i * 1000, source: 'hermes' });
    const rec = ph.getProviderHealth('ds');
    expect(rec.status).toBe('unhealthy');

     // 新模块从同一文件 load 回来
    const ph2 = freshModule(file);
    ph2.loadProviderHealth();
    expect(ph2.getProviderHealth('ds').consecutiveFailures).toBe(3);
   });
});
