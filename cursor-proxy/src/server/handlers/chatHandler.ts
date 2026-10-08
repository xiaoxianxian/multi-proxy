// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

import { Request, Response } from 'express';
import { fetch } from 'undici';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { ProviderRegistry } from '../../providers/registry.js';
import { ProviderAdapter, ProviderConfig } from '../../providers/base.js';
import { db } from '../../db/database.js';
import { SecretsManager } from '../../utils/crypto.js';
import { routeShadow } from '../../routing/routing-shadow.js';
// Q3 P1-B 成本闭环：实采 usage→精确 cost（含 cache）→JSONL sidecar。门控 PROXY_CURSOR_COST 默认关=零开销。
import { accumulate as costAccumulate, resolvePricing } from '../../monitoring/costTrack.js';
// M6 P0-2 路由反馈闭环：shadow 观测落库（门控 PROXY_ROUTING_FEEDBACK=1，默认关，零写入）。
import { recordShadowFeedback, recordRuntimeUpdate } from '../../routing/routeFeedback.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const secrets = new SecretsManager();

/** Get the current routing mode from settings (default: 'failover') */
function getRoutingMode(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'routing_mode'").get() as any;
  return row ? String(row.value) : 'failover';
}

/**
 * D4=C · 路由 override 门控（2026-09-13 落盘）
 *
 * PROXY_ROUTE_OVERRIDE=1 时启用引擎接管真实路由。默认 0（行为不变）。
 * Step 3（观察期后翻转默认值）由维护者 验收 后执行，不在本次。
 */
export function isRouteOverrideEnabled(): boolean {
  return process.env['PROXY_ROUTE_OVERRIDE'] === '1';
}

/**
 * D4=C · override 决策审计日志（内存环形缓冲，最多 1000 条）
 *
 * 与 D2 影子建议日志（recordShadowEntry / getShadowLog）分离：override 是
 * "真正接管路由"的决策，单独记录便于灰度期复盘。只读快照，绝不修改 D2 不变式。
 */
export interface OverrideLogEntry {
  timestamp: string;
  requestModel: string;      // 客户端原始请求 model
  engineTaskType: string;    // 引擎分类（来自 routeShadow 的 ShadowSuggestion.taskType）
  overrideModel: string;     // 引擎建议的 model（实际转发到上游的 model 字段值，Q2=①）
  provider: string;          // 经 D5 对齐 / findProviderConfig 命中的 provider
  applied: boolean;          // override 是否真正生效（映射成功）
}

const OVERRIDE_LOG_MAX = 1000;
const overrideLog: OverrideLogEntry[] = [];

// D6-b · 持久化审计 sink（可注入，默认关闭）
// 内存环形缓冲 overrideLog 是实时快照、重启即失；持久化 sink 把每条 override 决策
// 按 JSONL 追加落盘，供灰度期跨重启复盘。默认 sink=null（行为与改造前逐字节一致，
// 3 个现有测试零破坏）；由 start.ts 在 PROXY_ROUTE_OVERRIDE 门控开启时接上落盘——
// 门控关 → 零写盘、零热路径开销（与"D6-b 灰度 hold"语义对齐）。
let overrideAuditSink: string | null = null;

/** 接上/切走持久化落盘路径；传 null 关闭。仅改指向，不截断既有文件（审计 append-only）。 */
export function setOverrideLogSink(filePath: string | null): void {
  overrideAuditSink = filePath;
}

/** 当前持久化落盘路径（未接时为 null）。 */
export function getOverrideAuditPath(): string | null {
  return overrideAuditSink;
}

function defaultOverrideAuditPath(): string {
  return path.join(__dirname, '..', '..', '..', 'data', 'override-audit.jsonl');
}

export function recordOverrideEntry(entry: OverrideLogEntry): void {
  overrideLog.push(entry);
  if (overrideLog.length > OVERRIDE_LOG_MAX) {
    overrideLog.shift();
  }
  // 持久化追加：异常绝不冒泡（审计是旁路，绝不拖垮路由主链路，与影子模式同原则）。
  if (overrideAuditSink) {
    try {
      fs.mkdirSync(path.dirname(overrideAuditSink), { recursive: true });
      fs.appendFileSync(overrideAuditSink, JSON.stringify(entry) + '\n');
    } catch {
      // 落盘失败静默吞掉——主链路优先。
    }
  }
}

/** 只读快照（内存）：审计 / 不变式测试用。 */
export function getOverrideLog(): ReadonlyArray<OverrideLogEntry> {
  return overrideLog.slice();
}

