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
  defaultModel: 'qwen3.8:27b-mlx',
  // D5 对齐(2026-09-13, 老板拍 ①): model 名改各上游 /v1/models 实测真名。
  //  上游真名(各 provider /v1/models 实探):
  //    deepseek   → deepseek-flash, deepseek-v4-pro   (api.deepseek.com)
  //    agnes      → agnes-2.5-flash (+11 个 agnes-*)     (apihub.agnes-ai.com)
  //    kimi       → kimi-k3, kimi-k2.6, kimi-k2.7-code   (api.moonshot.cn)
  //    ollama     → qwen3.8:27b-mlx                       (本地 127.0.0.1:11434)
  //  旧虚名 deepseek-v4.1-flash / qwen3.8-flash 上游不认(已删), override 一开即真 404。
  fallbackChain: ['qwen3.8:27b-mlx', 'deepseek-v4-pro', 'agnes-2.5-flash', 'kimi-k2.6'],
   rules: [
   { id: 'r-cheap',   condition: "taskType == 'cheap'",   targetProvider: 'agnes-2.5-flash' },
   { id: 'r-coding',  condition: "taskType == 'coding'",  targetProvider: 'deepseek-v4-pro' },
   { id: 'r-writing', condition: "taskType == 'writing'", targetProvider: 'qwen3.8:27b-mlx' },
   { id: 'r-vision',  condition: "taskType == 'vision'",  targetProvider: 'qwen3.8:27b-mlx' },
   { id: 'r-private', condition: 'privacy == true',        targetProvider: 'qwen3.8:27b-mlx' },
   { id: 'r-hard',    condition: "quality == 'high'",      targetProvider: 'deepseek-v4-pro' },
  ],
  maxRetries: 3,
  strategy: 'cost-optimization',
  // 价表：双计费维度（老板 2026-09-22 拍板）——API 按 token 计费 + coding plan 订阅计费，分开算。
   //  门控 PROXY_BILLING_MODE 默认为关（token 模式）；开（'subscription'）时声明 subscription
   //  的条目按月费均摊，边际成本≈0。门控关 → 全部走 token 计价（现状，逐字节向后兼容）。
   //  真实价回源 kimi-k2.com（kimi 系 ¥/1M tokens），deepseek 为真实价；qwen/agnes 本地免费。
   //  Q1 价表扩展(§3.1/§3.7): 加 currency(默认 CNY)/source 标注。estimateCost 忽略这两个字段
   //  → 路由选择逐字节不变(仅扩展字段)。deepseek F1 回官方 0.5/3/0.02(旧 1/4/0.02 偏高 ~2×):
   //  相对序不变(qwen/agnes=0 < deepseek=0.5/3 < kimi=6.5/27), 路由选择不变。
  pricing: {
     // 本地 ollama / agnes 标免费——0 价，cost-optimization 永远先选它们。
     'qwen3.8:27b-mlx':        { input: 0,    output: 0,   cacheHit: 0,    currency: 'CNY', source: 'ollama/2026-09(本地免费·路由内最省)' },
     // deepseek 真实价(¥/1M tokens)。F1 回源修正 1/4/0.02 → 0.5/3/0.02。
     'deepseek-v4-pro':        { input: 0.5,  output: 3,   cacheHit: 0.02, currency: 'CNY', source: 'OpenRouter/官方·2025-11(F1·路由内主)' },
     'agnes-2.5-flash':        { input: 0,    output: 0,   cacheHit: 0,    currency: 'CNY', source: 'agnes-ai/免费·路由内最省' },
     // kimi 真实价(¥/1M tokens，回源 kimi-k2.com kimi-k2.7-code 档；k2.6 为旧虚名占位，
     //   现以真实 k2.7-code 价回填——DB models.name='kimi-k2.6' 即此 live key，不另改 key，
     //   避免 B1 式「pricing key ≠ DB model 名」失效）。k2.6 旧 key 弃用，由 k2.7-code 真实价取代。
     'kimi-k2.6':              { input: 6.5,  output: 27,  cacheHit: 1.3,  currency: 'CNY', source: 'kimi-k2/2026-09·路由内天花板' },
     // kimi 真实模型名（k2.7-code 标准 / 高速 2x）——API model id；尚未进 fallbackChain
     //   （DB 暂无对应 model 行），作为真实价参考。coding plan 订阅维度示范于此条目。
     //   monthlyCny 取 coding plan Allegretto 档真实月费 199；monthlyQuotaTokens 待老板补
     //   （每周配额 token 数），缺失时安全退化 token 计价（不产假成本）。
     'kimi-k2.7-code':        { input: 6.5,  output: 27,  cacheHit: 1.3,
                                billingMode: 'subscription', monthlyCny: 199 },
     'kimi-k2.7-code-highspeed': { input: 13, output: 54, cacheHit: 2.6,
                                billingMode: 'subscription', monthlyCny: 199 },
     // glm / codex：尚无可靠真实价源，留占位 + 显式标注 TODO，不编造。
     //   0/0/0 仅为占位（切勿据此计费）；未列入 fallbackChain，不参与比价/路由。
     //   TODO 待老板补真实价（API token 价 + coding plan 订阅月费/配额）。
     'glm-4.5':               { input: 0, output: 0, cacheHit: 0 },  // TODO 待老板补真实价
     'codex':                 { input: 0, output: 0, cacheHit: 0 },  // TODO 待老板补真实价
    },
};

// re-export 以便调用方从单一 M6 入口拿 classifyTask / estimateCost。
export { classifyTask, estimateCost };