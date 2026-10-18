// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// l2 · sentinel-guard：不可逆动作前的确认闸门 + 三级许可记忆（nanoMuse Sentinel 借鉴，2026-10-15）。
//
// 来源母题：nanoMuse（浙大 APRIL）Sentinel —— 删东西 / 发东西 / 付钱之前先问一句，并记住许可偏好。
// 立场：只借设计（先问 + 三级记忆），不接 Swift 代码；许可本地优先，不出本机。
//
// 与 l2/circuit-breaker.js 的关系：circuit-breaker.handoffGuard 管 §5 循环熔断（该不该切 owner），
//   本模块管「不可逆动作该不该先确认」。二者正交，都通过 circuit-breaker.allowRequest 的并行挂点注入
//   （circuit-breaker 新增 sentinelGuard 字段，默认 null → 零行为变更）。
//
// 三级许可记忆：
//   once    —— 这一次（用后即焚，下次再问）
//   session —— 本会话（进程内存，重启即忘）
//   always  —— 总是允许 / 总是拒绝（可落本地 JSON，跨会话）

/** 许可级别 */
const PERM_LEVELS = Object.freeze({ ONCE: 'once', SESSION: 'session', ALWAYS: 'always' });
/** 许可决策 */
const DECISIONS = Object.freeze({ ALLOW: 'allow', DENY: 'deny' });

class SentinelGuard {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=false]      默认关（零行为变更）
   * @param {Function} [opts.notify]            需要确认时的回调（L2 注入真实通知通道）；不传→默认拦
   * @param {string} [opts.persistPath=null]    本地 JSON 持久化路径（仅 ALWAYS 级别落盘，不出本机）
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled === true;
    this._notify = typeof opts.notify === 'function' ? opts.notify : null;
    this._persistPath = opts.persistPath || null;
    /** @type {Map<string, {level:string, decision:string}>} */
    this._memory = new Map();
    if (this._persistPath) this._load();
  }

  /** action + target → 归一 key（例如 "delete:ctx:project-x"） */
  _key(action, target) {
    return `${action}::${target || ''}`;
  }

  /** 从本地 JSON 载入 ALWAYS 级记忆（仅持久化部分） */
  _load() {
    try {
      const fs = require('node:fs');
      if (!fs.existsSync(this._persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this._persistPath, 'utf8') || '{}');
      for (const [k, v] of Object.entries(raw)) {
        if (v && v.level === PERM_LEVELS.ALWAYS) this._memory.set(k, v);
      }
    } catch (_e) { /* 损坏文件不致命：当作无记忆，下次确认后重写 */ }
  }

  /** 把 ALWAYS 级记忆落本地 JSON（许可不出本机） */
  _persist() {
    if (!this._persistPath) return;
    try {
      const fs = require('node:fs');
      const obj = {};
      for (const [k, v] of this._memory) {
        if (v.level === PERM_LEVELS.ALWAYS) obj[k] = v;
      }
      fs.writeFileSync(this._persistPath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (_e) { /* 持久化失败不阻断主流程 */ }
  }

  /**
   * 问：这次不可逆动作能不能直接做？
   * 无记忆 → 默认拦（安全），并触发 notify（若注入）让 L2 向用户/老板发确认请求。
   * @param {string} action  动作类型（如 'delete' / 'send' / 'pay' / 'handoff'）
   * @param {string} [target] 作用对象（如 project-id / provider-id）
   * @returns {{allow: boolean, reason: string, memory: string|null}}
   */
  shouldProceed(action, target) {
    if (!this.enabled) return { allow: true, reason: 'sentinel-off', memory: null };
    const key = this._key(action, target);
    const m = this._memory.get(key);
    if (m) {
      const allow = m.decision === DECISIONS.ALLOW;
      if (m.level === PERM_LEVELS.ONCE) {
        // 用后即焚：本次放行后删除，下次仍问
        this._memory.delete(key);
        return { allow, reason: `once-${m.decision}`, memory: PERM_LEVELS.ONCE };
      }
      return { allow, reason: `${m.level}-${m.decision}`, memory: m.level };
    }
    // 无记录 → 需确认（默认拦；注入 notify 则由 L2 弹确认）
    if (this._notify) this._notify({ action, target, key });
    return { allow: false, reason: 'needs-confirmation', memory: null };
  }

  /**
   * 记录一次许可决策（确认拿到后由 L2 调用）。
   * @param {string} action
   * @param {string} [target]
   * @param {string} [level='session']  'once' | 'session' | 'always'
   * @param {string} [decision='allow'] 'allow' | 'deny'
   */
  record(action, target, level = PERM_LEVELS.SESSION, decision = DECISIONS.ALLOW) {
    const key = this._key(action, target);
    if (level === PERM_LEVELS.ONCE) {
      // once 不长期存；由 shouldProceed 用后即焚。这里记本次放行。
      this._memory.set(key, { level: PERM_LEVELS.ONCE, decision });
      return;
    }
    this._memory.set(key, { level, decision });
    this._persist();
  }

  /** 清除某 key 的记忆（撤销许可） */
  forget(action, target) {
    this._memory.delete(this._key(action, target));
    this._persist();
  }

  /** 观测快照（进 18791 面板「待确认队列」） */
  snapshot() {
    const entries = {};
    for (const [k, v] of this._memory) entries[k] = v;
    return {
      enabled: this.enabled,
      pending: this._notify ? 'wired' : 'blocked(no-notify)',
      memory: entries,
      memorySize: this._memory.size,
    };
  }
}

// L2 共享单例（2026-10-15 并入热路径接入点）：
//   默认 enabled=false → 零行为变更；要激活，调用 getSentinel({ enabled: true }) 拿到同一实例。
//   激活后仍只在「真实不可逆动作调用点」显式 shouldProceed(action, target) 时生效；
//   切勿在 circuit-breaker.allowRequest 全局开启——无记忆即拦会阻断所有普通请求。
//   正确的激活路径：在 delete / send / pay 等调用点写
//     const v = getSentinel().shouldProceed('delete', projectId);
//     if (!v.allow) { 弹出确认；拿到许可后 getSentinel().record('delete', projectId, level); }
let _sharedSentinel = null;
function getSentinel(opts = {}) {
  if (!_sharedSentinel) _sharedSentinel = new SentinelGuard(opts);
  return _sharedSentinel;
}

module.exports = { SentinelGuard, PERM_LEVELS, DECISIONS, getSentinel };
