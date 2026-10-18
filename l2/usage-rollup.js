// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 公共模块：日级用量卷 usage_daily_rollups（P1-1，cc-switch 借鉴 2026-10-13）
//
// 问题（grep 坐实）：l2/run-history/ 是 G5 **逐条** JSONL（一行 = 一次调用），出趋势图要现算；cc-switch 的 usage_daily_rollups 按 (date, provider, model) 预聚合，查趋势只读卷行。
//
// 源记录字段（**照实读，不臆造**）：外层 = run-history.js:41 的 `{ ts: Date.now(), ...event }`；
//   用量字段照 multi-proxy-manager/lib/cost-track.js:419-439 落账的那份：
//   proxy / model / requestModel / prompt / completion / cacheHit / thinking / cost。
//   真盘样本（~/.multi-proxy-manager/cost-ledger.jsonl 首行）：
//     {"ts":"2026-10-08T10:00:08.780Z","proxy":"openai","model":"<unknown>","prompt":1,"completion":0,"cacheHit":0,"thinking":0,"cost":20}
//   - 源里**没有** cache_read / cache_creation 分项（P1-2 未落地）→ 只记 cacheHitTokens，不造字段。
//   - ts 两种形态都收：epoch ms（run-history）与 ISO 串（cost-ledger）。
//
// 非侵入铁律（照 run-history.js / health-store.js）：门控 PROXY_USAGE_ROLLUP 默认关 = 全 no-op
// （不读源、不落盘）；不被任何热路径 require（forward.js / codex-proxy/proxy.js 一律不动）；
// 零第三方依赖（node 内置 path/os/fs）+ 纯函数优先。

const path = require('path');
const os = require('os');
const fs = require('fs');
const runHistory = require('./run-history/run-history.js');

const GATE_ENV = 'PROXY_USAGE_ROLLUP';
const DEFAULT_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'usage-daily-rollups.json');
const UNKNOWN = '<unknown>';

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

// ⚠️ 时区口径说明（2026-10-16）：
//   本文件仍是 **UTC** 日期键，而 l2/watchtower-report.js 已改成本地时区
//   （默认 Asia/Shanghai，PROXY_COST_TZ 可覆盖）。两处**故意**不同步：
//   ① usage-rollup 的日卷键被既有持久化数据与下游消费方钉死，改键等于让历史
//      日卷全部错位；
//   ② watchtower 是「给人看的周报」，日期必须贴合用户对「上周」的理解；
//      usage-rollup 是「机器聚合的日卷」，UTC 键更稳定、可跨机复现。
//   **所以：日卷与周报的日期在 UTC 23:00–24:00 边界上可能差一天，这是已知的、
//    有意的差异，不是 bug。** 若将来要统一，必须同时做存量数据迁移。
//
// 日期键：epoch ms 或 ISO 串 → 'YYYY-MM-DD'（UTC，跨时区不漂）；无/坏 ts → null（不猜）
function dayOf(ts) {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts ?? ''));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

const SUM_FIELDS = ['requestCount', 'inputTokens', 'outputTokens', 'cacheHitTokens', 'thinkingTokens', 'cost'];

// 纯函数：逐条记录 → 卷行（同 (date, provider, model) 累加）
function summarize(records) {
    const map = new Map();
    for (const r of records || []) {
        if (!r || typeof r !== 'object') continue;
        const date = dayOf(r.ts);
        if (!date) continue; // 没时间戳 → 不入卷（猜日期就是假数据）
        const provider = r.proxy || UNKNOWN;
        const model = r.model || UNKNOWN;
        const key = `${date}|${provider}|${model}`;
        const row = map.get(key) || { date, provider, model, requestCount: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, thinkingTokens: 0, cost: 0 };
        row.requestCount += 1;
        row.inputTokens += num(r.prompt);
        row.outputTokens += num(r.completion);
        row.cacheHitTokens += num(r.cacheHit);
        row.thinkingTokens += num(r.thinking);
        row.cost += num(r.cost);
        map.set(key, row);
    }
    return [...map.values()];
}

// 纯函数：旧卷 + 本轮新卷 → 合并卷（同 key 相加，旧卷独有日期保留）
function mergeRows(prev, fresh) {
    const map = new Map();
    for (const row of [...(prev || []), ...(fresh || [])]) {
        if (!row) continue;
        const key = `${row.date}|${row.provider}|${row.model}`;
        const cur = map.get(key);
        if (!cur) { map.set(key, { ...row }); continue; }
        for (const f of SUM_FIELDS) cur[f] += num(row[f]);
    }
    return [...map.values()];
}

// 从 cursor 字节位之后读新行（append-only JSONL）。末段没换行 = 半行，不解析，留下一轮。
function readNew(file, cursor = 0) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return { records: [], cursor }; }
    if (buf.length <= cursor) return { records: [], cursor };
    const lines = buf.slice(cursor).toString('utf8').split('\n').slice(0, -1);
    let consumed = 0;
    const records = [];
    for (const line of lines) {
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim()) continue;
        try {
            const o = JSON.parse(line);
            if (o && typeof o === 'object') records.push(o);
        } catch { /* 坏行跳过，不影响已落卷 */ }
    }
    return { records, cursor: cursor + consumed };
}

function createUsageRollup(opts = {}) {
    const activeFile = typeof opts.file === 'string' ? opts.file : DEFAULT_FILE;
    const sourceFile = typeof opts.sourceFile === 'string' ? opts.sourceFile : runHistory.DEFAULT_LOG_FILE;
    let enabled = typeof opts.enabled === 'boolean' ? opts.enabled : gateOpen();

    // 落盘：写前可选备份 .bak-<ts>，再 tmp + rename（原子写，防写一半损坏）
    function save(rows, cursor, writeOpts = {}) {
        if (!enabled) return { written: false, reason: 'gate-closed' };
        try {
            const dir = path.dirname(activeFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const ts = Date.now();
            let backedUp = false;
            if (writeOpts.backup && fs.existsSync(activeFile)) {
                fs.copyFileSync(activeFile, `${activeFile}.bak-${ts}`);
                backedUp = true;
            }
            const tmp = `${activeFile}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify({ ts, cursor, rows }, null, 2));
            fs.renameSync(tmp, activeFile);
            return { written: true, ts, backedUp };
        } catch {
            return { written: false, reason: 'io-error' };
        }
    }

    // 读回上次卷（含 cursor，跨重启可续）
    function load() {
        try {
            if (!fs.existsSync(activeFile)) return null;
            const raw = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
            return raw && Array.isArray(raw.rows) ? raw : null;
        } catch {
            return null;
        }
    }

    // 增量卷：只解析 cursor 之后的新行 → 合并进旧卷 → 落盘
    function rollup(writeOpts = {}) {
        if (!enabled) return { written: false, reason: 'gate-closed' };
        const prev = load() || { cursor: 0, rows: [] };
        const { records, cursor } = readNew(sourceFile, num(prev.cursor));
        const rows = mergeRows(prev.rows, summarize(records));
        return { ...save(rows, cursor, writeOpts), scanned: records.length, rows };
    }

    function isEnabled() { return enabled; }
    function setEnabled(v) { enabled = !!v; }
    function file() { return activeFile; }
    function source() { return sourceFile; }

    return { rollup, save, load, summarize, mergeRows, readNew: (c) => readNew(sourceFile, c), isEnabled, setEnabled, file, source };
}

const _ur = createUsageRollup();
module.exports = {
    GATE_ENV,
    DEFAULT_FILE,
    createUsageRollup,
    gateOpen,
    dayOf,
    summarize,
    mergeRows,
    rollup: _ur.rollup,
    load: _ur.load,
};
