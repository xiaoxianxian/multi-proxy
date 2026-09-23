/**
 * Q1 P3 · 价格漂移检测哨兵（架构 §3.2 + §3.10，2026-09-22）
 *
 * 设计：价格/汇率/渠道变动后，路由排序**可能**变化 → 哨兵检测漂移 + 触发覆盖 UX（§3.10）。
 * 老板定论：允许覆盖但不强制，observe 默认关；绝不静默（§3.7 三级兜底 D3）。
 *
 * 检测规则（§3.2 规则表）：
 *    | 单价变动 | 同模型输入/输出单价 | 变化>10% | 写 L2/告警（§3.10 UX）|
 *    | 汇率变动 | fx 变化, USD 模型 | 变化>10% | 告警 |
 *    | 模型新增/删除 | 缓存有/新无; 新有/缓存无 | — | 标记 |
 *    | 排序变动 | 前后 rankByCostCny 序不同 | 排序变化 | 重点告警（critical）|
 *
 * 纯函数：detectDrift 只算报告；是否上线 notify 由门控 PROXY_PRICE_DRIFT_NOTIFY 决定（默认 observe 关）。
 * 去重：24h per-model 抑制（§3.10 PROXY_PRICE_DRIFT_SUPPRESS[name]=<hours>），测试可注入 now + store。
 * 复用 P1：排序检测调 rankByCostCny（§3.2「复用 P1 rankByCostCny」）。
 */
import { rankByCostCny, type Pricing } from './ruleEvaluator.js';

// ---- 阈值 / 去重默认（§3.2 / §3.10）----
export const PRICE_DRIFT_THRESHOLD = 0.1;            // 单价/汇率变动 >10% 触发
export const DRIFT_COOLDOWN_DEFAULT_MS = 24 * 60 * 60 * 1000;   // 24h per-model 抑制
export const DRIFT_SUPPRESS_ENV = 'PROXY_PRICE_DRIFT_SUPPRESS';  // 形如 "deepseek=72"（小时）