/**
 * 读持久化审计日志（跨重启留存）——D6-b 灰度 验收 观测的真正入口。
 * getOverrideLog 只读内存（重启即失），readOverrideAudit 读盘才有长期观测价值。
 * @param opts.limit 取最近 N 条（默认全量，尾部）。
 * @param opts.path  指定文件（默认当前 sink；未设时回退默认 data/ 路径）。
 */
export function readOverrideAudit(opts: { limit?: number; path?: string } = {}): OverrideLogEntry[] {
  const file = opts.path ?? overrideAuditSink ?? defaultOverrideAuditPath();
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: OverrideLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 坏行跳过，不整批丢弃
    }
  }
  return typeof opts.limit === 'number' ? out.slice(-opts.limit) : out;
}

export function clearOverrideLog(): void {
  overrideLog.length = 0;
}

/** Round-robin index (persisted in settings so it survives restarts) */
function getNextProviderIndex(providerCount: number): number {
  if (providerCount <= 0) return 0;
  const mode = getRoutingMode();
  if (mode !== 'round-robin') return 0;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'rr_index'").get() as any;
  const current = row ? parseInt(String(row.value)) : 0;
  // Advance and persist for NEXT call
  const next = (current + 1) % Math.max(providerCount, 1);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
    .run('rr_index', String(next), 'string');
  return current % providerCount;
}

/**
 * 根据模型名从数据库中查找匹配的 Provider 配置
 * 支持 routing_mode: priority(默认) 或 round-robin
 */
export function findProviderConfig(modelName: string): ProviderConfig | null {
  const mode = getRoutingMode();

  // round-robin: cycle through all enabled providers
  if (mode === 'round-robin') {
    const providerRows = db.prepare(
      'SELECT * FROM providers WHERE enabled = 1 ORDER BY created_at DESC'
    ).all() as any[];
    if (providerRows.length === 0) return null;
    const idx = getNextProviderIndex(providerRows.length);
    const p = providerRows[idx];
    return {
      id: p.id,
      name: p.name,
      providerId: p.provider_id as any,
      apiKey: secrets.decrypt(p.api_key),
      baseUrl: p.base_url,
      enabled: p.enabled === 1,
    };
  }

  // priority/failover/weighted: use model-specific provider
  // 1. 先查找启用的模型
  const modelRow = db.prepare(`
    SELECT m.provider_id, m.enabled
    FROM models m
    WHERE m.name = ? AND m.enabled = 1
  `).get(modelName) as any;

  if (!modelRow) {
    // 2. 如果模型不在数据库中，取第一个启用的 provider
    const providerRow = (db.prepare(`
      SELECT * FROM providers WHERE enabled = 1 ORDER BY created_at DESC LIMIT 1
    `).get() as any) || null;

    if (!providerRow) return null;

    return {
      id: providerRow.id,
      name: providerRow.name,
      providerId: providerRow.provider_id as any,
      apiKey: secrets.decrypt(providerRow.api_key),
      baseUrl: providerRow.base_url,
      enabled: providerRow.enabled === 1,
    };
  }

  // 3. 获取该模型对应的 Provider 配置
  const providerRow = db.prepare(`
    SELECT * FROM providers WHERE id = ? AND enabled = 1
  `).get(modelRow.provider_id) as any;

  if (!providerRow) return null;

  return {
    id: providerRow.id,
    name: providerRow.name,
    providerId: providerRow.provider_id as any,
    apiKey: secrets.decrypt(providerRow.api_key),
    baseUrl: providerRow.base_url,
    enabled: providerRow.enabled === 1,
  };
}

/**
 * D4=C · D5 对齐 · 按模型名的"类型"选首个启用的 provider（override 专属 helper）。
 *
 * DEFAULT_ROUTE_CONFIG 的 model 名是各上游 /v1/models 的【真实名】(deepseek-v4-pro /
 * agnes-3.0-flash / kimi-k2.6 / qwen3.8:27b-mlx)，但 DB 的 provider.name 是【别名】
 * (DeepSeek-Test / agnes-3.0-flash / kimi / qwen3.8:27b-mlx)，两边对不齐——
 * 所以 override 不靠 models 表(0 行)，改靠【模型名 → provider_id 类型 → 首个启用该类型】。
 *
 * 这是 ① 在真实数据下的忠实实现：复用 providers.provider_id 列(deepseek/openai/generic/ollama)，
 * 不写 DB、不硬编 UUID、不碰 findProviderConfig 热路径(live 走 models.name→provider_id，与本 helper 隔离)。
 *
 * 返回 null 时(无该类型启用)由调用方决定降级；本 helper 绝不伪造 provider。
 */
