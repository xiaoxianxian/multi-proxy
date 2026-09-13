/**
 * M6 方向四 · 影子模式路由建议（dry-run）
 *
 * 设计目标：在不改变真实代理路径（findProviderConfig）的前提下，
 * 让智能路由引擎「算出它会选谁」并落日志供观测，一段时间后再决定是否真接。
 *
 * 关键不变式（由测试保证）：
 *    - buildShadowSuggestion 是纯计算 + 日志，绝不修改真实路由；
 *    - 仅在 PROXY_ROUTING_SHADOW=1 时产生建议日志；
 *    - 任何异常都被吞掉（影子模式永不影响主链路）。
 *
 * 接真实路由属后续独立步骤，本模块只观测。
 */
import { globalRouteEngine, classifyTask, DEFAULT_ROUTE_CONFIG, type RouteConfig, type RouteCandidate } from './routeEngine.js';
import type { HealthMonitor } from '../monitoring/healthMonitor.js';

// D6-a · 健康信号注入接口
// start.ts 在 PROXY_HEALTH_MONITOR 门控下创建 HealthMonitor + model→UUID 映射
// 后调 setHealthContext 注入；本模块在候选集构建时查健康、填 health 字段。
let _healthMonitor: HealthMonitor | null = null;
let _modelToProvider: Map<string, string> | null = null;

/**
 * 由 start.ts（PROXY_HEALTH_MONITOR=1 时）调用，注入健康监控状态。
 * 不接线时 _healthMonitor=null，候选集构建返回 undefined health。
 */
export function setHealthContext(monitor: HealthMonitor, modelToProvider: Map<string, string>): void {
  _healthMonitor = monitor;
  _modelToProvider = modelToProvider;
}

/** 测试辅助：清除健康上下文 */
export function clearHealthContext(): void {
  _healthMonitor = null;
  _modelToProvider = null;
}

/**
 * D6-a · 由 model 名 + fallbackChain 构建带健康状态的候选集。
 *
 * health 值域：'ok' / 'degraded' / 'down'。
 * 映射：HealthMonitor.status.state 为 'healthy' → 'ok'；'unhealthy' → 'down'；
 * 无状态 / 半开 → 'degraded'。
 *
 * 纯函数（不碰热路径、不改 DB），异常返回 undefined（候选集构建不崩主链路）。
 */
export function buildHealthCandidates(config: RouteConfig): RouteCandidate[] | undefined {
  if (!_healthMonitor || !_modelToProvider) return undefined;
  const out: RouteCandidate[] = [];
  for (const model of config.fallbackChain) {
    const providerUuid = _modelToProvider.get(model);
    let health: 'ok' | 'degraded' | 'down' | undefined;
    if (providerUuid) {
      const st = _healthMonitor.getStatus(providerUuid);
      if (st?.state === 'healthy') health = 'ok';
      else if (st?.state === 'unhealthy') health = 'down';
      else health = 'degraded'; // 未知 / 半开超时
    } else {
      health = 'down'; // 无映射（死名），标记 down，让成本排序跳过
    }
    out.push({ id: model, health });
  }
  return out.length > 0 ? out : undefined;
}

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
    // D6-a: 健康信号接线——若 HealthMonitor 已注入，用带健康状态的候选集驱动
    // cost-optimization（健康优先、其次比价）；未接入时传 undefined，行为向后兼容。
    const candidates = buildHealthCandidates(config);
    // pricing 仅用于比价；cost-optimization 缺价候选会被跳过。DEFAULT_ROUTE_CONFIG
    // 已带 pricing，其它自定义 config 若无 pricing 则不注入（rankByCost 退化为按序）。
    const cfg = config.pricing ? config : { ...config, pricing: undefined };
    const suggestion = globalRouteEngine.getNextRoute(taskType, model, cfg,
       { candidates });
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