// 漂移门控（observe 默认关，与本项目门控一致：非侵入、默认不动现有行为）。
export function isPriceDriftNotifyEnabled(): boolean {
  const v = String(process.env.PROXY_PRICE_DRIFT_NOTIFY ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'enable' || v === 'enabled' || v === 'on';
}

// 抑制窗口解析（§3.10：用户可设 N 天不再提醒；缺省 24h）。
export function suppressMsFor(model: string, envSuppress?: string): number {
  const raw = envSuppress ?? process.env[DRIFT_SUPPRESS_ENV] ?? '';
  const m = raw.split(',').find((pair) => pair.trim().split('=')[0].trim() === model);
  if (m) {
   const h = Number(m.split('=')[1]);
    if (isFinite(h) && h > 0) return h * 60 * 60 * 1000;
   }
  return DRIFT_COOLDOWN_DEFAULT_MS;
}

// 去重：模型在抑制窗口内 → suppressed（§3.10 per-model 24h）。
// lastTriggerMap: model → 上次触发时间戳(ms)。now 可注入（测试）。
export function isSuppressed(
   model: string,
  lastTriggerMap: Record<string, number>,
  now = Date.now(),
  envSuppress?: string,
): boolean {
  const last = lastTriggerMap[model];
  if (last == null) return false;
  if (now - last < suppressMsFor(model, envSuppress)) return true;
  return false;
}

// 百分比变动（old 为 0 时：new 也为 0 → 0；new>0 → 视为 +100%（从免费到收费））。
export function percentDelta(old: number, newV: number): number {
  if (old === 0) return newV === 0 ? 0 : 1;
  return (newV - old) / old;
}

export type DriftSeverity = 'info' | 'warn' | 'critical';

export interface DriftInput {
   model: string;
  channel?: string;
  oldPricing?: Pricing | null;   // 上轮缓存（L2）/ L0 seed
  newPricing?: Pricing | null;   // 本轮刷新价 / L1 用户覆盖
  fx?: number;                   // 当前 USD→CNY 汇率
  fxOld?: number;                // 上轮汇率
  now?: () => number;            // 时钟注入（测试）
  lastTriggerMap?: Record<string, number>;
  envSuppress?: string;
   rankCandidates?: string[];       // 排序检测候选 model 集合（含本 model，前后各跑一次）
  rankInputTokens?: number;
  rankOutputTokens?: number;
}

export interface DriftReport {
  model: string;
  channel?: string;
  timestamp: number;
  // 单价/汇率变动
  priceDelta: { inputPct: number; outputPct: number; fxPct: number };
  // 结构变动
  modelAdded: boolean;   // 新有 / 旧无
  modelRemoved: boolean; // 旧有 / 新无
  // 排序变动（重点告警，§3.2）
  orderChanged: boolean;
  orderBefore?: string[];
  orderAfter?: string[];
  // 综合
  severity: DriftSeverity;
  actionable: boolean;       // 是否该触发覆盖 UX / 告警（§3.10）
  suppressed: boolean;       // 是否在抑制窗口内（去重，§3.10）
  reasons: string[];        // 人类可读理由（§3.10 可读性铁律：不甩乱码，说清下一步）
}

/**
 * 检测一次价格/汇率/排序漂移（纯函数，只算报告；上线由门控决定）。
 *
 * - 旧价与新价都没有 → 无旧基准，无法比 → 仅看模型是否新增（newPricing 有、无缓存）。
 * - 旧价存在、新价消失 → modelRemoved。
 * - 排序变动：仅当提供 rankCandidates 时计算（前后各跑 rankByCostCny，比 model 集合序）。
 * - severity：排序变动=critical；单价/汇率 >阈值=warn；仅新增/删除=info。
 * - actionable = 有可动作变动 且 未抑制 且 门控开。
 */
export function detectDrift(input: DriftInput): DriftReport {
  const { model, channel, oldPricing = null, newPricing = null, fx, fxOld } = input;
  const now = (input.now ?? (() => Date.now()))();
  const lastTriggerMap = input.lastTriggerMap ?? {};
  const envSuppress = input.envSuppress;

   const oldInput = oldPricing?.input ?? 0;
  const oldOutput = oldPricing?.output ?? 0;
  const newInput = newPricing?.input ?? 0;
  const newOutput = newPricing?.output ?? 0;

   const inputPct = percentDelta(oldInput, newInput);
  const outputPct = percentDelta(oldOutput, newOutput);

   // 汇率变动（USD 模型才关心；fx/fxOld 都提供时比）
  let fxPct = 0;
  if (fx != null && fxOld != null && fxOld > 0) fxPct = percentDelta(fxOld, fx);

   const modelAdded = !oldPricing && !!newPricing;
  const modelRemoved = !!oldPricing && !newPricing;

   // 排序变动：前后各跑一次 rankByCostCny，比「该 model 在排序中的位置/整体序」。
  let orderChanged = false;
  let orderBefore: string[] | undefined;
  let orderAfter: string[] | undefined;
  if (input.rankCandidates && input.rankCandidates.length > 0 && oldPricing && newPricing) {
     // 排序变动：前后各跑一次 rankByCostCny，比「整体序」。
     // 「before」全候选旧价；「after」仅本 model 取新价，其余候选仍持旧价
     // （detectDrift 只知本 model 的新价，无法更新其它候选价 → 非目标候选恒持旧价）。
     // 语义：本 model 变价后，是否在其排序队列中换位（§3.2 重点告警）。
    const buildCands = (target: Pricing) =>
      input.rankCandidates!.map((m) => ({
        id: m,
        pricing: m === model ? target : oldPricing ?? newPricing,
        health: 'ok' as const,
        }));
    const before = rankByCostCny(
      buildCands(oldPricing),
      input.rankInputTokens ?? 0,
      input.rankOutputTokens ?? 0,
      ).map((e) => e.id);
    const after = rankByCostCny(
      buildCands(newPricing),
      input.rankInputTokens ?? 0,
      input.rankOutputTokens ?? 0,
      ).map((e) => e.id);
    orderBefore = before;
    orderAfter = after;
    orderChanged = before.join(',') !== after.join(',');
     }

   // 严重度判定（§3.2 规则表 + §3.10）
  const reasons: string[] = [];
  let severity: DriftSeverity = 'info';
  if (orderChanged) {
    reasons.push(`路由排序变化：${input.rankCandidates?.join(' / ') ?? '候选序'}, 前后顺序不一致`);
    severity = 'critical';
   }
   if (Math.abs(inputPct) > PRICE_DRIFT_THRESHOLD || Math.abs(outputPct) > PRICE_DRIFT_THRESHOLD) {
    const parts = [];
    if (Math.abs(inputPct) > PRICE_DRIFT_THRESHOLD)
      parts.push(`输入单价 ${oldInput}→${newInput}（${(inputPct * 100).toFixed(1)}%）`);
     if (Math.abs(outputPct) > PRICE_DRIFT_THRESHOLD)
      parts.push(`输出单价 ${oldOutput}→${newOutput}（${(outputPct * 100).toFixed(1)}%）`);
    reasons.push(`单价变动：${parts.join('；')}`);
    if (severity !== 'critical') severity = 'warn';
   }
   if (Math.abs(fxPct) > PRICE_DRIFT_THRESHOLD) {
    reasons.push(`汇率变动 USD→CNY ${fxOld}→${fx}（${(fxPct * 100).toFixed(1)}%）`);
    if (severity !== 'critical' && severity !== 'warn') severity = 'warn';
   }
   if (modelAdded && reasons.length === 0) reasons.push(`新模型加入价表：${model}`);
   if (modelRemoved) {
    reasons.push(`模型退出价表：${model}`);
    if (severity === 'info') severity = 'warn';
   }

   const suppressed = isSuppressed(model, lastTriggerMap, now, envSuppress);
   // actionable：有可动作变动 + 未被抑制 + 门控开（§3.10 observe 默认关时不触发覆盖 UX）
  const actionable = severity !== 'info' && !suppressed && isPriceDriftNotifyEnabled();

  return {
   model,
   channel,
   timestamp: now,
   priceDelta: { inputPct, outputPct, fxPct },
    modelAdded,
   modelRemoved,
   orderChanged,
   orderBefore,
   orderAfter,
   severity,
   actionable,
   suppressed,
  reasons,
  };
}

// 把 DriftReport 映射为 alert.js 可消费的信号（§3.10 复用 alert.js）。
// 注意：本映射只是「数据准备」，是否上线由调用方按门控决定（alert.js 默认 observe）。
export function toAlertSignal(report: DriftReport): {
  source: 'price-drift';
  model: string;
  channel?: string;
  severity: DriftSeverity;
  message: string;
  actionable: boolean;
} {
  return {
    source: 'price-drift',
    model: report.model,
    channel: report.channel,
    severity: report.severity,
    message: report.reasons.join(' · ') || `价格变动：${report.model}`,
    actionable: report.actionable,
   };
}

// 触发后记录时间戳（供 24h 去重；调用方 emit 成功后调，§3.10）。
export function recordTrigger(
  lastTriggerMap: Record<string, number>,
  model: string,
  now = Date.now(),
): void {
  lastTriggerMap[model] = now;
}
