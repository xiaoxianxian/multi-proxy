// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// Action Audit — 外部动作审计（B 类副作用故障的对账底账）
//
// 为什么单独立一个（跟 logger.js 的分工，别重复记账）：
//   logger.js 记的是**请求日志**——谁在什么时候调了哪个模型、花了多少 token。
//   本模块记的是**业务动作审计**——谁在什么时候改了什么业务数据、结果到哪一步。
//   两者不是一个靶子：请求成功 ≠ 业务动作完成（重试类故障 vs 副作用类故障的分野，详见项目内部方法论文档）。
//
// 核心设计：显式支持 unknown 态。
//   对副作用操作，最危险的状态不是「明确失败」，而是「不知道是否已经成功」——
//   客户端没收到回执、源系统可能已受理。审计表必须能把这个态记下来，
//   否则对账时只能靠猜（这正是原文那张「先查原动作再决定重试」图的落点）。
//
// 非侵入：默认不写盘（enabled 需显式传 true 或设 env）。零行为变更铁律。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = path.join(os.homedir() || '', '.multi-proxy-manager');
const FILENAME = 'action-audit.log';

// 动作结果五态。unknown 是本模块存在的核心理由，不是凑数。
//   proposed  = 模型提出动作，尚未校验权限
//   accepted  = 受控服务已受理（回执），但业务未确认完成
//   completed = 源系统确认完成（唯一可作为「正式结论」的态）
//   failed    = 明确失败（可安全重试的前提之一）
//   unknown   = 不知道成没成（禁止盲目重试，必须先对账）
const ACTION_RESULTS = ['proposed', 'accepted', 'completed', 'failed', 'unknown'];

class ActionAudit {
    constructor({ dir = DEFAULT_DIR, enabled = null, capacity = 5000 } = {}) {
        this.dir = dir;
        this.file = path.join(dir, FILENAME);
        // 门控默认关；env 可开（与 curator policy 的 env 约定同族，但本模块不走 curator）
        this.enabled = enabled === null
            ? process.env.MULTI_PROXY_ACTION_AUDIT === '1'
            : Boolean(enabled);
        this.capacity = capacity;
        this._count = 0;
    }

    /**
     * 记一条动作审计。
     * @param {object} entry
     *   actor         {string} 谁发起的（调用者/agent 标识）——「谁改了」的答案
     *   action        {string} 动作名（如 'update:order.delivery_date'）
     *   resource      {string} 作用于什么资源（如 'order:12345@v7'）——含业务版本
     *   idempotencyKey{string} 幂等键，与 session-store.addStep 的 idempotencyKey 同一口径
     *   result        {string} ACTION_RESULTS 之一
     *   sourceOfTruth {string} 这个结果由谁确认：'source-system'|'gateway-receipt'|'model-inference'
     *   meta          {object} 其他（traceId、sessionId、耗时等）
     * @returns {object|null} 落盘的完整条目；未启用时返回 null（不写盘）
     */
    record(entry = {}) {
        if (!this.enabled) return null;
        const result = ACTION_RESULTS.includes(entry.result) ? entry.result : 'unknown';
        const full = {
            ts: new Date().toISOString(),
            actor: entry.actor || null,
            action: entry.action || null,
            resource: entry.resource || null,
            idempotencyKey: entry.idempotencyKey || null,
            result,
            sourceOfTruth: entry.sourceOfTruth || null,
            meta: entry.meta || {},
        };
        this._append(full);
        return full;
    }

    _append(full) {
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
            fs.appendFileSync(this.file, JSON.stringify(full) + '\n', { encoding: 'utf8', mode: 0o600 });
            this._count++;
            // 超容量后截断保留最后 capacity 行（与 logger.js 的 trim 思路同族，但阈值独立）
            if (this._count >= this.capacity) {
                this._trim();
                this._count = 0;
            }
        } catch {
            // 审计写盘失败不阻断主流程（best-effort）；主流程不该被审计拖垮
        }
    }

    _trim() {
        try {
            if (!fs.existsSync(this.file)) return;
            const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
            fs.writeFileSync(this.file, lines.slice(-this.capacity).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
        } catch { /* best-effort */ }
    }

    /**
     * 对账查询：按 idempotencyKey 查该动作的历史记录（B 类故障「先查原动作」的落点）。
     * @returns {Array} 命中条目（按时间正序）
     */
    queryByIdempotencyKey(idempotencyKey) {
        if (!idempotencyKey) return [];
        return this._readAll().filter((e) => e.idempotencyKey === idempotencyKey);
    }

    /**
     * 查某个资源的动作历史（回答「这张订单到底被改过几次、每次到哪一步」）。
     */
    queryByResource(resource) {
        if (!resource) return [];
        return this._readAll().filter((e) => e.resource === resource);
    }

    /**
     * 列出仍处于 unknown 的动作。
     *
     * ⚠️ 待对账队列请优先用 queryUnresolved()，不要只用这个 —— 它会漏掉
     *    崩溃留下的 proposed 孤儿（见 queryUnresolved 的说明）。
     *    本方法保留语义：严格筛 result === 'unknown'。
     */
    queryUnknown() {
        return this._readAll().filter((e) => e.result === 'unknown');
    }

    /**
     * 列出「未终结」的动作 —— 待对账队列的真实定义。
     *
     * 🔴 为什么不能只用 queryUnknown()：
     *    进程在「执行前记了 proposed」之后猝死，账本里留下的是一条**没有后续的
     *    proposed 孤儿**，result 是 'proposed' 而不是 'unknown'。
     *    这是崩溃场景最典型的形态，只查 unknown 会把整笔烂账漏掉
     *    （2026-10-07 真实 SIGKILL 演练实测发现，非推演）。
     *
     * 判定：按 idempotencyKey 分组，取每个 key 的最后一条；
     *       最后一条 result 不在终态 { completed, failed } 里 → 未终结，需要对账。
     *       completed = 成了，failed = 明确没成，两者都有确定答案，不必再查。
     *       proposed / accepted / unknown 都算没答案。
     */
    queryUnresolved() {
        const TERMINAL = ['completed', 'failed'];
        const lastByKey = new Map();
        for (const e of this._readAll()) {
            if (!e.idempotencyKey) continue;
            const prev = lastByKey.get(e.idempotencyKey);
            // 文件顺序即写入顺序；再用 ts 兜底，避免跨进程写入时时间乱序
            if (!prev || String(e.ts || '') >= String(prev.ts || '')) {
                lastByKey.set(e.idempotencyKey, e);
            }
        }
        return [...lastByKey.values()].filter((e) => !TERMINAL.includes(e.result));
    }

    _readAll() {
        if (!fs.existsSync(this.file)) return [];
        try {
            return fs.readFileSync(this.file, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => { try { return JSON.parse(l); } catch { return null; } })
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    count() {
        return this._readAll().length;
    }
}

module.exports = { ActionAudit, ACTION_RESULTS, FILENAME };
