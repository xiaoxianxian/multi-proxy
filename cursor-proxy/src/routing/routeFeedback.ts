/**
 * M6 方向四 · P0-2 路由反馈闭环（2026-09-30 路由能力矩阵 P0-2 落地）
 *
 * 设计目标：把 shadow 观测「让日志长成自有 benchmark」——记录每次 shadow 计算出的
 *   taskType × model，以及真实转发后的运行时元数据（延迟 / 输出 tokens / 是否重试），
 *   供周报聚合为「taskType × model → 平均延迟 / 成功率 / 重试率」视图。
 *
 * 关键不变式（由测试保证）：
 *   - 门控 PROXY_ROUTING_FEEDBACK=1 才落库；默认关 → record 整段跳过，零写入、零行为变更。
 *   - 纯加性：只写新表 routing_feedback，绝不改现有路由决策 / 现有表。
 *   - 任何异常都被吞掉（反馈观测永不影响主链路）。
 *
 * 接入点：chatHandler shadow 块内（已 import routeShadow 处）调 recordShadowFeedback。
 *   延迟/重试等运行时元数据在转发后由 recordRuntimeUpdate 补回（best-effort）。
 */
import { db } from '../db/database.js';

// 门控：默认关。仅 PROXY_ROUTING_FEEDBACK=1 时落库（对齐「门控默认关」铁律，AGENTS §3）。
export function isRoutingFeedbackEnabled(): boolean {
  const v = String(process.env.PROXY_ROUTING_FEEDBACK ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface FeedbackRecord {
  taskType: string;
  model: string;
  suggestion: string | null;
  defaultModel: string;
}

/**
 * 转发前：记录一次 shadow 决策（taskType × model × 建议）。
 * 门控关 → 跳过（不写）。成功落库返回 rowid，便于转发后补运行时元数据；失败/关 → -1。
 */
export function recordShadowFeedback(rec: FeedbackRecord): number {
  if (!isRoutingFeedbackEnabled()) return -1;
  try {
    const r = db
       .prepare(
          `INSERT INTO routing_feedback
            (task_type, model, suggestion, default_model, latency_ms, output_tokens, retried)
           VALUES (?, ?, ?, ?, NULL, NULL, 0)`,
         )
       .run(rec.taskType, rec.model, rec.suggestion, rec.defaultModel);
    return Number(r.lastInsertRowid);
    } catch {
      // 反馈观测绝不影响主链路
      return -1;
      }
   }

/**
 * 转发后：按 rowid 补回运行时元数据（延迟/输出 tokens/重试）。best-effort。
 * 门控关或 rowid 非法 → 跳过。
 */
export function recordRuntimeUpdate(
  rowid: number,
  metrics: { latencyMs?: number; outputTokens?: number; retried?: boolean },
): void {
  if (!isRoutingFeedbackEnabled() || !Number.isInteger(rowid) || rowid <= 0) return;
  try {
    db.prepare(
       `UPDATE routing_feedback
       SET latency_ms = COALESCE(?, latency_ms),
           output_tokens = COALESCE(?, output_tokens),
           retried = COALESCE(?, retried)
         WHERE id = ?`,
      ).run(metrics.latencyMs, metrics.outputTokens, metrics.retried ? 1 : 0, rowid);
     } catch {
      // non-critical
    }
  }

/**
 * 周报聚合：taskType × model → 计数 / 平均延迟 / 重试率 / 成功率占比。
 * 只读查询，供 admin 端点或面板消费；门控无关（查询本身不写）。
 */
export function aggregateFeedback(
  sinceDays = 7,
): Array<Record<string, unknown>> {
  try {
    return db
      .prepare(
         `SELECT task_type,
                 model,
                 COUNT(*) AS n,
                 AVG(latency_ms) AS avg_latency_ms,
                 AVG(retried) AS retry_rate,
                 SUM(CASE WHEN latency_ms IS NOT NULL THEN 1 ELSE 0 END) AS forwarded
          FROM routing_feedback
          WHERE ts >= datetime('now', ?)
          GROUP BY task_type, model
          ORDER BY n DESC`,
       )
      .all(`-${sinceDays} days`) as Array<Record<string, unknown>>;
     } catch {
      return [];
    }
  }
