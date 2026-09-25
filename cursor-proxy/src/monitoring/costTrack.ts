/**
 * Q3 P1-B 成本闭环 · cursor 侧实采持久化层
 *
 * 职责：门控 PROXY_CURSOR_COST 开 → chatHandler 转发出口处 accumulate(providerId, usage, pricing)
 *   1. 用 actualCost.ts 算精确成本（含 cache 实采）
 *   2. 原子写 JSONL sidecar（仿 provider-health.js 的 ~/.multi-proxy-manager/ 约定）
 *   3. getDailyCost(day?) — 读 SUM（纯只读，供 /admin-api/cost 暴露）
 *
 * 非侵入（AGENTS §3）：
 *   - 门控 PROXY_CURSOR_COST 默认关 = 零开销（热路径仅一次 enabled() 布尔比较）
 *   - 门控开 = 只读 usage，不改 response.data、不注 header、不写 cursor proxy.db（D5 先例：成本不写业务库）
 *   - 写盘 best-effort：失败静默（不拖垮主转发链路）
 *
 * 落点约定（与 provider-health.js 一致）：
 *   默认 ~/.multi-proxy-manager/cursor-cost.jsonl
 *   可 PROXY_CURSOR_COST_LOG 覆盖（测试用）
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { actualCostFromUsage, extractTokens, type UsageShape } from '../routing/actualCost.js';
import { DEFAULT_ROUTE_CONFIG } from '../routing/routeEngine.js';
import type { Pricing } from '../routing/ruleEvaluator.js';

// ---- 门控 ----
const GATE = 'PROXY_CURSOR_COST';

/** 门控开 = 采集+持久化+暴露一体开关；关 = 热路径零开销（默认） */
export function enabled(): boolean {
  const v = String(process.env[GATE] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// ---- 价源解析（L0 单一真相源 + env 覆盖，与 routeEngine pricing / manager cost-track 同口径）----
// 优先级：PROXY_PRICING_<proxy>（env 覆盖，对齐 manager lib/cost-track.js 注入）
//   → DEFAULT_ROUTE_CONFIG.pricing[<model>]（L0 官方价，cache-aware）
//   → 0 价（未知模型/本地，cost=0，不产假值，本地模型不参与告警）
const _P: Pricing = { input: 0, output: 0, cacheHit: 0 };

function readPricingFromEnv(proxy: string): Pricing | null {
  const key = 'PROXY_PRICING_' + String(proxy || '').trim().toUpperCase();
  const raw = process.env[key];
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') {
      return {
        input:  n(p.input),
        output: n(p.output),
        cacheHit: p.cacheHit != null ? n(p.cacheHit) : undefined,
      };
     }
    return null;
   } catch { return null; }
}

function n(v: any): number {
  return typeof v === 'number' ? v : (parseFloat(v) || 0);
}

/**
 * 解析 model 对应价表。未知模型 → 0 价（不产假值；本地 ollama/agnes 本就该 0）。
 * L0 单一真相源 = routeEngine.DEFAULT_ROUTE_CONFIG.pricing（cache-aware，含 kimi/deepseek 真实价）。
 */
export function resolvePricing(model: string, provider?: string): Pricing {
  if (provider) {
    const env = readPricingFromEnv(provider);
    if (env) return env;
   }
  const fromL0 = DEFAULT_ROUTE_CONFIG.pricing?.[model];
  if (fromL0 && (fromL0.input !== undefined || fromL0.output !== undefined)) return fromL0;
  return _P;
}

function logPath(): string {
  const custom = process.env.PROXY_CURSOR_COST_LOG;
  if (custom && custom.trim()) return custom;
  const dir = path.join(os.homedir(), '.multi-proxy-manager');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  return path.join(dir, 'cursor-cost.jsonl');
}

