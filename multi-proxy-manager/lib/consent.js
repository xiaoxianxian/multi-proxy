// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// consent.js — 首启法务同意门·状态模块（纯模块，可单测，绝不抛异常）
// 设计基线 D-1：首启须展示《用户服务协议》+《隐私政策》，可拒绝/可退出/可修改。
// 本模块只做「状态」——同意与否的判定 / 记录 / 撤销；阻断逻辑（dashboard 是否被拦）
// 由上层 server.js 页面中间件决定（页级默认拦首启、API 非侵入；MP_CONSENT_BYPASS / NODE_ENV=test 放行，AGENTS §3），本模块本身零行为改变。
//
// 标记落 ~/.multi-proxy-manager/.first-launch-consent-done（时戳），与 first-launch-cleanup
// 同 stateDir，「首启」语义统一。全部 opts 可注入 → 可单测 / 可被 server.js 直接调用。

const fs = require('fs');
const path = require('path');
const legalLib = require('./legal'); // D2：同意记录绑法务正文指纹（legalHashOf 与 /legal 服务同源）

const MARKER_BASENAME = '.first-launch-consent-done';
const RECORD_BASENAME = 'consent-record.json'; // D2：JSON 同意记录（哈希/版本/时间戳/IP）
const DEFER_BASENAME = 'consent-defer.json'; // 「稍后再说」标记（带过期时间）
const RECORD_VERSION = 2;
// 默认推迟窗口 24h：过期后门重新拦（避免「点一次稍后 = 永久豁免」）
const DEFAULT_DEFER_TTL_MS = 24 * 60 * 60 * 1000;

function stateDirOf(home) {
  return home ? path.join(home, '.multi-proxy-manager') : '';
}

// 读状态：是否已同意（标记存在即已同意）。绝不抛异常。
function consentState(opts = {}) {
  const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';
  const markerPath = opts.markerPath || path.join(stateDirOf(home), MARKER_BASENAME);
  let consented = false;
  try {
    consented = !!fs.statSync(markerPath); // 存在即已同意（stat 成功）
  } catch {
    consented = false; // 不存在 / 不可读 → 未同意
  }
  return { home, markerPath, stateDir: stateDirOf(home), consented };
}

// 是否已首启同意。
function isConsented(opts = {}) {
  return consentState(opts).consented;
}

// 记录一次同意（写时戳标记）；幂等：已存在则覆盖为本次时间。确保父目录存在。
function markConsented(opts = {}) {
  const state = consentState(opts);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const iso = new Date(now).toISOString();
  try {
    fs.mkdirSync(path.dirname(state.markerPath), { recursive: true });
    fs.writeFileSync(state.markerPath, iso + '\n');
  } catch {
    /* 写失败时不抛（外层仍 try/catch）；返回 success:false */
    return { markerPath: state.markerPath, success: false, consented: isConsented(opts) };
  }
  return { markerPath: state.markerPath, success: true, consentedAt: iso };
}

// 撤销同意（删标记）→ 回到「未同意」，用于「可退出 / 重新同意」场景。
// D2：一并删 consent-record.json（记录与 marker 同步撤销；残留会让 verify 仍判已同意）。
// 顺带删 defer 标记：撤销语义上应回到「门重新拦」，否则旧 defer 会把撤销者放过去。
function revokeConsent(opts = {}) {
  const state = consentState(opts);
  let removed = false;
  try {
    fs.unlinkSync(state.markerPath);
    removed = true;
  } catch {
    removed = false; // 本就不存在 → 幂等成功
  }
  try {
    fs.unlinkSync(recordPathOf(opts)); // 记录不存在则 catch，不影响
  } catch {
    /* 幂等 */
  }
  try {
    fs.unlinkSync(deferPathOf(opts));
  } catch {
    /* 幂等 */
  }
  return { markerPath: state.markerPath, removed, consented: isConsented(opts) };
}

// ─── 「稍后再说」推迟标记（带过期时间） ───
// consent.html 的「暂不，稍后再说」原本 href=/dashboard，而 /dashboard 未同意即 302 回
// /consent ⇒ 死循环。defer 是那条「真能放行」的路：写一份带 deferUntil 的标记，
// 门的 consentBypass() 认它 ⇒ 放行；过期即失效，门重新拦（不是永久豁免）。
function deferPathOf(opts = {}) {
  const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';
  const stateDir = opts.stateDir || (home ? path.join(home, '.multi-proxy-manager') : '');
  return opts.deferPath || (stateDir ? path.join(stateDir, DEFER_BASENAME) : DEFER_BASENAME);
}

function readDefer(opts = {}) {
  try {
    const p = deferPathOf(opts);
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // 损坏 → 视为无 defer
  }
}

// 写「稍后再说」：{v, deferredAt, deferUntilMs, deferUntil}。ttlMs 缺省 24h，绝不抛。
function deferConsent(opts = {}) {
  const p = deferPathOf(opts);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_DEFER_TTL_MS;
  const untilMs = now + ttlMs;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      v: RECORD_VERSION,
      deferredAt: new Date(now).toISOString(),
      deferUntilMs: untilMs,
      deferUntil: new Date(untilMs).toISOString(),
    }, null, 2));
    return { success: true, deferPath: p, deferUntilMs: untilMs, deferUntil: new Date(untilMs).toISOString(), ttlMs };
  } catch {
    return { success: false, deferPath: p, reason: 'defer 标记写入失败' };
  }
}

