// M6 方向四：按任务类型智能派发路由。
//
// 扩展既有 RouteEngine：
//  - 4b 规则条件求值（evaluateRules）：命中显式规则 → 走 targetProvider
//  - 4c cost-optimization 策略：候选集内按预估花费选最便宜且健康者
//  - 修复 D12：round-robin 索引从「单实例共享变量」改为「按 config.id 分桶的
//    Map<string, number>」，避免跨 proxy（多 RouteConfig）串号。
//
// 调用方（proxy 入口）在算好 taskType 后，经 getNextRoute(taskType, modelName, config) 下传。
//
// 向后兼容：未配置 rules 时行为等同旧版 priority/round-robin；
// cost-optimization 缺 pricing 时优雅降级（无单价的候选视为最贵，排到末尾）。

import { evaluateRules, estimateCost, rankByCost, RuleContext, Pricing } from './ruleEvaluator.js';
import { TaskType, classifyTask } from './taskClassifier.js';

export interface RoutingRule {
  id: string;
  condition: string; // 受限表达式，例如 "taskType == 'coding'"
  targetProvider: string;
}

export interface RouteConfig {
  id: string;
  defaultModel: string;
  fallbackChain: string[];
  rules: RoutingRule[];
  maxRetries: number;
  strategy: 'priority' | 'round-robin' | 'cost-optimization';
   // M6: 可选的定价表（按 model 名查单价，供 cost-optimization 用）。
   pricing?: Record<string, Pricing>;
}

// 候选 provider：cost-optimization 时参与比价。
export interface RouteCandidate {
  id: string;
  pricing?: Pricing;                 // 每百万 tokens / 人民币
  health?: 'ok' | 'degraded' | 'down';
}

// 路由决策需要的上下文（taskType 来自 classifyTask，其余为调用方显式传入）。
export interface RouteContext {
  taskType: TaskType;
  model?: string;
  provider?: string;
  messageLength?: number;
  privacy?: boolean;
  quality?: string;
}

export class RouteEngine {
  // D12 修复：按 config.id 分桶的 round-robin 计数器，避免跨 proxy 串号。
   // 单线程部署下普通 Map 足够；未来集群态可替换为分布式计数器。
  private rrIndexByConfig = new Map<string, number>();
  private routeConfigs: RouteConfig[] = [];

  setRoutes(routes: RouteConfig[]): void {
    this.routeConfigs = routes;
   }

  /**
   * 取下一个路由目标。
   *
   * 新签名（M6）：getNextRoute(taskType, modelName, config, ctx?)
   *   taskType  任务分类（来自 classifyTask，请求级一次）
   *   modelName 请求的模型名
   *   config    路由配置
   *   ctx       额外上下文（privacy / quality / 候选集等，用于 cost-optimization）
   *
   * 向后兼容旧签名：getNextRoute(modelName, config)
   *   旧调用方未传 taskType；用「第 2 参类型」判别——传 RouteConfig 对象即走旧路；
   *   传字符串 modelName 则走新路。这样旧测试/旧调用点无需改动即可继续工作。
   */
  getNextRoute(
    taskTypeOrModel: TaskType | string,
    modelNameOrConfig: string | RouteConfig,
    config?: RouteConfig,
    ctx?: Partial<Omit<RouteContext, 'taskType' | 'model'>> & { candidates?: RouteCandidate[] },
   ): string {
     // 向后兼容判别：旧签名把 RouteConfig 放在第 2 参；新签名第 2 参是模型名字符串。
    if (typeof modelNameOrConfig !== 'string') {
      taskTypeOrModel = 'general';
      config = modelNameOrConfig;
      ctx = undefined;
        } else {
         // 新签名：参数已是 taskType / modelName / config / ctx
       }

      // 规整：两条路径后 config 必为 RouteConfig；非法调用（既非新串又非旧对象）回退空配置。
    const cfg: RouteConfig = config ?? {
      id: '__adhoc__',
      defaultModel: typeof modelNameOrConfig === 'string' ? modelNameOrConfig : taskTypeOrModel as string,
      fallbackChain: [],
      rules: [],
      maxRetries: 0,
      strategy: 'priority',
       };

     // 构造规则求值上下文
    const ruleCtx: RuleContext = {
      taskType: taskTypeOrModel as TaskType,
      model: typeof modelNameOrConfig === 'string' ? modelNameOrConfig : cfg.defaultModel,
      provider: ctx?.provider,
      messageLength: ctx?.messageLength,
      privacy: ctx?.privacy,
      quality: ctx?.quality,
      };

     // 4b：先评估显式规则；命中即直达 targetProvider（再继续其 failover），
     // 不再走下方 strategy 分支。
     const matched = evaluateRules(cfg.rules, ruleCtx);
     if (matched) return matched;

     // 4a/4c：按 strategy 分支
     if (cfg.strategy === 'cost-optimization') {
     return this.pickByCost(cfg, ctx?.candidates, ctx);
     }

     // round-robin：按 config.id 分桶，避免跨配置串号
     if (cfg.strategy === 'round-robin') {
     const bucket = this.rrIndexByConfig.get(cfg.id) ?? 0;
     // pre-increment：先前进再返回（与既有 round-robin 契约一致，向后兼容旧测试）
     const next = (bucket + 1) % Math.max(cfg.fallbackChain.length, 1);
     this.rrIndexByConfig.set(cfg.id, next);
     return cfg.fallbackChain[next] ?? cfg.fallbackChain[0] ?? cfg.defaultModel;
     }

     // priority（默认）：取 fallbackChain 首项
     return cfg.fallbackChain[0] ?? cfg.defaultModel;
     }

