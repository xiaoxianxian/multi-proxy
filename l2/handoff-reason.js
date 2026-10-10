// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// l2 · handoff-reason：同会话切模型/切 agent 的**交接触发器契约 + 循环熔断 guard**。
//
// 来源：agent-infra/handoff-contract.md §4（触发器）+ §5（循环熔断）。
// 市面共识（RayLabs HandoffReason / The Orchestrators / AWS Well-Architected）：
//   - 触发器描述「为什么移交所有权」，不是「出了个异常」；
//   - 不是每个错误都该切——瞬态→重试，确定性失败→留当前 owner，配额耗尽→持久化再切；
//   - 多 agent 切模型会乒乓（A 甩给 B、B 甩回 A），要记录已访问 + 切换次数上限 + 超时兜底升给人。
//
// 定位：纯决策模块（route-engine.js 是「按 complexity 选 provider」，本模块补「该不该换 owner」）。
// 默认全关、零行为变更——要启用得显式 new HandoffGuard({ enabled: true })。
// 与 l2/circuit-breaker.js 的关系：circuit-breaker 管「provider 健康态熔断（CLOSED/OPEN/HALF_OPEN）」，
// 本模块管「所有权移交的触发 + 移交本身的循环防护」，两层正交，circuit-breaker 是它读的健康源。

// 触发器枚举（§4）。每个带 reason，进 shadow 日志可观测、可回放。
const HandoffReason = Object.freeze({
  PROVIDER_UNAVAILABLE: 'ProviderUnavailable',   // 限流/挂了 → 降级到备选
  USAGE_LIMIT_REACHED: 'UsageLimitReached',      // 配额耗尽 → 持久化状态再切
  MISSING_CAPABILITY: 'MissingCapability',       // 缺工具 → 换有工具的模型
  SPECIALIST_REQUIRED: 'SpecialistRequired',      // 该找专家 → 移交专项
  VERIFICATION_FAILURE: 'VerificationFailure',    // 验证不过 → 退回实施方（带证据）
});

// 「不该自动切」的错误分类（§4 关键铁律：不是每个错误都该切）。
// 输入是 error 特征，输出是「该做的动作」而非一律切。
const _TRANSIENT = /rate.?limit|429|timeout|ECONNRESET|503|502|temporar/i;
const _DETERMINISTIC = /EISDIR|ENOENT|syntax|schema|400|invalid.?arg|assert/i;

/**
 * 把一次错误分类成「该做的动作」。
 * @param {object} err { code?, status?, message? }
 * @returns {{reason: string|null, action: 'retry'|'stay-owner'|'handoff', note: string}}
 *   - retry       瞬态（限流/超时/网络）→ 先重试，别急着切
 *   - stay-owner  确定性失败（400/schema/语法）→ 留在当前 owner 诊断，切了也修不好
 *   - handoff     确属该移交的所有权变化（见 reason）
 */
function classifyError(err) {
  const m = (err && (err.message || err.code || err.status)) || '';
  const s = String(m);
  if (_DETERMINISTIC.test(s)) {
    return { reason: null, action: 'stay-owner', note: '确定性失败（400/schema/语法），切模型修不好，留当前 owner 诊断' };
  }
  if (/quota|exceed.?limit|insufficient.?balance|403/.test(s)) {
    return { reason: HandoffReason.USAGE_LIMIT_REACHED, action: 'handoff', note: '配额/余额耗尽，持久化状态再切备选' };
  }
  if (_TRANSIENT.test(s)) {
    // 瞬态：先给重试机会；只有「反复瞬态仍失败」才升级成 ProviderUnavailable 移交。
    // 这里返回 retry，调用方累计到阈值后再换 reason。
    return { reason: HandoffReason.PROVIDER_UNAVAILABLE, action: 'retry', note: '瞬态（限流/超时），先重试，重试耗尽再移交' };
  }
  // 未知错误：保守——不自动切，留人判断（避免误切掩盖真问题）。
  return { reason: null, action: 'stay-owner', note: '未知错误，保守不自动切，留人判断' };
}

