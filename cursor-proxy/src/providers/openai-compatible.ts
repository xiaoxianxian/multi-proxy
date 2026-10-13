// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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
    // OpenAI 兼容型 Provider 直通，不做协议转换。
    // 2026-10-12 修（P0 静默降级）：原先只点名 model/messages/stream 三个字段，
    // 其余（tools / tool_choice / temperature / response_format …）被**静默丢弃** ——
    // 请求返回 200、正常回话，但零工具调用且无任何日志，而 supportsTools() 对外宣称 true。
    // 改为「先展开原请求、再用本 provider 的特有字段覆盖」，与 generic.ts 行为基准一致。
    return {
      ...chatRequest,
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