  /**
   * 4c cost-optimization：在候选集内按预估花费排序（健康优先）选最便宜者。
   * 候选缺失时，退化为 fallbackChain[0]（向后兼容，旧调用方无候选集亦可运行）。
   */
  private pickByCost(
    config: RouteConfig,
    candidates: RouteCandidate[] | undefined,
    ctx?: Partial<RouteContext>,
  ): string {
     // 估算 token：用 messageLength 粗算（字符数 ÷ 2 ≈ token，保守）
    const estInput = Math.max(1, Math.floor((ctx?.messageLength ?? 512) / 2));
    const estOutput = Math.max(1, Math.round(estInput * 0.3));

    if (candidates && candidates.length > 0) {
      const ranked = rankByCost(candidates, estInput, estOutput)
         .filter((c) => c.cost !== Infinity); // 跳过无价（视为最贵，落最后）
       if (ranked.length > 0) return ranked[0].id;
     }

     // 退化为按 fallbackChain 顺序 + pricing 比价（无候选集的简化路径）
    if (config.pricing && config.fallbackChain.length > 0) {
      const ranked = rankByCost(
        config.fallbackChain.map((model) => ({ id: model, pricing: config.pricing![model] })),
        estInput,
        estOutput,
       );
      if (ranked.length > 0 && ranked[0].cost !== Infinity) return ranked[0].id;
     }

     // 无任何可用价格信息时，回退到首项（等价 priority）
    return config.fallbackChain[0] ?? config.defaultModel;
   }

  buildFallbackChain(config: RouteConfig): string[] {
   return config.fallbackChain;
   }
}

// 便捷导出：单例（proxy 入口可复用，内部 Map 保证 round-robin 不串号）。
export const globalRouteEngine = new RouteEngine();

/**
 * M6-D 默认四层 RouteConfig（对应老板真实在用的模型，2026-09-10）。
 * 四层：Qwen3.8-Flash 默认 → DeepSeek V4.1 Flash 重编码 → Agnes 免费兜底 → 本地离线。
 */
export const DEFAULT_ROUTE_CONFIG: RouteConfig = {
  id: 'default-four-tier',
  defaultModel: 'qwen3.8-flash',
  fallbackChain: ['qwen3.8-flash', 'deepseek-v4.1-flash', 'agnes-2.5-flash', 'qwen3.8:27b-mlx'],
   rules: [
    { id: 'r-cheap',   condition: "taskType == 'cheap'",   targetProvider: 'agnes-2.5-flash' },
    { id: 'r-coding',  condition: "taskType == 'coding'",  targetProvider: 'deepseek-v4.1-flash' },
    { id: 'r-writing', condition: "taskType == 'writing'", targetProvider: 'qwen3.8-flash' },
    { id: 'r-vision',  condition: "taskType == 'vision'",  targetProvider: 'qwen3.8-flash' },
    { id: 'r-private', condition: 'privacy == true',        targetProvider: 'qwen3.8:27b-mlx' },
    { id: 'r-hard',    condition: "quality == 'high'",      targetProvider: 'deepseek-v4.1-flash' },
   ],
   maxRetries: 3,
   strategy: 'cost-optimization',
   pricing: {
    'qwen3.8-flash':       { input: 0.8,  output: 2.7, cacheHit: 0.1 },
    'deepseek-v4.1-flash': { input: 1,    output: 4,   cacheHit: 0.02 },
    'agnes-2.5-flash':     { input: 0,    output: 0,   cacheHit: 0 },
    'qwen3.8:27b-mlx':       { input: 0,    output: 0,   cacheHit: 0 },
   },
};

// re-export 以便调用方从单一 M6 入口拿 classifyTask / estimateCost。
export { classifyTask, estimateCost };