// ─────────────────────────────────────────────────────────────
// §5 循环熔断 guard：防「两个 agent 互相甩锅」。
// 市面共识：记录本会话已访问的模型集合 + 给切换次数设上限 + 超时兜底升给人。
// ─────────────────────────────────────────────────────────────
class HandoffGuard {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=false]      默认关（零行为变更）
   * @param {number}  [opts.maxHandoffs=3]      本会话最多自动切几次，超过→升级给人
   * @param {number}  [opts.maxVisited=6]        最多访问几个不同模型，超过→升级给人
   * @param {number}  [opts.escalateAfterMs=0]  0=不用全局超时；>0=距上次成功移交超过 N ms 仍未解决→升级
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled === true;
    this.maxHandoffs = Number.isFinite(opts.maxHandoffs) ? opts.maxHandoffs : 3;
    this.maxVisited = Number.isFinite(opts.maxVisited) ? opts.maxVisited : 6;
    this.escalateAfterMs = Number.isFinite(opts.escalateAfterMs) ? opts.escalateAfterMs : 0;
    this._visited = new Set();      // 已访问的模型 id（乒乓检测）
    this._handoffCount = 0;         // 自动移交累计次数
    this._lastHandoffAt = 0;        // 上次移交时间戳（超时兜底）
  }

  /** 记一次模型访问（route() 选中某模型后调） */
  markVisited(modelId) {
    if (!this.enabled || !modelId) return;
    this._visited.add(modelId);
  }

  /**
   * 问：现在该不该自动移交到 nextModelId？
   * @param {string} nextModelId 目标模型
   * @returns {{allow: boolean, reason: string, guard: 'ok'|'max-handoff'|'max-visited'|'ping-pong'|'timeout'}}
   *   allow=false 时 reason 说明卡在哪条（调用方据此升级给人，不再自动切）。
   */
  shouldHandoff(nextModelId) {
    if (!this.enabled) return { allow: true, reason: 'guard-off', guard: 'ok' };

    // 乒乓：目标模型已在访问集合里（甩回旧主）→ 不放行
    if (nextModelId && this._visited.has(nextModelId)) {
      return { allow: false, reason: `target ${nextModelId} already visited (ping-pong)`, guard: 'ping-pong' };
    }
    // 切换次数上限
    if (this._handoffCount >= this.maxHandoffs) {
      return { allow: false, reason: `auto-handoff budget exhausted (${this._handoffCount}/${this.maxHandoffs})`, guard: 'max-handoff' };
    }
    // 访问广度上限
    if (this._visited.size >= this.maxVisited) {
      return { allow: false, reason: `visited models cap reached (${this._visited.size}/${this.maxVisited})`, guard: 'max-visited' };
    }
    // 全局超时兜底（距上次移交太旧仍未解决 → 升级给人，不无限切）
    if (this.escalateAfterMs > 0 && this._lastHandoffAt > 0 &&
        (Date.now() - this._lastHandoffAt) > this.escalateAfterMs) {
      return { allow: false, reason: `no progress since last handoff > ${this.escalateAfterMs}ms`, guard: 'timeout' };
    }
    // 放行：记账
    this._handoffCount += 1;
    this._lastHandoffAt = Date.now();
    if (nextModelId) this._visited.add(nextModelId);
    return { allow: true, reason: 'ok', guard: 'ok' };
  }

  /** 重置（新会话/新任务） */
  reset() {
    this._visited.clear();
    this._handoffCount = 0;
    this._lastHandoffAt = 0;
  }

  /** 观测快照（进 shadow 日志 / 健康看板） */
  snapshot() {
    return {
      enabled: this.enabled,
      handoffCount: this._handoffCount,
      maxHandoffs: this.maxHandoffs,
      visited: [...this._visited],
      visitedSize: this._visited.size,
      maxVisited: this.maxVisited,
      lastHandoffAt: this._lastHandoffAt,
      escalateAfterMs: this.escalateAfterMs,
    };
  }
}

module.exports = {
  HandoffReason,
  classifyError,
  HandoffGuard,
};
