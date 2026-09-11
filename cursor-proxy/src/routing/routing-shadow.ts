/**
 * M6 方向四 · 影子模式路由建议（dry-run）
 *
 * 设计目标：在不改变真实代理路径（findProviderConfig）的前提下，
 * 让智能路由引擎「算出它会选谁」并落日志供观测，一段时间后再决定是否真接。
 *
 * 关键不变式（由测试保证）：
 *   - buildShadowSuggestion 是纯计算 + 日志，绝不修改真实路由；
 *   - 仅在 PROXY_ROUTING_SHADOW=1 时产生建议日志；
 *   - 任何异常都被吞掉（影子模式永不影响主链路）。
 *
 * 接真实路由属后续独立步骤，本模块只观测。
 */
import { globalRouteEngine, classifyTask, DEFAULT_ROUTE_CONFIG, type RouteConfig } from './routeEngine.js';

/**
 * 影子建议：用 classifyTask + RouteEngine 算出「如果按智能路由，应选谁」。
 * 纯函数（无 DB、无网络、无副作用），调用方负责决定是否消费该建议。
 *
 * @returns 建议的目标 provider / model 名，或 null（无配置/无候选时）。
 */
export function computeShadowSuggestion(
  model: string,
  messages: any[],
  config: RouteConfig = DEFAULT_ROUTE_CONFIG,
): string | null {
  try {
    const taskType = classifyTask(messages);
     // 第 4 参数 ctx 当前留空：cost-optimization 暂无候选集（候选健康/价格待 4d 接线）。
    const suggestion = globalRouteEngine.getNextRoute(taskType, model, config, undefined);
     // 与引擎默认模型相同时不产生「切换」建议，避免噪声。
    if (suggestion && suggestion !== config.defaultModel) {
      return suggestion;
     }
    return null;
   } catch {
     // 影子模式绝不影响主链路——异常即静默放弃建议。
     return null;
   }
}

/**
 * 门控开关：PROXY_ROUTING_SHADOW=1 / true / on 时启用影子建议日志。
 * 默认关闭，避免噪声；上线前先影子观测、再人工开启。
 */
export function isShadowEnabled(): boolean {
  const v = String(process.env.PROXY_ROUTING_SHADOW ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface ShadowSuggestion {
  model: string;
  taskType: string;
  suggestion: string | null;
  defaultModel: string;
}

/**
 * 计算 + 记录影子建议。
 *
 * - 仅在 isShadowEnabled() 为真时记录（console + 可选日志表）。
 * - 永不改变真实路由；异常被吞。
 * @returns 建议对象（即使门控关闭也返回，便于测试与上层判断，但不一定落日志）。
 */
export function routeShadow(
  model: string,
  messages: any[],
  config: RouteConfig = DEFAULT_ROUTE_CONFIG,
): ShadowSuggestion {
  const taskType = classifyTask(messages);
  const suggestion = computeShadowSuggestion(model, messages, config);
  const result: ShadowSuggestion = {
    model,
    taskType,
    suggestion,
    defaultModel: config.defaultModel,
     };

  if (isShadowEnabled() && suggestion) {
    try {
      console.log(
       `[routing-shadow] model=${model} task=${taskType} → 引擎建议=${suggestion} ` +
       `(真实路由不变，仍使用 findProviderConfig 的选择)`,
      );
     } catch {
       // 日志失败不影响主链路
     }
    }
   return result;
}