const MODEL_NAME_TO_PROVIDER_TYPE: Record<string, string> = {
   'deepseek-v4-pro': 'deepseek',
   'deepseek-flash':  'deepseek',
   'agnes-3.0-flash': 'generic',
   'kimi-k2.6':       'openai',
   'kimi-k3':         'openai',
   'qwen3.8:27b-mlx': 'ollama',
};

export function findProviderByType(modelName: string): ProviderConfig | null {
  const type = MODEL_NAME_TO_PROVIDER_TYPE[modelName];
  if (!type) return null;
  const row = db.prepare(
     'SELECT * FROM providers WHERE provider_id = ? AND enabled = 1 ORDER BY created_at DESC LIMIT 1'
   ).get(type) as any;
  if (!row) return null;
  try {
    return {
      id: row.id,
      name: row.name,
      providerId: row.provider_id as any,
      apiKey: secrets.decrypt(row.api_key),
      baseUrl: row.base_url,
      enabled: row.enabled === 1,
     };
    } catch {
      // 单条解密/构造失败：返回 null，由调用方降级，不崩主链路
      return null;
     }
}

/**
 * D6-a · 列出所有已启用的 Provider 配置（健康检查 + 候选集构建单一数据源）。
 *
 * 与 findProviderConfig 共享「DB 行 → ProviderConfig（含 key 解密）」的构造，
 * 但去掉「按 model 名选」的逻辑——这里要全量 enabled provider，供 HealthMonitor
 * 轮询 /models 与候选集构建复用。绝不触碰 findProviderConfig 热路径。
 *
 * 仅只读查询；单条解密/构造失败时静默跳过（健康观测可降级，绝不崩）。
 */
export function loadEnabledProviderConfigs(): ProviderConfig[] {
  const rows = db.prepare(
    'SELECT * FROM providers WHERE enabled = 1 ORDER BY created_at DESC'
   ).all() as any[];
  const out: ProviderConfig[] = [];
  for (const row of rows) {
    try {
      out.push({
        id: row.id,
        name: row.name,
        providerId: row.provider_id as any,
        apiKey: secrets.decrypt(row.api_key),
        baseUrl: row.base_url,
        enabled: row.enabled === 1,
      });
    } catch {
      // 单条解密/构造失败：跳过该 provider，其余照常
    }
  }
  return out;
}

/**
 * 质量层 capture（与 codex-proxy 同款 flag-gated 范式；参照 HF《multi-harness RL》的 capture proxy「观测半边」）。
 * 默认关：不设 PROXY_TRACE_DIR ⇒ 整函数为 no-op，零行为变化。设了才把每次非流响应的
 * requestedModel / resolvedModel / responseModel(上游实际返回) / usage / finish_reason / logprobs / 输出摘要
 * 落到 TRACE_DIR 的 jsonl。不碰训练（守「不自训模型」铁律），纯观测；不落完整 body（与 Portico
 * 审计「只落指针不落全文」对齐）。drift 信号：responseModel ≠ requestedModel 即上游静默换后端。
 */
