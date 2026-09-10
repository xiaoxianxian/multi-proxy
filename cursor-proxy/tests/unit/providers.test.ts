import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { GoogleGeminiProvider } from '../../src/providers/google-gemini.js';
import { OllamaProvider } from '../../src/providers/ollama.js';
import { GenericProvider } from '../../src/providers/generic.js';
import { ProviderRegistry } from '../../src/providers/registry.js';

const config = {
  id: 'test',
  name: 'Test',
  providerId: 'openai' as const,
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com',
  enabled: true,
};

describe('OpenAICompatibleProvider', () => {
  const p = new OpenAICompatibleProvider();

  it('has correct identity', () => {
    expect(p.id).toBe('openai');
    expect(p.name).toBe('OpenAI Compatible');
    expect(p.defaultBaseUrl).toBe('https://api.openai.com/v1');
    expect(p.wireApi).toBe('openai');
  });

  it('normalizes request (passthrough)', async () => {
    const req = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true };
    const result = await p.normalizeRequest(req, config);
    expect(result.model).toBe('gpt-4');
    expect(result.messages).toEqual(req.messages);
    expect(result.stream).toBe(true);
  });

  it('denormalizes response (passthrough)', async () => {
    const resp = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
    const result = await p.denormalizeResponse(resp, false);
    expect(result).toBe(resp);
  });

  it('supports tools and vision', () => {
    expect(p.supportsTools()).toBe(true);
    expect(p.supportsVision()).toBe(true);
  });
});

