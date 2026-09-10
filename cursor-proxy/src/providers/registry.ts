import { ProviderAdapter, ProviderConfig, ProviderId, ModelInfo } from './base.js';

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers = new Map<ProviderId, ProviderAdapter>();

  private constructor() {}

  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  register(adapter: ProviderAdapter): void {
    this.providers.set(adapter.id, adapter);
    console.log(`[ProviderRegistry] Registered provider: ${adapter.name} (${adapter.id})`);
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.providers.get(id);
  }

  getAll(): ProviderAdapter[] {
    return Array.from(this.providers.values());
  }
}
