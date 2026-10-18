// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 持久化 run history（G5，映射 Paperclip issue thread 绑定 run history）
//
// 把治理事件（cost watchdog 的 record 结果 / block / 阈值告警 / 接入方请求）落本地 JSONL，
// 跨重启可查。autonomous-continuity / context-guard 已覆盖「跨重启续跑」命题，本模块只补
// 「事件留痕可查」这一层，独立、轻量、不加依赖。
//
// 非侵入铁律（与 l2/ 其它内核同构）：
//   - 门控 PROXY_RUN_HISTORY 默认关 = append 直接 no-op（不落盘、零副作用）；
//     开(=1/true/on) = best-effort 落盘 run-history.jsonl。
//   - 记忆污染守卫（ASI06）：若注入 contentGuard（默认随 MULTI_PROXY_CONTENT_GUARD 门控），
//     append 落盘前会扫「数据里藏指令」的内容；命中则拦截不落盘（隔离而非静默存）。不注入 = 零行为变更。
//   - 不被任何热路径 require；存在即零行为变更。
//   - 零第三方依赖（node 内置 path/os/fs）。

const path = require('path');
const os = require('os');
const fs = require('fs');

// 记忆污染守卫（OWASP ASI 2026 ASI06）：可选注入，不传 = 零行为变更。
// 由环境变量 MULTI_PROXY_CONTENT_GUARD 控制开关（默认关）。
const { createContentGuard } = require('../content-guard');

const GATE_ENV = 'PROXY_RUN_HISTORY';
const DEFAULT_LOG_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'run-history.jsonl');

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

function createRunHistory(opts = {}) {
    const activeFile = typeof opts.logFile === 'string' ? opts.logFile : DEFAULT_LOG_FILE;
    const contentGuard = opts.contentGuard || null; // 可选：记忆污染守卫（ASI06），不传 = 零行为变更
    let enabled = typeof opts.enabled === 'boolean' ? opts.enabled : gateOpen();

    // 落一条事件（门控关时 no-op）。event 里建议带 type（如 'cost-record'/'block'/'threshold-alert'）
    function append(event) {
        if (!enabled) return { written: false, reason: 'gate-closed' };
        // 记忆污染守卫（ASI06）：外部内容落盘前，拦截「数据里藏指令」的内容（隔离而非静默存）。
        if (contentGuard && contentGuard.enabled) {
            const r = contentGuard.scanMemoryWrite(event);
            if (!r.proceed) {
                return { written: false, reason: 'memory-poisoning-detected', poisoned: true, signals: r.signals, score: r.score };
            }
        }
        try {
            const dir = path.dirname(activeFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const rec = { ts: Date.now(), ...event };
            fs.appendFileSync(activeFile, JSON.stringify(rec) + '\n');
            return { written: true, ts: rec.ts };
        } catch { return { written: false, reason: 'io-error' }; }
    }

    // 读回（跨重启可查），按 type / limit 过滤
    function query(filter = {}) {
        try {
            if (!fs.existsSync(activeFile)) return [];
            const lines = fs.readFileSync(activeFile, 'utf8').split('\n').filter(Boolean);
            let rows = lines
                .map((l) => { try { return JSON.parse(l); } catch { return null; } })
                .filter(Boolean);
            if (filter.type) rows = rows.filter((r) => r.type === filter.type);
            if (filter.limit) rows = rows.slice(-filter.limit);
            return rows;
        } catch { return []; }
    }

    function isEnabled() { return enabled; }
    function setEnabled(v) { enabled = !!v; }
    function file() { return activeFile; }

    return { append, query, isEnabled, setEnabled, file };
}

const _rh = createRunHistory({ contentGuard: createContentGuard() });
module.exports = {
    GATE_ENV,
    DEFAULT_LOG_FILE,
    createRunHistory,
    gateOpen,
    append: _rh.append,
    query: _rh.query,
};