describe('AnthropicProvider', () => {
  const p = new AnthropicProvider();

  it('has correct identity', () => {
    expect(p.id).toBe('anthropic');
    expect(p.name).toBe('Anthropic Claude');
    expect(p.defaultBaseUrl).toBe('https://api.anthropic.com');
    expect(p.wireApi).toBe('anthropic');
  });

  it('adds max_tokens default when not provided', async () => {
    const req = { model: 'claude-3', messages: [{ role: 'user', content: 'hi' }], stream: false };
    const result = await p.normalizeRequest(req, config);
    expect(result.model).toBe('claude-3');
    expect(result.max_tokens).toBe(4096);
  });

  it('preserves user-provided max_tokens', async () => {
    const req = { model: 'claude-3', messages: [], max_tokens: 8192, stream: false };
    const result = await p.normalizeRequest(req, config);
    expect(result.max_tokens).toBe(8192);
  });

  it('denormalizes non-streaming response', async () => {
    const upstream = {
      content: [{ text: 'Hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const result = await p.denormalizeResponse(upstream, false);
    expect(result.choices[0].message.content).toBe('Hello world');
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.choices[0].finish_reason).toBe('end_turn');
    expect(result.usage.input_tokens).toBe(10);
  });

  it('handles empty content array', async () => {
    const upstream = { content: [], stop_reason: 'stop', usage: {} };
    const result = await p.denormalizeResponse(upstream, false);
    expect(result.choices[0].message.content).toBe('');
  });

  it('passes through streaming response unchanged', async () => {
    const upstream = { type: 'content_block_delta', delta: { text: 'hello' } };
    const result = await p.denormalizeResponse(upstream, true);
    expect(result).toBe(upstream);
  });

  it('supports tools and vision', () => {
    expect(p.supportsTools()).toBe(true);
    expect(p.supportsVision()).toBe(true);
  });

  it('fetches hardcoded model list', async () => {
    const models = await p.fetchModels('sk-test', 'https://api.anthropic.com');
    expect(models).toHaveLength(4);
    expect(models[0].providerId).toBe('anthropic');
  });
});

describe('GoogleGeminiProvider', () => {
  const p = new GoogleGeminiProvider();

  it('has correct identity', () => {
    expect(p.id).toBe('gemini');
    expect(p.name).toBe('Google Gemini');
    expect(p.defaultBaseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(p.wireApi).toBe('gemini');
  });

  it('maps messages to contents and adds systemInstruction', async () => {
    const req = {
      model: 'gemini-pro',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be helpful',
      stream: false,
    };
    const result = await p.normalizeRequest(req, config);
    expect(result.contents).toEqual(req.messages);
    expect(result.systemInstruction).toBe('be helpful');
  });

  it('denormalizes non-streaming response', async () => {
    const upstream = {
      candidates: [{
        content: { parts: [{ text: 'Gemini answer' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 50 },
    };
    const result = await p.denormalizeResponse(upstream, false);
    expect(result.choices[0].message.content).toBe('Gemini answer');
    expect(result.choices[0].finish_reason).toBe('STOP');
  });

  it('handles empty/missing candidate gracefully', async () => {
    const upstream = { candidates: [{}] };
    const result = await p.denormalizeResponse(upstream, false);
    expect(result.choices[0].message.content).toBe('');
    expect(result.choices[0].finish_reason).toBeUndefined();
  });

  it('passes through streaming response unchanged', async () => {
    const upstream = { candidates: [{ content: { parts: [{ text: 'a' }] } }] };
    const result = await p.denormalizeResponse(upstream, true);
    expect(result).toBe(upstream);
  });

  it('supports tools and vision', () => {
    expect(p.supportsTools()).toBe(true);
    expect(p.supportsVision()).toBe(true);
  });
});

describe('OllamaProvider', () => {
  const p = new OllamaProvider();

  it('has correct identity', () => {
    expect(p.id).toBe('ollama');
    expect(p.name).toBe('Ollama');
    expect(p.defaultBaseUrl).toBe('http://localhost:11434');
    expect(p.wireApi).toBe('ollama');
  });

  it('denormalizes non-streaming response with usage', async () => {
    const upstream = {
      message: { role: 'assistant', content: 'Ollama answer' },
      done: true,
      eval_count: 100,
      prompt_eval_count: 50,
    };
    const result = await p.denormalizeResponse(upstream, false);
    expect(result.choices[0].message.content).toBe('Ollama answer');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.total_tokens).toBe(150);
  });

  it('handles missing eval_count', async () => {
    const upstream = { message: { content: 'x' }, done: false };
    const result = await p.denormalizeResponse(upstream, false);
    expect(result.choices[0].message.content).toBe('x');
    expect(result.usage).toBeUndefined();
  });

  it('does not support tools or vision', () => {
    expect(p.supportsTools()).toBe(false);
    expect(p.supportsVision()).toBe(false);
  });
});

describe('GenericProvider', () => {
  const p = new GenericProvider();

  it('has correct identity', () => {
    expect(p.id).toBe('generic');
    expect(p.name).toBe('Generic Provider');
    expect(p.defaultBaseUrl).toBe('http://localhost:8000/v1');
    expect(p.wireApi).toBe('openai');
  });

  it('passthroughs request and response', async () => {
    const req = { model: 'custom', messages: [], stream: true };
    const result = await p.normalizeRequest(req, config);
    expect(result.model).toBe('custom');

    const resp = { choices: [] };
    const denorm = await p.denormalizeResponse(resp, false);
    expect(denorm).toBe(resp);
  });

  it('supports tools and vision', () => {
    expect(p.supportsTools()).toBe(true);
    expect(p.supportsVision()).toBe(true);
  });
});

describe('ProviderRegistry', () => {
  beforeEach(() => {
    // Reset singleton
    (ProviderRegistry as any).instance = undefined;
  });

  it('is a singleton', () => {
    const a = ProviderRegistry.getInstance();
    const b = ProviderRegistry.getInstance();
    expect(a).toBe(b);
  });

  it('registers and retrieves providers', () => {
    const reg = ProviderRegistry.getInstance();
    const openai = new OpenAICompatibleProvider();
    reg.register(openai);
    expect(reg.get('openai')).toBe(openai);
  });

  it('returns undefined for unregistered provider', () => {
    const reg = ProviderRegistry.getInstance();
    expect(reg.get('anthropic' as any)).toBeUndefined();
  });

  it('collects all registered providers', () => {
    const reg = ProviderRegistry.getInstance();
    reg.register(new OpenAICompatibleProvider());
    reg.register(new AnthropicProvider());
    const all = reg.getAll();
    expect(all).toHaveLength(2);
  });
});