const TRACE_DIR = process.env['PROXY_TRACE_DIR'] || '';
const TRACE_FULL = process.env['PROXY_TRACE_FULL'] === '1';
const TRACE_VERSION_LABEL = process.env['PROXY_TRACE_VERSION_LABEL'] || null;
let _traceWarned = false;
function captureTrace(opts: {
  req: Request;
  provider: { name?: string; providerId?: string; model?: string } | null;
  requestedModel: string | null;
  rawOrObj: any;
  meta?: { agent?: string; stream?: boolean };
}): void {
  if (!TRACE_DIR) return;
  if (opts.meta && opts.meta.stream) return; // 流式 = SSE 拼接，暂不入 trace
  try {
    const isObj = typeof opts.rawOrObj === 'object' && opts.rawOrObj !== null;
    const text = isObj ? JSON.stringify(opts.rawOrObj) : String(opts.rawOrObj || '');
    let parsed = isObj ? opts.rawOrObj : null;
    if (!parsed) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
    const usage = parsed?.usage || null;
    let outPreview = '', outDigest = '', logprobs: string | null = null, finishReason: string | null = null;
    try {
      const choice = parsed?.choices?.[0] || null;
      const msg = choice?.message || (parsed?.output?.[0]?.content ? parsed.output[0] : null);
      const content: any = msg?.content ?? parsed?.content?.[0]?.text ?? '';
      if (typeof content === 'string') {
        outPreview = content.slice(0, 200);
        outDigest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
      }
      logprobs = parsed?.choices?.[0]?.logprobs ? JSON.stringify(parsed.choices[0].logprobs).slice(0, 4000) : null;
      finishReason = parsed?.choices?.[0]?.finish_reason ?? parsed?.stop_reason ?? null;
    } catch { /* 形态不识别就跳过 */ }
    const rec = {
      ts: Date.now(),
      traceId: (opts.req.headers['x-request-id'] as string) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: (opts.req.headers['x-session-id'] as string) || null,
      agent: opts.meta?.agent,
      path: opts.req.url,
      requestedModel: opts.requestedModel,
      resolvedModel: opts.provider?.model || opts.provider?.name || null,
      responseModel: parsed?.model || null,
      versionLabel: TRACE_VERSION_LABEL,
      provider: opts.provider?.name || null,
      usage,
      finishReason,
      logprobs,
      outPreview: TRACE_FULL ? undefined : outPreview,
      outDigest,
      body: TRACE_FULL ? text : undefined,
    };
    try {
      fs.mkdirSync(TRACE_DIR, { recursive: true });
      fs.appendFileSync(path.join(TRACE_DIR, `trace-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
    } catch { /* 落盘失败静默吞，主链路优先 */ }
  } catch (e: any) {
    if (!_traceWarned) { _traceWarned = true; console.warn('[trace] capture 失败（不影响主路径）:', (e && e.message) || e); }
  }
}

/**
 * 转发请求到上游 Provider
 */
export async function forwardToProvider(
  reqBody: any,
  providerConfig: ProviderConfig,
  res: Response,
  stream: boolean,
  req?: Request
): Promise<void> {
  const registry = ProviderRegistry.getInstance();
  const adapter = registry.get(providerConfig.providerId);
  if (!adapter) {
    res.status(500).json({ success: false, error: `Unknown provider type: ${providerConfig.providerId}`, code: 'UNKNOWN_PROVIDER' });
    return;
  }

  const upstreamRequest = await adapter.normalizeRequest(reqBody, providerConfig);
  const upstreamUrl = `${providerConfig.baseUrl}/chat/completions`;
  const upstreamHeaders: Record<string, string> = { 'Content-Type': 'application/json' };

  if (providerConfig.providerId === 'anthropic') {
    upstreamHeaders['x-api-key'] = providerConfig.apiKey;
    upstreamHeaders['anthropic-version'] = '2023-06-01';
  } else {
    upstreamHeaders['Authorization'] = `Bearer ${providerConfig.apiKey}`;
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamRequest),
    signal: AbortSignal.timeout(120000),
  });

  if (!upstreamResponse.ok) {
   const errText = await upstreamResponse.text();
   // 脱敏：截断并转义上游错误信息，避免泄露内部细节
   const safeErr = errText.slice(0, 200).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
   console.error(`[ChatHandler] Upstream error (truncated): ${safeErr}`);
   res.status(upstreamResponse.status).json({ success: false, error: 'Upstream provider error', code: 'UPSTREAM_ERROR' });
    return;
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const reader = upstreamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let cancelled = false;
    res.on('close', () => { cancelled = true; });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || cancelled) break;
        if (!res.writableEnded) {
          res.write(decoder.decode(value, { stream: true }));
        }
      }
    } catch (e: any) {
      if (cancelled) {
        console.log('[ChatHandler] Client disconnected during streaming');
      } else {
        console.error(`[ChatHandler] Stream error: ${e.message}`);
      }
    } finally {
      reader.releaseLock();
      if (!res.writableEnded) res.end();
    }
  } else {
   const data = await upstreamResponse.json();
   res.json(data);
   // 质量层 capture（flag-gated：不设 PROXY_TRACE_DIR 不触发，零开销）
   try {
     captureTrace({ req: req as Request, provider: providerConfig, requestedModel: reqBody.model || null, rawOrObj: data, meta: { agent: 'cursor-proxy', stream: false } });
   } catch { /* 观测旁路绝不阻塞主链路 */ }
   // Q3 P1-B 实采：非流转发出口提 usage → 精确 cost（含 cache）→ JSONL sidecar。
   // 门控 PROXY_CURSOR_COST 关 → costAccumulate 首行 enabled() 短路，零算价/零写盘/零 IO（仅一次布尔比较）。
   // 流式路径暂未埋点（SSE 逐块解析是 P1-B 独立项，见本函数末注释）；本处对齐 manager 已验证 A 路（非流 usage 捕获）。
   try {
      const usage = (data as any)?.usage;
      if (usage && reqBody && reqBody.model) {
        costAccumulate(providerConfig.providerId, reqBody.model, usage, resolvePricing(reqBody.model, providerConfig.providerId));
        }
      } catch { /* 非致命：实采失败绝不阻塞主转发链路（AGENTS §3 非侵入） */ }
  }

  // 记录日志
  try {
    db.prepare('INSERT INTO logs (level, message, proxy) VALUES (?, ?, ?)').run(
      'INFO', `Model: ${reqBody.model}, Provider: ${providerConfig.name}, Status: OK`, providerConfig.name
    );
  } catch {
    // non-critical
  }
}

/**
 * 聊天请求处理 — 核心转发逻辑
 */
export async function handleChatCompletion(req: Request, res: Response): Promise<void> {
  const { model, messages, stream } = req.body;

  if (!model || !messages || !Array.isArray(messages)) {
    res.status(400).json({ success: false, error: 'Invalid request: model and messages are required', code: 'INVALID_REQUEST' });
    return;
  }

  const providerConfig = findProviderConfig(model);
  if (!providerConfig) {
    res.status(404).json({ success: false, error: `No enabled provider found for model: ${model}`, code: 'NO_PROVIDER' });
    return;
  }

  console.log(`[ChatHandler] model=${model}, provider=${providerConfig.name}, stream=${stream}`);

   // D4=C · 路由 override（PROXY_ROUTE_OVERRIDE=1 时引擎建议接管真实路由，默认关）
   // 设计原则：门控关闭时整段跳过，shadow-only 块照常跑，热路径与今天逐字节一致；
   //   门控开启时，引擎建议的 model 经 findProviderConfig（D5 对齐：models.name→provider）
   //   重新解析 ProviderConfig 并写入 reqBody.model（Q2=① 发给上游的 model 用引擎建议名）。
   // 复用 routeShadow()（它负责写 getShadowLog 不变式表）：override 命中即跳过下方 shadow-only 块，
   //   保证单请求一次 shadow 条目，不破坏 D2 不变式。
   let overrideApplied = false;
   if (isRouteOverrideEnabled()) {
     const shadowSuggestion = routeShadow(model, messages as any[]);
     const targetModel = shadowSuggestion.suggestion;
     if (targetModel != null && targetModel !== model) {
       // D5 对齐：findProviderConfig 查 models 表（0 行 → fallback 首个 enabled，无法
       // 按真实 model 名路由）。findProviderByType 靠 provider_id 类型选对 provider（不写 DB）。
       const newConfig = findProviderByType(targetModel);
       if (newConfig != null) {
         Object.assign(providerConfig, newConfig);
         req.body.model = targetModel;
         overrideApplied = true;
         recordOverrideEntry({
           timestamp: new Date().toISOString(),
           requestModel: model,
           engineTaskType: shadowSuggestion.taskType,
           overrideModel: targetModel,
           provider: newConfig.name,
           applied: true,
         });
         console.log(`[ChatHandler][Override] model=${model} → ${targetModel} (provider=${newConfig.name}, task=${shadowSuggestion.taskType})`);
       }
     }
   }
   if (!overrideApplied) {
      // M6 影子路由建议（dry-run，不改变真实路由；仅 PROXY_ROUTING_SHADOW=1 时落日志）
     try {
       const shadow = routeShadow(model, messages as any[]);
        // P0-2 反馈闭环落库（门控 PROXY_ROUTING_FEEDBACK=1，默认关；门控关时 recordShadowFeedback 直接跳过，零写入）
       recordShadowFeedback({
          taskType: shadow.taskType,
          model,
          suggestion: shadow.suggestion,
          defaultModel: model,
        });
      } catch {
        // 影子模式 + 反馈观测绝不影响主链路——异常即静默忽略
      }
    }

  try {
    await forwardToProvider(req.body, providerConfig, res, stream, req);
  } catch (e: any) {
    console.error(`[ChatHandler] Error: ${e.message}`);
    try {
      db.prepare('INSERT INTO logs (level, message, proxy) VALUES (?, ?, ?)').run(
        'ERROR', `Model: ${model}, Error: ${e.message}`, providerConfig?.name ?? 'unknown'
      );
    } catch {
      // non-critical
    }
    res.status(502).json({ success: false, error: `Proxy error: ${e.message}`, code: 'PROXY_ERROR' });
  }
}
