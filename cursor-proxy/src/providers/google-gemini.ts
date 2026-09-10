import { ProviderAdapter, ProviderConfig, ModelInfo, UpstreamRequest } from './base.js';

export class GoogleGeminiProvider implements ProviderAdapter {
  readonly id: 'gemini' = 'gemini';
  readonly name = 'Google Gemini';
  readonly defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  readonly wireApi: 'gemini' = 'gemini';

  async normalizeRequest(chatRequest: any, config: ProviderConfig): Promise<UpstreamRequest> {
    return {
      model: chatRequest.model,
      messages: chatRequest.messages,
      contents: chatRequest.messages,
      systemInstruction: chatRequest.system,
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
          content: upstreamResponse.candidates?.[0]?.content?.parts?.[0]?.text || '',
        },
        finish_reason: upstreamResponse.candidates?.[0]?.finishReason,
      }],
      usage: upstreamResponse.usageMetadata,
    };
  }

  async healthCheck(config: ProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(
        `${config.baseUrl || this.defaultBaseUrl}/models?key=${config.apiKey}`,
        { signal: AbortSignal.timeout(5000) }
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    try {
      const res = await fetch(
        `${baseUrl || this.defaultBaseUrl}/models?key=${apiKey}`
      );
      if (!res.ok) return [];
      const data: any = await res.json();
      return (data.models || []).map((m: any) => ({
        id: m.name.replace('models/', ''),
        name: m.name.replace('models/', ''),
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
