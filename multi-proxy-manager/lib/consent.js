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

const MARKER_BASENAME = '.first-launch-consent-done';

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
function revokeConsent(opts = {}) {
  const state = consentState(opts);
  let removed = false;
  try {
    fs.unlinkSync(state.markerPath);
    removed = true;
  } catch {
    removed = false; // 本就不存在 → 幂等成功
  }
  return { markerPath: state.markerPath, removed, consented: isConsented(opts) };
}

module.exports = { consentState, isConsented, markConsented, revokeConsent, MARKER_BASENAME };
