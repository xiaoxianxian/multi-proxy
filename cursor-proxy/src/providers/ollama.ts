import { ProviderAdapter, ProviderConfig, ModelInfo, UpstreamRequest } from './base.js';

export class OllamaProvider implements ProviderAdapter {
  readonly id: 'ollama' = 'ollama';
  readonly name = 'Ollama';
  readonly defaultBaseUrl = 'http://localhost:11434';
  readonly wireApi: 'ollama' = 'ollama';

  async normalizeRequest(chatRequest: any, config: ProviderConfig): Promise<UpstreamRequest> {
    return {
      model: chatRequest.model,
      messages: chatRequest.messages,
      stream: chatRequest.stream,
    };
  }

  async denormalizeResponse(upstreamResponse: any, stream: boolean): Promise<any> {
    if (stream) {
      return upstreamResponse;
    }
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: upstreamResponse.message?.content || '',
        },
        finish_reason: upstreamResponse.done ? 'stop' : null,
      }],
      usage: upstreamResponse.eval_count ? {
        prompt_tokens: upstreamResponse.prompt_eval_count || 0,
        completion_tokens: upstreamResponse.eval_count || 0,
        total_tokens: (upstreamResponse.prompt_eval_count || 0) + (upstreamResponse.eval_count || 0),
      } : undefined,
    };
  }

  async healthCheck(config: ProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl || this.defaultBaseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchModels(_apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${baseUrl || this.defaultBaseUrl}/api/tags`);
      if (!res.ok) return [];
      const data: any = await res.json();
      return (data.models || []).map((m: any) => ({
        id: m.name,
        name: m.name,
        providerId: this.id,
        enabled: true,
      }));
    } catch {
      return [];
    }
  }

  supportsTools(): boolean {
    return false;
  }

  supportsVision(): boolean {
    return false;
  }
}
