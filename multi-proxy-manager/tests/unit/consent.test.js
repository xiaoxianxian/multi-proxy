// consent.test.js — 首启法务同意门状态模块测试（3 态 + 幂等 + 撤销 + 注入式）
// 镜像 update-check.js 的纯模块测试写法：可注入 home/markerPath/now，绝不依赖真实 HOME。
const fs = require('fs');
const os = require('os');
const path = require('path');
const consent = require('../../lib/consent');

function tmpMarker() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-'));
  return path.join(d, '.multi-proxy-manager', '.first-launch-consent-done');
}

describe('consent — 首启法务同意门状态模块', () => {
  test('① 默认（无标记）= 未同意', () => {
    const mk = tmpMarker();
    expect(consent.isConsented({ markerPath: mk })).toBe(false);
    expect(consent.consentState({ markerPath: mk }).consented).toBe(false);
  });

  test('② markConsented 后 = 已同意（含时戳 + 幂等父目录）', () => {
    const mk = tmpMarker();
    const r = consent.markConsented({ markerPath: mk, now: 1000 });
    expect(r.success).toBe(true);
    expect(r.consentedAt).toBe(new Date(1000).toISOString());
    expect(fs.existsSync(mk)).toBe(true); // 父目录 .multi-proxy-manager 被建出
    expect(consent.isConsented({ markerPath: mk })).toBe(true);
  });

  test('③ 重复 mark（幂等）= 覆盖为最新时间戳，仍已同意', () => {
    const mk = tmpMarker();
    consent.markConsented({ markerPath: mk, now: 1 });
    consent.markConsented({ markerPath: mk, now: 5 });
    expect(consent.isConsented({ markerPath: mk })).toBe(true);
    expect(fs.readFileSync(mk, 'utf8').trim()).toBe(new Date(5).toISOString());
  });

  test('④ revokeConsent = 回到未同意（可退出/重新同意），幂等删', () => {
    const mk = tmpMarker();
    consent.markConsented({ markerPath: mk, now: 1 });
    expect(consent.isConsented({ markerPath: mk })).toBe(true);
    const r = consent.revokeConsent({ markerPath: mk });
    expect(r.removed).toBe(true);
    expect(r.consented).toBe(false);
    // 再 revoke 不存在标记 → 幂等 success（removed:false 但不报错）
    expect(() => consent.revokeConsent({ markerPath: mk })).not.toThrow();
  });

  test('⑤ consentState 注入 home → 标记落 ~/.multi-proxy-manager/.first-launch-consent-done', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const st = consent.consentState({ home });
    expect(st.stateDir).toBe(path.join(home, '.multi-proxy-manager'));
    expect(st.markerPath).toBe(path.join(home, '.multi-proxy-manager', '.first-launch-consent-done'));
    expect(st.consented).toBe(false);
  });

  test('⑦ deferConsent 写「稍后再说」标记 = 门放行（带过期时间，非永久豁免）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-defer-'));
    expect(consent.isDeferred({ home })).toBe(false); // 无标记 → 不放行
    const r = consent.deferConsent({ home, now: 1000, ttlMs: 60000 });
    expect(r.success).toBe(true);
    expect(r.deferPath).toBe(path.join(home, '.multi-proxy-manager', 'consent-defer.json'));
    const st = consent.deferState({ home, now: 2000 });
    expect(st.deferred).toBe(true);
    expect(st.remainingMs).toBe(59000);
    expect(consent.isDeferred({ home, now: 59000 })).toBe(true);
    // 过期 ⇒ 门重新拦（这是「暂不，稍后再说」不该是永久豁免的关键）
    expect(consent.isDeferred({ home, now: 61000 })).toBe(false);
    expect(consent.deferState({ home, now: 61000 }).reason).toBe('expired');
  });

  test('⑧ revokeConsent 一并清 defer ⇒ 撤销后门重新拦', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-revoke-'));
    consent.markConsented({ home, now: 1 });
    consent.deferConsent({ home, now: 1, ttlMs: 60000 });
    expect(consent.isDeferred({ home, now: 100 })).toBe(true);
    consent.revokeConsent({ home });
    expect(consent.isDeferred({ home, now: 100 })).toBe(false);
  });

  test('⑨ defer 标记写失败时不抛（success:false）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'defer-fail-'));
    const fileAsDir = path.join(base, 'i-am-a-file');
    fs.writeFileSync(fileAsDir, 'x');
    const r = consent.deferConsent({ deferPath: path.join(fileAsDir, 'sub', 'consent-defer.json') });
    expect(r.success).toBe(false);
    expect(consent.isDeferred({ deferPath: path.join(fileAsDir, 'sub', 'consent-defer.json') })).toBe(false);
  });

  test('⑥ markConsented 写失败时不抛（success:false）—— 绝不破坏外层', () => {
    // 让 marker 的父目录是一个「文件」→ mkdirSync('file/sub') 撞 ENOTDIR → 走失败分支
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-fail-'));
    const fileAsDir = path.join(base, 'i-am-a-file');
    fs.writeFileSync(fileAsDir, 'x');
    const bad = path.join(fileAsDir, 'sub', '.first-launch-consent-done');
    const r = consent.markConsented({ markerPath: bad });
    expect(r.success).toBe(false); // mkdir 撞 ENOTDIR → 被 catch → 不抛，返回 success:false
    expect(consent.isConsented({ markerPath: bad })).toBe(false);
   });
});
