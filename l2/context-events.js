// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// context-events — 帧差事件推断（context-breakdown 口径 §3）
//
// 职责：拿相邻两帧（同 lane 同 clientKey）的 context-fold 输出，推断「上下文被压缩了」
// 这类事件。代理看不到 harness 的 compaction/prune 动作，只能从差推断——
// 所以每个事件都带 inferred:true + basis:'proxy-frame-diff'，是候选不是事实。
//
// 设计原则（与 l2/ 全家桶一致）：
//   - 纯函数：无副作用、不写盘、不读 process.env。
//   - 未知不猜：首帧无参照、total 非有限数 → 不出事件（不是「没变」，是「不知道」）。
//   - 阈值是模块常量不放 env：面板可读、测试可钉；要调先改口径文档再改这里。
//
// 帧的形状（调用方从 context-fold 的 fold() 结果 + 请求元数据组装）：
//   { total, model, toolNames: string[]|null, ts }

/** 大幅收缩才算 compaction 候选：缩量比例。 */
const COMPACT_RATIO = 0.25;
/** compaction 候选的最小绝对缩量（tokens）——小会话抖动不算。 */
const COMPACT_MIN_DROP = 2000;
/** 小幅收缩算 prune 候选的比例下限。 */
const PRUNE_RATIO = 0.05;
/** prune 候选的最小绝对缩量（tokens）。 */
const PRUNE_MIN_DROP = 200;

const BASIS = 'proxy-frame-diff';

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }

function toolSet(names) {
  if (!Array.isArray(names)) return null;
  const s = new Set();
  for (const n of names) { if (typeof n === 'string' && n) s.add(n); }
  return s;
}

function setDiff(a, b) {
  const added = [];
  const removed = [];
  for (const x of a) { if (!b.has(x)) removed.push(x); }
  for (const x of b) { if (!a.has(x)) added.push(x); }
  return { added: added.sort(), removed: removed.sort() };
}

/**
 * 推断两帧之间发生的事件。
 * @param {object|null} prev 上一帧（null = 首帧）
 * @param {object} curr 本帧
 * @returns {Array<object>} 事件数组（可能为空）；每个事件带 inferred:true
 */
function inferEvents(prev, curr) {
  if (!curr || typeof curr !== 'object') return [];
  if (!prev || typeof prev !== 'object') return []; // 首帧：无参照物，不出事件
  if (!finite(prev.total) || !finite(curr.total)) return []; // 未知不猜

  const events = [];

  // ── 上下文收缩（compaction / prune 候选）──
  const dropped = prev.total - curr.total;
  if (dropped > 0) {
    const ratio = dropped / prev.total;
    if (ratio >= COMPACT_RATIO && dropped >= COMPACT_MIN_DROP) {
      events.push({
        kind: 'compaction-candidate',
        inferred: true,
        basis: BASIS,
        droppedTokens: dropped,
        ratio: Math.round(ratio * 1000) / 1000,
      });
    } else if (ratio >= PRUNE_RATIO && dropped >= PRUNE_MIN_DROP) {
      events.push({
        kind: 'prune-candidate',
        inferred: true,
        basis: BASIS,
        droppedTokens: dropped,
        ratio: Math.round(ratio * 1000) / 1000,
      });
    }
    // 更小的收缩：噪声，不记（记了就是制造狼来了）
  }

  // ── 模型切换 ──
  if (typeof prev.model === 'string' && prev.model &&
      typeof curr.model === 'string' && curr.model &&
      prev.model !== curr.model) {
    events.push({ kind: 'model-switch', inferred: true, basis: BASIS, from: prev.model, to: curr.model });
  }

  // ── 工具装载集变化 ──
  const prevTools = toolSet(prev.toolNames);
  const currTools = toolSet(curr.toolNames);
  if (prevTools && currTools && (prevTools.size || currTools.size)) {
    const { added, removed } = setDiff(prevTools, currTools);
    if (added.length || removed.length) {
      events.push({ kind: 'tools-changed', inferred: true, basis: BASIS, added, removed });
    }
  }

  return events;
}

module.exports = {
  COMPACT_RATIO,
  COMPACT_MIN_DROP,
  PRUNE_RATIO,
  PRUNE_MIN_DROP,
  BASIS,
  inferEvents,
};
