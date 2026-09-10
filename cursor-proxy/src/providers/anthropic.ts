import { ProviderAdapter, ProviderConfig, ModelInfo, UpstreamRequest } from './base.js';

export class AnthropicProvider implements ProviderAdapter {
  readonly id: 'anthropic' = 'anthropic';
  readonly name = 'Anthropic Claude';
  readonly defaultBaseUrl = 'https://api.anthropic.com';
  readonly wireApi: 'anthropic' = 'anthropic';

  async normalizeRequest(chatRequest: any, config: ProviderConfig): Promise<UpstreamRequest> {
    // Anthropic Messages API 请求转换
    return {
      model: chatRequest.model,
      messages: chatRequest.messages,
      system: chatRequest.system,
      max_tokens: chatRequest.max_tokens || 4096,
      stream: chatRequest.stream,
    };
  }

  async denormalizeResponse(upstreamResponse: any, stream: boolean): Promise<any> {
    // Anthropic 响应转换为 Chat Completions 格式
    if (stream) {
      return upstreamResponse; // SSE 格式，逐 chunk 转换
    }
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: upstreamResponse.content?.[0]?.text || '',
        },
        finish_reason: upstreamResponse.stop_reason,
      }],
      usage: upstreamResponse.usage,
    };
  }

  async healthCheck(config: ProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl || this.defaultBaseUrl}/v1/messages`, {
        method: 'GET',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchModels(_apiKey: string, _baseUrl: string): Promise<ModelInfo[]> {
    // Anthropic 模型列表是固定的
    return [
      { id: 'claude-sonnet-4-20250514', name: 'claude-sonnet-4-20250514', providerId: this.id, enabled: true },
      { id: 'claude-opus-4-20250514', name: 'claude-opus-4-20250514', providerId: this.id, enabled: true },
      { id: 'claude-3-5-sonnet-latest', name: 'claude-3-5-sonnet-latest', providerId: this.id, enabled: true },
      { id: 'claude-3-5-haiku-latest', name: 'claude-3-5-haiku-latest', providerId: this.id, enabled: true },
    ];
  }

  supportsTools(): boolean {
    return true;
  }

  supportsVision(): boolean {
    return true;
  }
}
