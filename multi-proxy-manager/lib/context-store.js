// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// context-store — context-breakdown 上报的存储与聚合（口径 §5）
//
// 职责：收 lane 报来的每请求七类组成帧，内存环 + jsonl 落盘，出面板要的
// summary / recent。与 cost-track 的差异：这里只存**计数**，永不存正文。
//
// 设计原则：
//   - 只增不删：report() 只追加；清理只发生在窗口聚合时（算完即弃）。
//   - 畸形不 throw：形状校验失败丢并计数（观测链路不能搞崩 manager）。
//   - 落盘 best-effort：写盘失败只计数不抛（内存态照常服务）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = path.join(os.homedir(), '.multi-proxy-manager');
const FILENAME = 'context-ledger.jsonl';
const MAX_ROTATE_BYTES = 5 * 1024 * 1024;
const RING_MAX = 500;

const CATEGORIES = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'];

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

function validate(entry) {
  if (!entry || typeof entry !== 'object') return 'entry not object';
  if (!entry.frame || typeof entry.frame !== 'object') return 'missing frame';
  const est = entry.frame.estimate;
  if (!est || typeof est !== 'object' || typeof est.byCategory !== 'object') return 'missing frame.estimate.byCategory';
  if (!Array.isArray(entry.events)) return 'events not array';
  return null;
}

class ContextStore {
  constructor({ dir = DEFAULT_DIR, ringMax = RING_MAX } = {}) {
    this.dir = dir;
    this.file = path.join(dir, FILENAME);
    this.ringMax = ringMax;
    /** @type {Array<object>} 最近 ringMax 条（含 ts / frame / events） */
    this._ring = [];
    this._dropped = 0;   // 形状校验失败丢弃条数
    this._diskErrors = 0;
  }

  /**
   * 收一条上报。返回 { ok, reason? }；任何失败都不 throw。
   */
  report(entry) {
    const err = validate(entry);
    if (err) { this._dropped += 1; return { ok: false, reason: err }; }
    const row = {
      ts: num(entry.ts) || Date.now(),
      agent: typeof entry.agent === 'string' ? entry.agent : 'lane',
      reqId: typeof entry.reqId === 'string' ? entry.reqId : null,
      model: typeof entry.model === 'string' ? entry.model : null,
      requestModel: typeof entry.requestModel === 'string' ? entry.requestModel : null,
      clientKey: typeof entry.clientKey === 'string' ? entry.clientKey : 'default',
      total: num(entry.frame.estimate.total),
      byCategory: entry.frame.estimate.byCategory,
      source: entry.frame.source === 'actual' ? 'actual' : 'estimate',
      cached: entry.frame.actual && num(entry.frame.actual.cached),
      toolCount: num(entry.frame.estimate.toolCount),
      toolsBySource: entry.frame.estimate.toolsBySource || null,
      warnings: Array.isArray(entry.frame.warnings) ? entry.frame.warnings : [],
      events: Array.isArray(entry.events) ? entry.events : [],
    };
    this._ring.push(row);
    if (this._ring.length > this.ringMax) this._ring.shift();
    this._persist(row);
    return { ok: true };
  }

  _persist(row) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_ROTATE_BYTES) {
          fs.renameSync(this.file, this.file + '.1');
        }
      } catch { /* 轮转失败不阻塞追加 */ }
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    } catch {
      this._diskErrors += 1; // 落盘失败不冒泡：内存环照常服务
    }
  }

  /** 窗口内聚合。windowMs 非有限 → 全量环。 */
  summary({ windowMs } = {}) {
    const now = Date.now();
    const rows = Number.isFinite(windowMs)
      ? this._ring.filter((r) => r.ts >= now - windowMs)
      : this._ring.slice();
    const requests = rows.length;
    const byCategory = {};
    for (const c of CATEGORIES) byCategory[c] = 0;
    let peak = 0;
    let actualCount = 0;
    const events = {};
    const warnings = {};
    const perAgent = {};
    for (const r of rows) {
      for (const c of CATEGORIES) byCategory[c] += num(r.byCategory[c]);
      if (r.total > peak) peak = r.total;
      if (r.source === 'actual') actualCount += 1;
      perAgent[r.agent] = (perAgent[r.agent] || 0) + 1;
      for (const e of r.events) {
        const k = e && typeof e.kind === 'string' ? e.kind : 'unknown';
        events[k] = (events[k] || 0) + 1;
      }
      for (const w of r.warnings) {
        const k = String(w).split(':')[0];
        warnings[k] = (warnings[k] || 0) + 1;
      }
    }
    if (requests > 0) {
      for (const c of CATEGORIES) byCategory[c] = Math.round(byCategory[c] / requests);
    }
    return {
      requests,
      windowMs: Number.isFinite(windowMs) ? windowMs : null,
      byCategory,
      peak,
      actualCoverage: requests > 0 ? Math.round((actualCount / requests) * 1000) / 1000 : 0,
      events,
      warnings,
      perAgent,
      dropped: this._dropped,
      diskErrors: this._diskErrors,
      lastUpdated: rows.length ? rows[rows.length - 1].ts : null,
    };
  }

  /** 最近 n 条（同上报形状的裁剪版，无正文——本来就没存正文）。 */
  recent(n = 50) {
    const k = Number.isFinite(n) ? Math.max(1, Math.min(n, this.ringMax)) : 50;
    return this._ring.slice(-k);
  }

  stats() {
    return { ring: this._ring.length, ringMax: this.ringMax, dropped: this._dropped, diskErrors: this._diskErrors, file: this.file };
  }

  clear() { const n = this._ring.length; this._ring.length = 0; return n; }
}

const _singleton = new ContextStore();

module.exports = {
  ContextStore,
  CATEGORIES,
  FILENAME,
  // 单例转发（routes/context.js 直接 require）
  report: _singleton.report.bind(_singleton),
  summary: _singleton.summary.bind(_singleton),
  recent: _singleton.recent.bind(_singleton),
  stats: _singleton.stats.bind(_singleton),
  clear: _singleton.clear.bind(_singleton),
  _singleton,
};
