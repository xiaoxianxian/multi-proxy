// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 公共模块：profiles 配置快照 + 原子切换（P2-new，cc-switch 借鉴 2026-10-13）
//
// QUEUE.md:201 登记 P2-new：cc-switch `profiles` 表 = 「整套配置（providers + 当前 profile）打成快照，
// 切换时原子写」。multi-proxy 此前全仓 0 行（grep 坐实）。
//
// 🔴 红线（AGENTS.md §3 非侵入铁律 + QUEUE.md:201 明文）：
//   **只抄三个范式** —— ①原子写（tmp + rename）②写前外部改动检测（sha256）③写前命名备份（.bak-<ts>）；
//   **绝不抄「写进 agent 文件」那个动作**。本模块只写 multi-proxy 自己的 profiles 快照文件
//   （默认 ~/.multi-proxy-manager/profiles.json），绝不碰 ~/.codex / ~/.cursor / ~/.hermes 等任何
//   第三方 agent 配置——那是 cc-switch 的核心卖点，恰是本项目的反面。
//
// 文件形态：{ ts, active, profiles: { <name>: <snapshot> } }，snapshot 由调用方自定（providers + 设置）。
// 门控 PROXY_PROFILES 默认关 = save/switchTo 全 no-op（零行为变更）；不被任何热路径 require。
// 记忆污染守卫（ASI06）：若注入 contentGuard（默认随 MULTI_PROXY_CONTENT_GUARD 门控），save 落盘前会扫
//   「数据里藏指令」的内容；命中则拦截不落盘（隔离而非静默存）。不注入 = 零行为变更。
// 零第三方依赖（node 内置 path/os/fs/crypto）。

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// 记忆污染守卫（OWASP ASI 2026 ASI06）：可选注入，不传 = 零行为变更。
// 由环境变量 MULTI_PROXY_CONTENT_GUARD 控制开关（默认关）。
const { createContentGuard } = require('./content-guard');

const GATE_ENV = 'PROXY_PROFILES';
const DEFAULT_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'profiles.json');

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

