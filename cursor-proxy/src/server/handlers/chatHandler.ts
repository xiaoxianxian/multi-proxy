import { Request, Response } from 'express';
import { fetch } from 'undici';
import { ProviderRegistry } from '../../providers/registry.js';
import { ProviderAdapter, ProviderConfig } from '../../providers/base.js';
import { db } from '../../db/database.js';
import { SecretsManager } from '../../utils/crypto.js';
import { routeShadow } from '../../routing/routing-shadow.js';

const secrets = new SecretsManager();

/** Get the current routing mode from settings (default: 'failover') */
function getRoutingMode(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'routing_mode'").get() as any;
  return row ? String(row.value) : 'failover';
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
 * 转发请求到上游 Provider
 */
export async function forwardToProvider(
  reqBody: any,
  providerConfig: ProviderConfig,
  res: Response,
  stream: boolean
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

   // M6 影子路由建议（dry-run，不改变真实路由；仅 PROXY_ROUTING_SHADOW=1 时落日志）
  try {
    routeShadow(model, messages);
   } catch {
    // 影子模式绝不影响主链路——异常即静默忽略
   }

  try {
    await forwardToProvider(req.body, providerConfig, res, stream);
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
