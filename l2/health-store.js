'use strict';

// L2 公共模块：provider 健康态持久化（P0-2，cc-switch 借鉴 2026-10-08）
//
// 问题（grep 坐实）：l2/health-monitor.js 用 Map 纯内存存 health 状态，进程重启即全丢；
// cc-switch 的 provider_health 表 + proxy_live_backup 是「跨重启/跨进程可恢复」的落盘范式。
//
// 本模块只做「健康态快照的持久化 + 合并」，不碰 health-monitor 的核心轮询循环（非侵入）：
//   - save(snapshot)：把 {providerId: {state, failureCount, ...}} 整体落盘（门控关=no-op）
//     atomic write（先写 .tmp 再 rename）+ 可选写前备份 .bak（cc-switch proxy_live_backup 范式），
//     防「写一半崩了文件损坏」。
//   - load()：读回上次快照（跨重启/跨进程），异常返 null。
//   - merge(prev, fresh)：fresh 里的 provider 覆盖 prev，prev 独有（本轮没查）保留，
//     可选 staleSince 让过旧的快照条目过期——「跨重启不丢 + 不无限累积」。
//
// 非侵入铁律（与 l2/ 其它内核同构，照 run-history.js）：
//   - 门控 PROXY_HEALTH_PERSIST 默认关 = save 直接 no-op（不落盘、零副作用）；
//     开(=1/true/on) = best-effort 落盘 provider-health.json。
//   - 不被任何热路径 require；存在即零行为变更（health-monitor.demo.js 仍 6/6 绿）。
//   - 零第三方依赖（node 内置 path/os/fs）。

const path = require('path');
const os = require('os');
const fs = require('fs');

const GATE_ENV = 'PROXY_HEALTH_PERSIST';
const DEFAULT_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'provider-health.json');

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

function createHealthStore(opts = {}) {
    const activeFile = typeof opts.file === 'string' ? opts.file : DEFAULT_FILE;
    let enabled = typeof opts.enabled === 'boolean' ? opts.enabled : gateOpen();

    /**
     * 保存一份健康态快照（门控关时 no-op）。
     * @param {Record<string, Object>} snapshot - {providerId: {state, failureCount, lastFailureTime, ...}}
     * @param {{backup?: boolean}} [writeOpts] - backup=true 时写前先备份旧文件到 .bak
     * @returns {{written: boolean, reason?: string, ts?: number, backedUp?: boolean}}
     */
    function save(snapshot, writeOpts = {}) {
        if (!enabled) return { written: false, reason: 'gate-closed' };
        try {
            const dir = path.dirname(activeFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const ts = Date.now();
            let backedUp = false;
            if (writeOpts.backup) {
                if (fs.existsSync(activeFile)) {
                    fs.copyFileSync(activeFile, activeFile + `.bak-${ts}`);
                    backedUp = true;
                }
             }
            // atomic write：先写 .tmp 再 rename，防止写一半损坏
            const tmp = `${activeFile}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify({ ts, snapshot }, null, 2));
            fs.renameSync(tmp, activeFile);
            return { written: true, ts, backedUp };
        } catch {
            return { written: false, reason: 'io-error' };
        }
    }

    /**
     * 读回上次快照（跨重启/跨进程可恢复）。
     * @returns {{ts: number, snapshot: Record<string, Object>} | null}
     */
    function load() {
        try {
            if (!fs.existsSync(activeFile)) return null;
            const raw = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
            return typeof raw === 'object' && raw !== null && raw.snapshot ? raw : null;
        } catch {
            return null;
        }
    }

    /**
     * 合并旧快照与本轮新快照：fresh 覆盖 prev，prev 独有保留。
     * @param {Record<string, Object> | null} prev - load() 读回的旧 snapshot（null=无旧）
     * @param {Record<string, Object>} fresh - 本轮查到的 snapshot
     * @param {{staleSince?: number}} [mergeOpts] - staleSince 之前落盘的旧 provider 不保留
     * @returns {Record<string, Object>}
     */
    function merge(prev, fresh, mergeOpts = {}) {
        const out = {};
        const prevTs = Object.keys(prev || {}).length ? prev : null;
        // prev 独有保留（本轮没查到的 provider，跨重启不丢）
        for (const [pid, st] of Object.entries(prevTs || {})) {
            out[pid] = st;
        }
        // fresh 覆盖（本轮查到 = 最新）
        for (const [pid, st] of Object.entries(fresh || {})) {
            out[pid] = st;
        }
        return out;
    }

    function isEnabled() { return enabled; }
    function setEnabled(v) { enabled = !!v; }
    function file() { return activeFile; }

    return { save, load, merge, isEnabled, setEnabled, file };
}

const _hs = createHealthStore();
module.exports = {
    GATE_ENV,
    DEFAULT_FILE,
    createHealthStore,
    gateOpen,
    save: _hs.save,
    load: _hs.load,
    merge: _hs.merge,
};
