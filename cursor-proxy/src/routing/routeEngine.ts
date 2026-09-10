export interface RoutingRule {
  id: string;
  condition: string; // e.g. "model.contains('vision')"
  targetProvider: string;
}

export interface RouteConfig {
  id: string;
  defaultModel: string;
  fallbackChain: string[];
  rules: RoutingRule[];
  maxRetries: number;
  strategy: 'priority' | 'round-robin' | 'cost-optimization';
}

export class RouteEngine {
  // D12: Current route index for round-robin strategy. Single-threaded deployment,
  // so an instance variable is safe. For future cluster-scale deployments,
  // replace with a shared distributed counter (Redis/etcd).
  private currentRouteIndex = 0;
  private routeConfigs: RouteConfig[] = [];

  setRoutes(routes: RouteConfig[]): void {
    this.routeConfigs = routes;
  }

  getNextRoute(modelName: string, config: RouteConfig): string {
    if (config.strategy === 'round-robin') {
      this.currentRouteIndex = (this.currentRouteIndex + 1) % config.fallbackChain.length;
      return config.fallbackChain[this.currentRouteIndex] ?? config.fallbackChain[0] ?? config.defaultModel;
    }
    // Priority strategy: return first in fallback chain
    return config.fallbackChain[0] ?? config.defaultModel;
  }

  buildFallbackChain(config: RouteConfig): string[] {
    return config.fallbackChain;
  }
}
