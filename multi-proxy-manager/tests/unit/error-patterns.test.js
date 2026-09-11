/**
 * M4 方向三：error-patterns 单元测试。
 * 匹配、结构化历史、关键词检索、种子库完整性、持久化；不污染真实 ~/.multi-proxy-manager。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let ep;
let histFile;
let now = '2026-09-11T00:00:00.000Z';

beforeEach(() => {
  histFile = path.join(os.tmpdir(), 'm4-err-history.jsonl');
  try { fs.unlinkSync(histFile); } catch { /* n/a */ }
  ep = require('../../lib/error-patterns');
  ep.resetErrorPatterns();
  ep.loadPatterns();
  ep.setHistoryFile(histFile);
});

describe('种子库完整性', () => {
  test('至少 6 个种子模式，且都来自真实文档（非臆造）', () => {
    expect(ep.SEED_PATTERNS.length).toBeGreaterThanOrEqual(6);
    const ids = ep.SEED_PATTERNS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(['better-sqlite3-mismatch', 'eperm-bind', 'econnrefused-upstream']));
   });

  test('loadPatterns 返回种子，可匹配真实错误文案', () => {
    const m = ep.matchError('The module better-sqlite3 was compiled against a different Node.js version');
    expect(m).not.toBeNull();
    expect(m.id).toBe('better-sqlite3-mismatch');
   });
});

describe('matchError', () => {
  test('ETIMEDOUT → 匹配 etimedout', () => {
    expect(ep.matchError('request ETIMEDOUT after 10s').id).toBe('etimedout');
   });

  test('ECONNREFUSED → 匹配', () => {
    expect(ep.matchError('connect ECONNREFUSED 127.0.0.1:18793').id).toBe('econnrefused-upstream');
   });

  test('端口冲突 EADDRINUSE + cc-switch → 匹配 port-conflict', () => {
    expect(ep.matchError('listen EADDRINUSE: port 15721 in use').id).toBe('port-conflict');
   });

  test('无匹配 → null', () => {
    expect(ep.matchError('something totally unrelated here')).toBeNull();
   });

  test('空/非字符串 → null', () => {
    expect(ep.matchError('')).toBeNull();
    expect(ep.matchError(null)).toBeNull();
    expect(ep.matchError(12345)).toBeNull();
   });

  test('单个 pattern 正则坏掉不影响其它匹配（容错）', () => {
    ep.setPatterns([{ id: 'broken', pattern: '([' }, { id: 'good', pattern: 'foo' }]);
    expect(ep.matchError('bar foo').id).toBe('good');
   });
});

describe('recordError + 结构化历史', () => {
  test('匹配到 pattern → 记录 pattern_id + resolution_hint', () => {
    const e = ep.recordError({ proxy: 'cursor', rawMessage: 'better-sqlite3 ABI mismatch ERROR', now, persist: false });
    expect(e.pattern_id).toBe('better-sqlite3-mismatch');
    expect(e.resolution_hint).toContain('rebuild');
    expect(e.proxy).toBe('cursor');
    expect(e.error_type.length).toBeLessThanOrEqual(80);
   });

  test('无匹配仍记录（pattern_id=null），便于按 proxy 检索', () => {
    const e = ep.recordError({ proxy: 'codex', rawMessage: 'xyz random', now, persist: false });
    expect(e.pattern_id).toBeNull();
    expect(e.proxy).toBe('codex');
   });

  test('落盘 jsonl → 再读得回（round-trip）', () => {
    ep.recordError({ proxy: 'cursor', rawMessage: 'ECONNREFUSED 18793', now, persist: true });
    ep.recordError({ proxy: 'codex', rawMessage: 'ETIMEDOUT', ts: now, persist: true });
    const h = ep.getHistory(10);
    expect(h).toHaveLength(2);
    expect(h[0].proxy).toBe('codex'); // 倒序，最新在前
    expect(h[0].pattern_id).toBe('etimedout');
   });
});

describe('searchHistory（3c 数据层，纯字符串检索，不依赖 LLM）', () => {
  beforeEach(() => {
    ep.recordError({ proxy: 'cursor', rawMessage: 'better-sqlite3 ABI mismatch', now, persist: true });
    ep.recordError({ proxy: 'codex', rawMessage: 'ETIMEDOUT upstream', now, persist: true });
    ep.recordError({ proxy: 'hermes', rawMessage: 'ECONNREFUSED', now, persist: true });
   });

  test('关键词 ETIMEDOUT 命中', () => {
    const r = ep.searchHistory('etimedout');
    expect(r.map((e) => e.pattern_id)).toContain('etimedout');
   });

  test('关键词 "refused" 命中 ECONNREFUSED', () => {
    expect(ep.searchHistory('refused').map((e) => e.proxy)).toContain('hermes');
   });

  test('空关键词 → 返回最近全部', () => {
    expect(ep.searchHistory('')).toHaveLength(3);
   });
});

describe('getPatterns 频次排序', () => {
  test('无 frequency 时 getPatterns 按 id 升序稳定', () => {
    const list = ep.getPatterns(true);
    expect(list.length).toBeGreaterThanOrEqual(6);
    const ids = list.map((p) => p.id);
     // 按 id 升序稳定：与标准排序结果一致
    expect(ids).toEqual(Array.from(ids).sort());
    });

  test('有 frequency 时按 frequency 降序', () => {
    ep.setPatterns([
      { id: 'a', pattern: 'a', resolution: '', frequency: 1 },
      { id: 'b', pattern: 'b', resolution: '', frequency: 5 },
      { id: 'c', pattern: 'c', resolution: '', frequency: 3 },
     ]);
    const list = ep.getPatterns(true);
     // frequency 降序：b(5) > c(3) > a(1)
    expect(list.map((p) => p.id)).toEqual(['b', 'c', 'a']);
    });
});