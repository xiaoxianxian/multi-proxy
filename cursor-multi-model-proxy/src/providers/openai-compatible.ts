import { ProviderAdapter, ProviderConfig, ModelInfo, UpstreamRequest } from './base.js';

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id: 'openai' | 'deepseek' | 'generic';

  constructor(id: 'openai' | 'deepseek' | 'generic' = 'openai') {
    this.id = id;
  }
  readonly name = 'OpenAI Compatible';
  readonly defaultBaseUrl = 'https://api.openai.com/v1';
  readonly wireApi: 'openai' = 'openai';

  async normalizeRequest(chatRequest: any, config: ProviderConfig): Promise<UpstreamRequest> {
    // OpenAI 兼容型 Provider 直通，不做协议转换
    return {
      model: chatRequest.model,
      messages: chatRequest.messages,
      stream: chatRequest.stream,
    };
  }

  async denormalizeResponse(upstreamResponse: any, stream: boolean): Promise<any> {
    // OpenAI 格式直通
    return upstreamResponse;
  }

  async healthCheck(config: ProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl || this.defaultBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${baseUrl || this.defaultBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return [];
      const data: any = await res.json();
      return (data.data || []).map((m: any) => ({
        id: m.id,
        name: m.id,
        providerId: this.id,
        enabled: true,
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
