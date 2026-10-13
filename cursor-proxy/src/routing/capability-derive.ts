// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * M6 方向四 · P0-2 → P0-1 最后一环（2026-10-13 落地，weave-os/router 对照借鉴）
 *
 * 问题：capability-profile.ts 的 4 模型数值（qwen coding:3 / agnes vision:0 …）
 *   全是「人拍的假设」（文件头注释自认「依据实跑经验」），路由能力矩阵 §2.3 的
 *   evidence 字段至今全空。weave-os/router 用 scorer 把「能力维」做成可回源数据；
 *   我们的等价路径不是训 scorer，而是**把 P0-2 已落库的 shadow 观测回写成画像证据**——
 *   数据已在 routing_feedback 表里（task_type × model × latency/retried/转发数），
 *   缺的只是「聚合 → 画像」这最后一环。
 *
 * 本模块是**纯函数**（无 db、无网络、无副作用）：吃 aggregateFeedback 的聚合行，
 *   产出带 source + date + 阈值判据的 capability 证据，供人工校准 DEFAULT_CAPABILITY_PROFILES。
 *
 * 设计纪律（对齐 l2/ 内核 + 路由能力矩阵 §4「明确不做」）：
 *   - **纯函数**：输入聚合行 → 输出证据，可单测钉死边界（镜像 pricing-schedule.js 的纯函数层）。
 *   - **不自动回写 profile**：产出的是「建议 + 证据」，是否把数值改进 DEFAULT_CAPABILITY_PROFILES
 *     归人工拍板（能力档位有语义，自动改会让画像漂移成假数据——与「宁可留个明处的缺口」同一条纪律）。
 *   - **诚实边界**：数据不足（转发数 < 阈值）的格子**留空标「样本不足」**，绝不凑数；
 *     与 capability-profile.ts「无 profile 的模型不排除」的向后兼容口径一致。
 *   - **零热路径改动**：本模块不被 routeEngine / chatHandler 引用，仅 admin 端点 / 离线脚本消费。
 */
import type { AggregateFeedbackRow } from './routeFeedback.js';

// ---- 阈值（纯函数判据；可经 deriveCapabilityEvidence 的 opts 覆盖，默认值即「保守」）----

export interface DeriveOptions {
  /** 最少转发样本数。低于此数的格子判「样本不足」，不出档位。默认 20（≈一周真实流量起步量级）。 */
  minSamples?: number;
  /** 重试率上限。重试率 > 此值判能力档位降一级（重编码类任务上重试频繁 = 该模型不够稳）。默认 0.2。 */
  maxRetryRate?: number;
  /** 延迟上限（ms）。中位延迟 > 此值的格子判「偏慢」，档位封顶 2（good），不许标 3（strong）。默认 8000。 */
  latencyCeilingMs?: number;
}

const DEFAULT_OPTS: Required<DeriveOptions> = {
  minSamples: 20,
  maxRetryRate: 0.2,
  latencyCeilingMs: 8000,
};

/** capability 档位（与 capability-profile.ts 的 CapabilityLevel 同口径，数值语义一致）。 */
export type DerivedCapabilityLevel = 0 | 1 | 2 | 3;

/** 一条回写证据。source/date 强制带，对齐 pricing.source 纪律（路由能力矩阵 §3 启示 3）。 */
export interface CapabilityEvidence {
  model: string;
  taskType: string;
  /** 建议档位。样本不足时为 null（**绝不折算 0 冒充「弱」**——0 语义是「不做」，留空才诚实）。 */
  suggestedLevel: DerivedCapabilityLevel | null;
  samples: number;          // 该 taskType×model 的总记录数（含未转发）
  forwarded: number;       // 有 latency 的真转发数（判据基于它，不是总记录数）
  medianLatencyMs: number | null;  // 中位延迟；样本不足/无转发 → null（绝不折算 0）
  retryRate: number | null;        // 重试率；样本不足 → null
  /** 判据可复现记录：为什么是这个档位（人读，不是黑盒 scorer 的「训练产物」）。 */
  rationale: string;
  source: string;          // 证据来源（恒为 'routing_feedback 聚合'，非 scorer）
  date: string;            // 推导日（离线跑时由调用方传入或取当天）
}

