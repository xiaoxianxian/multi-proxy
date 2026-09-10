import { ProviderAdapter, ProviderConfig, ModelInfo, UpstreamRequest } from './base.js';

export class GenericProvider implements ProviderAdapter {
  readonly id: 'generic' = 'generic';
  readonly name = 'Generic Provider';
  readonly defaultBaseUrl = 'http://localhost:8000/v1';
  readonly wireApi: 'openai' = 'openai';

  async normalizeRequest(chatRequest: any, config: ProviderConfig): Promise<UpstreamRequest> {
    return { ...chatRequest, model: chatRequest.model };
  }

  async denormalizeResponse(upstreamResponse: any, stream: boolean): Promise<any> {
    return upstreamResponse;
  }

  async healthCheck(config: ProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(config.baseUrl, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return [];
      const data: any = await res.json();
      return (data.data || []).map((m: any) => ({
        id: m.id, name: m.id, providerId: this.id, enabled: true,
      }));
    } catch {
      return [];
    }
  }

  supportsTools(): boolean {
    return true;
  }

  supportsVision(): boolean {
    return true;
  }
}
