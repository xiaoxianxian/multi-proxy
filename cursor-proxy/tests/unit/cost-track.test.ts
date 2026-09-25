/**
 * Q3 P1-B 成本闭环 · costTrack 持久化层 + 门控测试
 *
 * 核心断言（门控非侵入 + 实采落盘 + 读 API）：
 *   A. 门控默认关：enabled()=false，accumulate 零写盘（热路径零开销的证据）。
 *   B. 门控开（1/true/on）：accumulate 落盘一条含 cache 实采值的 record；关→零写盘（双向证据）。
 *   C. getDailyCost：读 SUM 聚合（byProvider + totalCny + day）；缺文件→空 0 汇总（不产假值）。
 *   D. resolvePricing：L0 单一真相源（cache-aware）+ PROXY_PRICING_<proxy> env 覆盖 + 未知模型 0 价。
 *
 * 非侵入：afterEach 复位 PROXY_CURSOR_COST / PROXY_PRICING_*，tmp 文件落隔离路径（PROXY_CURSOR_COST_LOG）。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  enabled,
  accumulate,
  getDailyCost,
  resolvePricing,
  __internals,
} from '../../src/monitoring/costTrack.js';

// 每个用例用独立 tmp 文件 + 复位门控，避免跨用例/跨套件串扰
let tmpFile = '';

function freshTmpFile() {
  const f = path.join(
    os.tmpdir(),
    'cursor-cost-test-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.jsonl',
    );
  process.env.PROXY_CURSOR_COST_LOG = f;
  return f;
}

beforeEach(() => {
  tmpFile = freshTmpFile();
  delete process.env.PROXY_PRICING_DEEPSEEK;
  delete process.env.PROXY_COST_TRACK;    // 与本模块无关，防串扰
});

afterEach(() => {
  delete process.env.PROXY_CURSOR_COST;
  delete process.env.PROXY_PRICING_DEEPSEEK;
  delete process.env.PROXY_CURSOR_COST_LOG;
  try { fs.rmSync(tmpFile, { force: true }); } catch { /* noop */ }
  try { fs.rmSync(tmpFile + '.tmp', { force: true }); } catch { /* noop */ }
  });

describe('Q3 costTrack · 门控（非侵入）', () => {
  it('默认关：enabled()=false', () => {
    expect(enabled()).toBe(false);
    });

  it('=1/true/on 开；其它写法关', () => {
    for (const v of ['1', 'true', 'on', '1 ', ' ON ']) {
      process.env.PROXY_CURSOR_COST = v;
      expect(enabled()).toBe(true);
      }
    for (const v of ['0', 'false', 'no', '', undefined]) {
      process.env.PROXY_CURSOR_COST = v;
      expect(enabled()).toBe(false);
      }
  });

  it('门控关 → accumulate 零写盘（热路径零开销证据）', () => {
    accumulate('deepseek', 'deepseek-v4-pro',
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      { input: 0.5, output: 3, cacheHit: 0.02 });
    expect(fs.existsSync(tmpFile)).toBe(false);       // 零写盘
    });
});

