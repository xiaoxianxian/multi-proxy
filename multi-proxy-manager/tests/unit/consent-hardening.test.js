// consent-hardening.test.js — D2（2026-10-19 全角色评审）：同意记录加固（哈希/版本/IP + A 策略回填 + 内容变更重弹）
// 纯模块测试：全 opts 注入（recordPath/legalHash/now/ip + 临时 docs 目录），绝不碰真实 HOME / 不依赖 docs/legal 是否存在。
const fs = require('fs');
const os = require('os');
const path = require('path');
const consent = require('../../lib/consent');
const legal = require('../../lib/legal');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
// 造一份临时 docs/legal（terms + privacy 定稿），可控正文 → legalHashOf 确定性可比。
function makeDocs(bodyTerms, bodyPrivacy) {
  const d = tmpDir('legal-docs-');
  for (const [file, body] of Object.entries(bodyTerms ? { '用户服务协议.md': bodyTerms, '隐私政策.md': bodyPrivacy } : {})) {
    fs.writeFileSync(path.join(d, file), body, 'utf8');
  }
  return d;
}

describe('legalHashOf — 法务正文指纹（D2）', () => {
  test('① 确定性：同正文同哈希；正文一变哈希即变', () => {
    const dir = makeDocs('甲协议 v1', '甲隐私 v1');
    const h1 = legal.legalHashOf({ dir });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(legal.legalHashOf({ dir })).toBe(h1); // 幂等
    fs.writeFileSync(path.join(dir, '用户服务协议.md'), '甲协议 v2（改了一条）', 'utf8');
    expect(legal.legalHashOf({ dir })).not.toBe(h1); // 文档变更 → 指纹变
  });

  test('② 缺文档也确定性（空串参与），不抛', () => {
    const dir = tmpDir('legal-empty-'); // 无文件
    const h = legal.legalHashOf({ dir });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(legal.legalHashOf({ dir })).toBe(h);
    expect(h).not.toBe(legal.legalHashOf({ dir: makeDocs('x', 'y') })); // 有文档与无文档算不同指纹
  });
});

describe('recordConsent / verifyConsent — 同意记录加固（D2）', () => {
  function sandbox() {
    const home = tmpDir('consent-home-');
    const markerPath = path.join(home, '.multi-proxy-manager', consent.MARKER_BASENAME);
    const recordPath = path.join(home, '.multi-proxy-manager', consent.RECORD_BASENAME);
    // base 不含 legalHash：各用例显式传，避免 Object.assign 时 base 反向覆盖覆盖值
    const base = { markerPath, recordPath, home };
    return { home, markerPath, recordPath, base };
  }

  test('③ recordConsent 写 JSON 记录（含 哈希/版本/IP/migrated=false），绝不抛', () => {
    const { base, recordPath } = sandbox();
    const r = consent.recordConsent({ now: 1000, ip: '10.0.0.7', legalHash: 'HASH_A', ...base });
    expect(r.success).toBe(true);
    expect(r.version).toBe(2);
    expect(r.migrated).toBe(false);
    const raw = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    expect(raw.v).toBe(2);
    expect(raw.consentHash).toBe('HASH_A');
    expect(raw.ip).toBe('10.0.0.7');
    expect(raw.consented).toBe(true);
    expect(raw.consentedAt).toBe(new Date(1000).toISOString());
  });

  test('④ verify 哈希一致 → 已同意（ok）', () => {
    const { base } = sandbox();
    consent.recordConsent({ ip: '127.0.0.1', legalHash: 'HASH_A', ...base });
    const v = consent.verifyConsent({ legalHash: 'HASH_A', ...base });
    expect(v.valid).toBe(true);
    expect(v.reason).toBe('ok');
    expect(v.ip).toBe('127.0.0.1');
  });

  test('⑤ verify 哈希不符（法务正文已改）→ 未同意（content-hash-mismatch，需重弹）', () => {
    const { base } = sandbox();
    consent.recordConsent({ legalHash: 'HASH_A', ...base }); // 当时哈希 HASH_A
    const v = consent.verifyConsent({ legalHash: 'HASH_B_CHANGED', ...base });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('content-hash-mismatch');
  });

  test('⑥ A 策略：只有 legacy 纯时间戳 marker、无 JSON 记录 → 回填(migrated) 视为已同意，不打扰存量用户', () => {
    const { base, markerPath, recordPath } = sandbox();
    consent.markConsented({ markerPath, now: 5 });
    expect(fs.existsSync(recordPath)).toBe(false);
    const v = consent.verifyConsent({ legalHash: 'HASH_A', ...base });
    expect(v.valid).toBe(true);
    expect(v.migrated).toBe(true);
    expect(v.reason).toBe('legacy-backfill');
    expect(fs.existsSync(recordPath)).toBe(true); // 回填落盘
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).migrated).toBe(true);
  });

  test('⑦ 既无 marker 也无记录 → 未同意（no-record）', () => {
    const { base } = sandbox();
    const v = consent.verifyConsent(base);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('no-record');
  });

  test('⑧ 损坏记录 JSON → 视为无记录（不抛，走 no-record）', () => {
    const { base, recordPath } = sandbox();
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, '{ 不是合法 JSON', 'utf8');
    const v = consent.verifyConsent(base);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('no-record');
  });

  test('⑨ revokeConsent 一并清 marker + JSON 记录', () => {
    const { base, markerPath, recordPath } = sandbox();
    consent.markConsented({ markerPath, now: 1 });
    consent.recordConsent(base);
    expect(fs.existsSync(recordPath)).toBe(true);
    const r = consent.revokeConsent(base);
    expect(r.removed).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(recordPath)).toBe(false); // 记录也被清
    expect(consent.verifyConsent(base).valid).toBe(false);
  });
});