// 读 defer 状态：{deferred, deferUntil, remainingMs, reason}。过期/缺失/损坏 ⇒ deferred:false。
function deferState(opts = {}) {
  const d = readDefer(opts);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (!d || !Number.isFinite(Number(d.deferUntilMs))) {
    return { deferred: false, deferPath: deferPathOf(opts), reason: 'no-defer' };
  }
  const untilMs = Number(d.deferUntilMs);
  if (untilMs <= now) {
    return { deferred: false, deferPath: deferPathOf(opts), deferUntil: d.deferUntil, reason: 'expired' };
  }
  return {
    deferred: true,
    deferPath: deferPathOf(opts),
    deferUntil: d.deferUntil || new Date(untilMs).toISOString(),
    deferUntilMs: untilMs,
    remainingMs: untilMs - now,
  };
}

function isDeferred(opts = {}) {
  return deferState(opts).deferred;
}

// ─── D2（2026-10-19 全角色评审）：同意记录加固 ───
// 在纯时间戳 marker 之外，另存 JSON 记录 consent-record.json：{v, consentHash, consentedAt, ip, migrated}。
// consentHash = legalHashOf（两份法务定稿正文的 sha256，与 /legal 服务同源）。
// A 策略（存量不打扰）：老用户只有纯时间戳 marker、无 JSON 记录 → verify 时回填一条带当前哈希的记录(migrated)，不重弹同意门。
// 强校验：有 JSON 记录但 consentHash 与当前法务正文不符（文档改了）→ 视为未同意，重弹同意门。
// 全部 opts 可注入（recordPath/legalHash/now/ip）→ 可单测，绝不抛异常。

function recordPathOf(opts = {}) {
  const home = opts.home || process.env.HOME || process.env.USERPROFILE || '';
  const stateDir = opts.stateDir || (home ? path.join(home, '.multi-proxy-manager') : '');
  return opts.recordPath || (stateDir ? path.join(stateDir, RECORD_BASENAME) : RECORD_BASENAME);
}

function readRecord(opts = {}) {
  try {
    const rp = recordPathOf(opts);
    if (!fs.existsSync(rp)) return null;
    const parsed = JSON.parse(fs.readFileSync(rp, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // 损坏 → 视为无记录（走 legacy / no-record 分支）
  }
}

// 记录一次同意（accept 时调用）：写带 内容哈希/版本/时间戳/IP 的 JSON 记录。幂等，绝不抛。
function recordConsent(opts = {}) {
  const rp = recordPathOf(opts);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const hash = opts.legalHash != null ? String(opts.legalHash) : legalLib.legalHashOf(opts);
  try {
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(rp, JSON.stringify({
      v: RECORD_VERSION,
      consentHash: hash,
      consentedAt: new Date(now).toISOString(),
      ip: opts.ip || '127.0.0.1',
      consented: true,
      migrated: !!opts.migrated,
    }, null, 2));
    return { success: true, recordPath: rp, consentHash: hash, version: RECORD_VERSION, migrated: !!opts.migrated };
  } catch {
    return { success: false, recordPath: rp, reason: '同意记录写入失败' };
  }
}

// D2 门判定（A 策略）：供 server.js 同意门使用（替代裸 isConsented，使「法务正文变更 → 重弹同意门」生效）。
// 返回 { valid, version, consentedAt?, ip?, migrated?, reason }。绝不抛。
function verifyConsent(opts = {}) {
  const rec = readRecord(opts);
  if (rec && rec.consentHash != null) {
    const current = opts.legalHash != null ? String(opts.legalHash) : legalLib.legalHashOf(opts);
    if (String(rec.consentHash) === current) {
      return { valid: true, version: rec.v, consentedAt: rec.consentedAt, ip: rec.ip, migrated: !!rec.migrated, reason: 'ok' };
    }
    return { valid: false, version: rec.v, consentedAt: rec.consentedAt, reason: 'content-hash-mismatch' };
  }
  // 无 JSON 记录（或无哈希）：legacy 纯时间戳 marker → A 策略回填为带哈希记录，视为已同意（不打扰存量用户）
  if (isConsented(opts)) {
    recordConsent(Object.assign({}, opts, { migrated: true }));
    return { valid: true, version: RECORD_VERSION, migrated: true, reason: 'legacy-backfill' };
  }
  return { valid: false, reason: 'no-record' };
}

module.exports = {
  consentState, isConsented, markConsented, revokeConsent,
  recordConsent, verifyConsent, recordPathOf,
  deferPathOf, deferConsent, deferState, isDeferred,
  MARKER_BASENAME, RECORD_BASENAME, DEFER_BASENAME, RECORD_VERSION,
  DEFAULT_DEFER_TTL_MS,
};