function sha256(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function createProfilesStore(opts = {}) {
    const activeFile = typeof opts.file === 'string' ? opts.file : DEFAULT_FILE;
    // 可选自检钩子：(file, nextDoc) => boolean，false = 视为落盘失败 → 回滚（默认：重读比对内容）
    const verifyWrite = typeof opts.verifyWrite === 'function' ? opts.verifyWrite : null;
    const contentGuard = opts.contentGuard || null; // 可选：记忆污染守卫（ASI06），不传 = 零行为变更
    let enabled = typeof opts.enabled === 'boolean' ? opts.enabled : gateOpen();
    // 本进程最后一次「写出 / 已确认」的内容 sha256；null = 尚不知，新进程不误报外部改动
    let lastHash = null;

    // 读盘：{ doc, hash }；缺失 / 损坏 → { doc: null, hash: null }
    function readDoc() {
        try {
            if (!fs.existsSync(activeFile)) return { doc: null, hash: null };
            const raw = fs.readFileSync(activeFile, 'utf8');
            const doc = JSON.parse(raw);
            if (!doc || typeof doc !== 'object' || !doc.profiles) return { doc: null, hash: null };
            return { doc, hash: sha256(raw) };
        } catch {
            return { doc: null, hash: null };
        }
    }

    // 写前外部改动检测：本进程写过/确认过（lastHash 非空）且盘上哈希已变 → 盘上被外部改过，不静默覆盖
    function externallyModified(hash) {
        return !!(lastHash && hash && hash !== lastHash);
    }

    function remember(hash) { if (hash) lastHash = hash; }

    function rollback(had, bak) {
        try {
            if (bak && fs.existsSync(bak)) fs.copyFileSync(bak, activeFile);       // 还原旧内容
            else if (!had && fs.existsSync(activeFile)) fs.unlinkSync(activeFile); // 原本没有就删掉
        } catch { /* 回滚失败也不再改写：盘上哈希已变，下次操作会被 external-change 检出 */ }
    }

    // 原子落盘：写前命名备份 .bak-<ts> → tmp + rename → 落盘后自检；任一步失败 → 回滚
    function commit(next) {
        const ts = Date.now();
        const dir = path.dirname(activeFile);
        const had = fs.existsSync(activeFile);
        const body = JSON.stringify(next, null, 2);
        let bak = null;
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (had) {
                bak = `${activeFile}.bak-${ts}`;
                fs.copyFileSync(activeFile, bak);
            }
            const tmp = `${activeFile}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, body);
            fs.renameSync(tmp, activeFile); // 原子替换
            const ok = verifyWrite ? !!verifyWrite(activeFile, next) : fs.readFileSync(activeFile, 'utf8') === body;
            if (!ok) throw new Error('verify-failed');
            remember(sha256(body));
            return { written: true, ts, backedUp: !!bak, hash: sha256(body) };
        } catch (e) {
            rollback(had, bak);
            return { written: false, reason: e && e.message === 'verify-failed' ? 'verify-failed' : 'io-error', rolledBack: true };
        }
    }

    /**
     * 保存 / 更新一个 profile 快照（门控关 = no-op）。
     * @param {string} name
     * @param {Object} snapshot - 任意配置快照（providers + 设置）
     * @returns {{written: boolean, ts?: number, backedUp?: boolean, hash?: string, reason?: string}}
     */
    function save(name, snapshot) {
        if (!enabled) return { written: false, reason: 'gate-closed' };
        if (typeof name !== 'string' || !name) return { written: false, reason: 'bad-name' };
        // 记忆污染守卫（ASI06）：外部内容写入前，拦截「数据里藏指令」的内容（隔离而非静默存）
        if (contentGuard && contentGuard.enabled) {
            const r = contentGuard.scanMemoryWrite(snapshot);
            if (!r.proceed) {
                return { written: false, reason: 'memory-poisoning-detected', poisoned: true, signals: r.signals, score: r.score };
            }
        }
        const { doc, hash } = readDoc();
        if (externallyModified(hash)) return { written: false, reason: 'external-change', hash, expected: lastHash };
        const base = doc || { ts: 0, active: null, profiles: {} };
        const next = {
            ts: Date.now(),
            active: base.active || name, // 首个 profile 自动成为当前
            profiles: Object.assign({}, base.profiles, { [name]: snapshot }),
        };
        return commit(next);
    }

    /**
     * 读回快照；不给 name 则读「当前 profile」。
     * @param {string} [name]
     * @returns {{name: string|null, snapshot: Object|null, active: boolean, ts: number, hash: string, externalModified: boolean}|null}
     */
    function load(name) {
        const { doc, hash } = readDoc();
        if (!doc) return null;
        const ext = externallyModified(hash);
        remember(hash); // 读到即「已知」，外部改动报过一次后不再挡后续写
        const key = (typeof name === 'string' && name) ? name : doc.active;
        if (!key || !Object.prototype.hasOwnProperty.call(doc.profiles, key)) return null;
        return { name: key, snapshot: doc.profiles[key], active: doc.active === key, ts: doc.ts, hash, externalModified: ext };
    }

    /** @returns {{names: string[], active: string|null, externalModified: boolean}} */
    function list() {
        const { doc, hash } = readDoc();
        if (!doc) return { names: [], active: null, externalModified: false };
        const ext = externallyModified(hash);
        remember(hash);
        return { names: Object.keys(doc.profiles).sort(), active: doc.active || null, externalModified: ext };
    }

    /**
     * 原子切换到指定 profile：写前备份 + 原子替换 + 失败回滚。
     * @param {string} name
     * @returns {{switched: boolean, from?: string|null, to?: string, ts?: number, backedUp?: boolean, hash?: string, reason?: string, rolledBack?: boolean}}
     */
    function switchTo(name) {
        if (!enabled) return { switched: false, reason: 'gate-closed' };
        const { doc, hash } = readDoc();
        if (externallyModified(hash)) return { switched: false, reason: 'external-change', hash, expected: lastHash };
        if (!doc || !Object.prototype.hasOwnProperty.call(doc.profiles, name)) return { switched: false, reason: 'not-found' };
        const from = doc.active || null;
        const r = commit({ ts: Date.now(), active: name, profiles: doc.profiles });
        if (!r.written) return { switched: false, reason: r.reason, rolledBack: r.rolledBack, from, to: name };
        return { switched: true, from, to: name, ts: r.ts, backedUp: r.backedUp, hash: r.hash };
    }

    function active() { const { doc } = readDoc(); return (doc && doc.active) || null; }
    function isEnabled() { return enabled; }
    function setEnabled(v) { enabled = !!v; }
    function file() { return activeFile; }
    function lastKnownHash() { return lastHash; }

    return { save, load, list, switchTo, active, isEnabled, setEnabled, file, lastKnownHash };
}

const _ps = createProfilesStore({ contentGuard: createContentGuard() });
module.exports = {
    GATE_ENV,
    DEFAULT_FILE,
    createProfilesStore,
    gateOpen,
    save: _ps.save,
    load: _ps.load,
    list: _ps.list,
    switchTo: _ps.switchTo,
};
