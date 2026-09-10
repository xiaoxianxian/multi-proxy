import { ProviderRegistry } from './registry.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleGeminiProvider } from './google-gemini.js';
import { OllamaProvider } from './ollama.js';
import { GenericProvider } from './generic.js';

export function registerDefaultProviders(registry: ProviderRegistry): void {
  registry.register(new OpenAICompatibleProvider());
  // DeepSeek uses the OpenAI-compatible wire protocol; register a dedicated
  // adapter instance so provider_id='deepseek' resolves (base.ts ProviderId).
  registry.register(new OpenAICompatibleProvider('deepseek'));
  registry.register(new AnthropicProvider());
  registry.register(new GoogleGeminiProvider());
  registry.register(new OllamaProvider());
  registry.register(new GenericProvider());
}

export { ProviderRegistry };
export type { ProviderAdapter, ProviderConfig, ModelInfo, UpstreamRequest } from './base.js';
export { OpenAICompatibleProvider } from './openai-compatible.js';
export { AnthropicProvider } from './anthropic.js';
export { GoogleGeminiProvider } from './google-gemini.js';
export { OllamaProvider } from './ollama.js';
export { GenericProvider } from './generic.js';