/** 一条 cost record 的形状（JSONL 每行一个） */
export interface CostRecord {
  ts: string;          // ISO
  day: string;         // YYYY-MM-DD（本地时区）
  provider: string;    // providerId（openai/anthropic/gemini/deepseek/...）
  model: string;       // 请求 model 名
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;        // CNY（含 cache 实采；本地模型=0）
  source: 'actual';    // 实采标记（区分未来可能的估算/余额趋势 B 路）
}

// ---- 热路径入口：门控关 → 立即返回（仅布尔比较，零写盘/零算价） ----
export function accumulate(
  provider: string,
  model: string,
  usage: UsageShape,
  pricing: Pricing,
): void {
  if (!enabled()) return;
  try {
    const cost = actualCostFromUsage(usage, pricing);
    const { inputTokens, outputTokens, cacheReadTokens } = extractTokens(usage);
    const now = new Date();
    const rec: CostRecord = {
      ts: now.toISOString(),
      day: dayKey(now),
      provider,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cost: round6(cost),
      source: 'actual',
    };
    appendRecord(rec);
  } catch {
    // 非致命：持久化失败绝不阻塞主转发链路（AGENTS §3 非侵入）
  }
}

/** 原子追加一条 record（write tmp + renameSync，仿 D6-b override-audit §13.30 模式） */
function appendRecord(rec: CostRecord): void {
  const file = logPath();
  const line = JSON.stringify(rec) + '\n';
  const tmp = file + '.tmp';
  // 读旧 → 追加 → 临时文件 rename（原子）
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = ''; }
  fs.writeFileSync(tmp, existing + line, 'utf8');
  try { fs.renameSync(tmp, file); } catch { /* rename 失败不阻塞 */ }
}

function dayKey(d: Date): string {
  // 本地时区 YYYY-MM-DD（getDay 与 getHours 一致，避开 UTC 偏移）
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ---- 读 API：getDailyCost(day?) = 读 SUM（纯只读，供 /admin-api/cost） ----

export interface DailyCostSummary {
  day: string;
  totalCny: number;
  requestCount: number;
  byProvider: Record<string, {
    requestCount: number;
    totalCny: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
  }>;
  source: 'actual';
}

/**
 * 读某日（缺省=今天）的 cost 汇总。
 * 纯只读：从 JSONL 读 + SUM，不写盘、不触门控（读 API 不受门控约束，
 * 供 /admin-api/cost 在门控开/关任何时刻都能查当天历史——读不写盘）。
 */
export function getDailyCost(day?: string, opts?: { file?: string }): DailyCostSummary {
  const f = opts?.file || logPath();
  const targetDay = day || dayKey(new Date());
  const byProvider: DailyCostSummary['byProvider'] = {};
  let totalCny = 0;
  let requestCount = 0;

  let raw = '';
  try { raw = fs.readFileSync(f, 'utf8'); } catch { raw = ''; }

  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec: CostRecord;
    try { rec = JSON.parse(s); } catch { continue; } // 跳过损坏行
    if (rec.day !== targetDay) continue;
    totalCny += rec.cost || 0;
    requestCount += 1;
    const p = byProvider[rec.provider] || {
      requestCount: 0, totalCny: 0,
      totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0,
    };
    p.requestCount += 1;
    p.totalCny += rec.cost || 0;
    p.totalInputTokens += rec.inputTokens || 0;
    p.totalOutputTokens += rec.outputTokens || 0;
    p.totalCacheReadTokens += rec.cacheReadTokens || 0;
    byProvider[rec.provider] = p;
  }

  // round byProvider 内 cost（避免浮点尾差）
  for (const k of Object.keys(byProvider)) {
    byProvider[k].totalCny = round6(byProvider[k].totalCny);
  }
  return { day: targetDay, totalCny: round6(totalCny), requestCount, byProvider, source: 'actual' };
}

// ---- 测试/重启用 ----
export function reset(file?: string): void {
  const f = file || logPath();
  try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ }
}

export const __internals = { dayKey, round6, logPath };