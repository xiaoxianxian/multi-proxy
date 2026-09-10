// Provider 抽象接口
export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'deepseek' | 'generic';

export interface ModelInfo {
  id: string;
  name: string;
  providerId: ProviderId;
  enabled: boolean;
  alias?: string;
}

export interface UpstreamRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  [key: string]: any;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  defaultBaseUrl: string;
  wireApi: 'openai' | 'anthropic' | 'gemini' | 'ollama';

  // 将 OpenAI 格式的请求转换为目标模型的格式
  normalizeRequest(chatRequest: any, config: ProviderConfig): Promise<UpstreamRequest>;

  // 将目标模型的响应转换为 OpenAI 格式
  denormalizeResponse(upstreamResponse: any, stream: boolean): Promise<any>;

  // 健康检查
  healthCheck(config: ProviderConfig): Promise<boolean>;

  // 获取可用模型列表
  fetchModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]>;

  // 支持工具调用？
  supportsTools(): boolean;

  // 支持视觉？
  supportsVision(): boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  providerId: ProviderId;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
}