/**
 * 单格判据：由「转发数 + 代表延迟 + 重试率」推一个能力档位。
 *
 * 判据（保守、可单测钉死边界）：
 *   1. forwarded < minSamples        → suggestedLevel = null（样本不足，留空）
 *   2. 中位延迟 > latencyCeilingMs    → 封顶 2（再稳也不算 strong）
 *   3. 重试率 > maxRetryRate          → 在封顶内再降一级（下限 0，不降成负）
 *   4. 全部达标                       → 3（strong）
 *
 * 注意：aggregateFeedback 目前只给 AVG(latency)，这里复用为「代表延迟」做封顶判断；
 *   真正的中位延迟待 P0-2 二期给（MEDIAN 列），届时把本入参换成 medianLatencyMs 即可，
 *   判据签名不变（纯函数，加列不影响调用方）。
 */
function judgeOneCell(
  taskType: string,
  forwarded: number,
  avgLatencyMs: number | null,
  retryRate: number | null,
  o: Required<DeriveOptions>,
): { level: DerivedCapabilityLevel | null; rationale: string; insufficient: boolean } {
  // taskType 进 rationale：让每条判据可读「是哪个任务档推出来的」，不留未用参数。
  const cell = `[${taskType}]`;
  if (forwarded < o.minSamples) {
    return {
      level: null,
      insufficient: true,
      rationale: `${cell} 样本不足（转发 ${forwarded} < 阈值 ${o.minSamples}），留空标「待实测」，不折算`,
    };
  }
  let level: DerivedCapabilityLevel = 3;
  const reasons: string[] = [];
  if (avgLatencyMs != null && avgLatencyMs > o.latencyCeilingMs) {
    level = 2;
    reasons.push(`延迟 ${avgLatencyMs}ms > 上限 ${o.latencyCeilingMs}ms → 封顶 good(2)`);
  }
  if (retryRate != null && retryRate > o.maxRetryRate) {
    level = Math.max(0, level - 1) as DerivedCapabilityLevel;
    reasons.push(`重试率 ${(retryRate * 100).toFixed(0)}% > 上限 ${(o.maxRetryRate * 100).toFixed(0)}% → 降一级`);
  }
  if (reasons.length === 0) reasons.push('延迟与重试率均达标 → strong(3)');
  return { level, rationale: `${cell} ${reasons.join('；')}`, insufficient: false };
}

/**
 * 入口：把聚合行批量推导为 capability 证据（纯函数，不写任何文件/表）。
 *
 * @param rows  aggregateFeedback(days) 的返回（按 task_type, model 分组）
 * @param opts  阈值覆盖（默认保守：minSamples=20 / retry≤20% / 延迟≤8s）
 * @param asOf  推导日（ISO 日期）。缺省取当天（调用方离线跑时显式传，避免跨天漂移）。
 * @returns 证据数组（每行一格；样本不足格 suggestedLevel=null，**保留在结果里**，
 *          让「哪些格子还没数据」可见——诚实边界，不静默丢掉）。
 */
export function deriveCapabilityEvidence(
  rows: Array<Record<string, unknown>>,
  opts?: DeriveOptions,
  asOf?: string,
): CapabilityEvidence[] {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  const date = asOf || new Date().toISOString().slice(0, 10);
  const out: CapabilityEvidence[] = [];
  for (const r of rows) {
    const row = r as unknown as AggregateFeedbackRow;
    const taskType = String(row.task_type || '');
    const model = String(row.model || '');
    const forwarded = Number(row.forwarded) || 0;
    const avgLatencyMs = row.avg_latency_ms == null ? null : Number(row.avg_latency_ms);
    const retryRate = row.retry_rate == null ? null : Number(row.retry_rate);
    const { level, rationale } = judgeOneCell(taskType, forwarded, avgLatencyMs, retryRate, o);
    out.push({
      model,
      taskType,
      suggestedLevel: level,
      samples: Number(row.n) || 0,
      forwarded,
      medianLatencyMs: avgLatencyMs, // 当前源给的是 AVG；二期 MEDIAN 列到位后此语义自动升级
      retryRate,
      rationale,
      source: 'routing_feedback 聚合（P0-2 shadow 观测）',
      date,
    });
  }
  return out;
}

/**
 * 便捷：把证据列表回排成「model → taskType → 建议档位」的画像草稿（人工拍板前对照用）。
 * 样本不足格（suggestedLevel=null）保留为 null，**不填默认值**。
 */
export function toProfileDraft(evidence: CapabilityEvidence[]): Record<string, Record<string, DerivedCapabilityLevel | null>> {
  const draft: Record<string, Record<string, DerivedCapabilityLevel | null>> = {};
  for (const e of evidence) {
    const m = draft[e.model] || (draft[e.model] = {});
    m[e.taskType] = e.suggestedLevel;
  }
  return draft;
}

// 便于离线脚本 / admin 端点直接消费：行类型从 routeFeedback 转一手，不在此造第二份约定。
export type { AggregateFeedbackRow };