describe('Q3 costTrack · 门控开 → 实采落盘', () => {
  it('开 + 3 家不同模型 → 落盘 3 条 + getDailyCost 聚合正确', () => {
    process.env.PROXY_CURSOR_COST = '1';
    const today = __internals.dayKey(new Date());

    // deepseek-v4-pro（L0 价 input=0.5/output=3/cacheHit=0.02，无命中）
    accumulate('deepseek', 'deepseek-v4-pro', { prompt_tokens: 1_000_000, completion_tokens: 0 }, { input: 0.5, output: 3, cacheHit: 0.02 });
    // kimi-k2.6（input=6.5/output=27/cacheHit=1.3）含 0.8M 命中
    accumulate('kimi', 'kimi-k2.6',
      { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 800_000 },
      { input: 6.5, output: 27, cacheHit: 1.3 });
    // qwen 本地模型 0 价
    accumulate('ollama', 'qwen3.8:27b-mlx', { prompt_tokens: 999, completion_tokens: 999 }, { input: 0, output: 0 });

    // 落盘 3 行
    const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);

    const rec0 = JSON.parse(lines[0]);
    expect(rec0.source).toBe('actual');
    expect(rec0.day).toBe(today);
    expect(rec0.provider).toBe('deepseek');
    expect(rec0.inputTokens).toBe(1_000_000);
    expect(rec0.cacheReadTokens).toBe(0);

    // getDailyCost 聚合
    const s = getDailyCost(undefined, { file: tmpFile });
    expect(s.day).toBe(today);
    expect(s.source).toBe('actual');
    expect(s.requestCount).toBe(3);
    expect(Object.keys(s.byProvider).sort()).toEqual(['deepseek', 'kimi', 'ollama']);

     // deepseek 1M×0.5 = 0.5；kimi 非缓存0.2M×6.5=1.3 + 0.5M×27=13.5 + 0.8M×1.3=1.04 = 15.84；ollama=0
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    expect(round(s.byProvider.deepseek.totalCny)).toBe(0.5);
    expect(round(s.byProvider['kimi'].totalCny)).toBe(15.84);
    expect(s.byProvider.ollama.totalCny).toBe(0);
    expect(round(s.totalCny)).toBe(round(0.5 + 15.84));    // 16.34
     });

  it('cache 实采落盘：命中部分按 cacheHit 价（非缓存 input 不计命中）', () => {
    process.env.PROXY_CURSOR_COST = '1';
    // kimi 价 6.5/27/1.3：1M input 含 0.8M 命中 + 0.3M output
    // 非缓存 input = 0.2M×6.5=1.3；输出 0.3M×27=8.1；命中 0.8M×1.3=1.04 → 10.44
    accumulate('kimi', 'kimi-k2.6',
      { input_tokens: 1_000_000, output_tokens: 300_000, cache_read_input_tokens: 800_000 },
      { input: 6.5, output: 27, cacheHit: 1.3 });
    const rec = JSON.parse(fs.readFileSync(tmpFile, 'utf8').trim().split('\n')[0]);
    expect(rec.inputTokens).toBe(1_000_000);
    expect(rec.outputTokens).toBe(300_000);
    expect(rec.cacheReadTokens).toBe(800_000);
    expect(Math.round(rec.cost * 1e6) / 1e6).toBe(10.44);
     });

  it('getDailyCost 读按 day 过滤（跨天不混）', () => {
     process.env.PROXY_CURSOR_COST = '1';
    const today = __internals.dayKey(new Date());
    const yesterday = __internals.dayKey(new Date(Date.now() - 86400_000));
    accumulate('deepseek', 'deepseek-v4-pro', { prompt_tokens: 1_000_000, completion_tokens: 0 }, { input: 0.5, output: 3 });
    // 手工塞一条昨天
    fs.appendFileSync(tmpFile, JSON.stringify({ ts: 'x', day: yesterday, provider: 'deepseek', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 9.9, source: 'actual' }) + '\n');

    expect(getDailyCost(today, { file: tmpFile }).requestCount).toBe(1);
    expect(getDailyCost(today, { file: tmpFile }).totalCny).toBe(0.5);
    expect(getDailyCost(yesterday, { file: tmpFile }).totalCny).toBe(9.9);
     });
});

describe('Q3 costTrack · 读 API 容错', () => {
  it('缺文件 → 空 0 汇总（不产假值）', () => {
    const s = getDailyCost(undefined, { file: path.join(os.tmpdir(), 'nonexistent-' + Math.random() + '.jsonl') });
    expect(s.requestCount).toBe(0);
    expect(s.totalCny).toBe(0);
    expect(s.byProvider).toEqual({});
    });

  it('损坏行跳过（不崩）', () => {
    const bad = path.join(os.tmpdir(), 'cursor-cost-bad-' + Math.random() + '.jsonl');
    fs.writeFileSync(bad, 'not-json\n' + JSON.stringify({ ts: 'x', day: __internals.dayKey(new Date()), provider: 'p', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0.5, source: 'actual' }) + '\n');
    const s = getDailyCost(undefined, { file: bad });
    expect(s.requestCount).toBe(1);
    expect(s.totalCny).toBe(0.5);
     fs.unlinkSync(bad);
    });
});

describe('Q3 costTrack · resolvePricing（价源）', () => {
  it('L0 单一真相源：deepseek-v4-pro → 含 cacheHit 的真实价', () => {
    const p = resolvePricing('deepseek-v4-pro');
    expect(p.input).toBe(0.5);
    expect(p.output).toBe(3);
    expect(p.cacheHit).toBe(0.02);
    });

  it('kimi-k2.6 → L0 6.5/27/1.3', () => {
    const p = resolvePricing('kimi-k2.6');
    expect(p.input).toBe(6.5);
    expect(p.output).toBe(27);
    expect(p.cacheHit).toBe(1.3);
     });

  it('PROXY_PRICING_<proxy> env 覆盖 L0', () => {
    process.env.PROXY_PRICING_DEEPSEEK = JSON.stringify({ input: 9, output: 9, cacheHit: 0 });
    const p = resolvePricing('deepseek-v4-pro', 'deepseek');  // env key 'PROXY_PRICING_'+'deepseek'.toUpperCase()='DEEPSEEK'
    expect(p.input).toBe(9);
      });

  it('未知模型 → 0 价（不产假值，本地/新模型安全退化）', () => {
    const p = resolvePricing('some-brand-new-model-not-in-L0');
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
    });
});