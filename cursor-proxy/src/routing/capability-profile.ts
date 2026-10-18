// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// P0-1 capability profile — 能力画像（2026-09-30 路由能力矩阵 P0-1 交付）
//
// 问题：cost-optimization 只看价，不看「这个模型会不会做这个任务」。
//   例：agnes-3.0-flash 最便宜，但不擅长 vision / high-quality writing，
//   纯比价会把它选去做 vision 任务 → 质量翻车。
//
// 设计（§4.1 路由能力矩阵 P0-1）：
//   - Candidate 新增可选 capability? 字段（TaskType → 能力档位）
//   - taskType 过滤：候选 capability[taskType] <= 当前 task quality 需求 → 排除
//   - 无 profile / profile[taskType] 缺失 → 视为「未知」，不排除（向后兼容：
//     旧 candidate 无 capability 字段时行为等同现状，纯 cost 排序）
//   - 过滤后无候选（全部被能力排除）→ 回退到 cost-only（避免 0 结果）
//
// 默认 profile（4 模型，2026-09-30 依据路由能力矩阵 §3 + 实测经验）：
//   qwen3.8:27b-mlx   — coding 强 / writing 强 / vision 中 / general 强
//   deepseek-v4-pro   — coding 强 / writing 中 / vision 中 / general 中
//   agnes-3.0-flash   — coding 弱 / writing 弱 / vision 弱 / general 中
//   kimi-k2.6         — coding 中 / writing 强 / vision 中 / general 中
//
// 门控：PROXY_CAPABILITY_FILTER 不设 / 非 '0'（默认）→ 开启过滤（已是路由热路径的一部分，
//       见 routeEngine.ts pickByCost 的 filterByCapability 调用）。
//       PROXY_CAPABILITY_FILTER='0' → 显式关闭，行为等同现状（纯 cost 排序）。
//
// P0-2（2026-10-15 TokenSaver 借鉴）：在 DEFAULT 之上叠加校准 override 层（resolveProfile /
//   recordCalibration），用实际路由结果反推档位；override 默认空、recordCalibration 默认关，
//   不破老行为。详见各函数注释与 multi-proxy/docs/10-initiatives/capability-profile-TokenSaver改造计划-2026-10-15.md。

import type { RouteCandidate } from './routeEngine.js';

/**
 * task capability 档位：
 *   0 = none（不做）
 *   1 = basic（能做，精度低）
 *   2 = good（能做，精度中高）
 *   3 = strong（能做，精度极高）
 */
export type CapabilityLevel = 0 | 1 | 2 | 3;

/** taskType → 该模型能达到的能力档位 */
export type CapabilityProfile = Partial<Record<string, CapabilityLevel>>;

/**
 * 质量需求 → 最低能力档位。
 * quality='high' → 至少 2（good）
 * 默认（无 quality）→ 至少 1（basic）
 */
const QUALITY_REQUIRED: Record<string, CapabilityLevel> = {
  high: 2,
  // quality 缺省 = basic 需求
};

/**
 * 默认 4 模型能力画像。
 * 来源：路由能力矩阵 §3 + 2026-09-30 实跑经验 + 本地 Qwen 多模态实测。
 * 数值为保守估计，后续可凭 P0-2 feedback loop 数据校准。
 */
export const DEFAULT_CAPABILITY_PROFILES: Record<string, CapabilityProfile> = {
  'qwen3.8:27b-mlx': {
    coding: 3,  // 本地 27B，代码生成强
    writing: 3, // 中文长文强
    vision: 2,  // 多模态，实测 729 图 → 1080p 视频
    general: 3, // 通用强
  },
  'deepseek-v4-pro': {
    coding: 3,  // deepseek coding 强
    writing: 2,
    vision: 1,  // 文本为主
    general: 2,
  },
  'agnes-3.0-flash': {
    coding: 1,  // flash 类，轻任务
    writing: 1,
    vision: 0,  // 免费 flash 不擅长 vision
    general: 1,
  },
  'kimi-k2.6': {
    coding: 2,
    writing: 3, // kimi 长文强
    vision: 2,  // 多模态
    general: 2,
  },
};

/**
 * P0-2（TokenSaver 借鉴 2026-10-15）：校准 override 层。
 * 来源母题：PilotDeck TokenSaver「按难度分级 → 自适应模型调度」。
 * 立场：借「难度→调度」设计，不引入其实现；override 不入静态文件（避免手拍回潮），
 *       由 L2 feedback loop 把实际跑出来的结果折算成档位写回。
 *
 * 门控：capabilityOverrideStore 默认空 → resolveProfile 等于 DEFAULT（向后兼容，等同 P0-1）。
 *       recordCalibration 仅在 PROXY_CAPABILITY_CALIBRATION='1' 时写 override（默认不写）。
 */
const capabilityOverrideStore: Record<string, CapabilityProfile> = {};

/** 解析某模型能力画像：默认 ∪ 校准 override（override 优先）。 */
export function resolveProfile(modelId: string): CapabilityProfile | undefined {
  const def = DEFAULT_CAPABILITY_PROFILES[modelId];
  const ov = capabilityOverrideStore[modelId];
  if (!def && !ov) return undefined;
  return { ...def, ...ov };
}

/**
 * P0-2 校准入口：L2 feedback loop 把「某次路由结果」折算成档位写回 override。
 * 仅在 PROXY_CAPABILITY_CALIBRATION='1' 时生效（默认关 → 不写，行为等同 P0-1）。
 * 统计与置信护栏（下调需更高样本）在 L2 侧完成，本函数只做「合并写入」。
 */
export function recordCalibration(modelId: string, taskType: string, level: CapabilityLevel): void {
  if (process.env.PROXY_CAPABILITY_CALIBRATION !== '1') return;
  if (!capabilityOverrideStore[modelId]) capabilityOverrideStore[modelId] = {};
  capabilityOverrideStore[modelId][taskType] = level;
}

/**
 * 判断候选是否「能力不足」。
 *
 * 规则：
 *   - 无 capability profile → 不排除（向后兼容）
 *   - profile[taskType] 缺失 → 不排除（未知即不排）
 *   - profile[taskType] < 质量需求 → 排除
 */
function isCapabilityFiltered(
  candidate: RouteCandidate,
  taskType: string,
  quality?: string,
  profile?: CapabilityProfile,
): boolean {
  // 门控关 → 不过滤
  if (process.env.PROXY_CAPABILITY_FILTER === '0') return false;

  const p = profile ?? resolveProfile(candidate.id);
  if (!p) return false; // 无 profile → 不排除

  const level = p[taskType];
  if (level === undefined) return false; // 未知 → 不排除

  const required = QUALITY_REQUIRED[quality ?? ''] ?? 1;
  return level < required;
}

/**
 * P0-1 能力过滤：在 cost rank 之前，排除能力不足的候选。
 *
 * 向后兼容：
 *   - candidate 无 capability 字段 → 不过滤
 *   - 过滤后 0 候选 → 回退到原 candidate 列表（不产假结果）
 *   - PROXY_CAPABILITY_FILTER='0' → 不过滤
 */
export function filterByCapability(
  candidates: RouteCandidate[],
  taskType: string,
  quality?: string,
): RouteCandidate[] {
  const filtered = candidates.filter(
    (c) => !isCapabilityFiltered(c, taskType, quality),
  );
  // 全部被排除时回退（防 0 结果）
  return filtered.length > 0 ? filtered : candidates;
}
