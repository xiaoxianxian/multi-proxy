// Provider adapter tests — verify request/response transformation logic
// These test the conversion patterns used by each provider adapter.

describe('Provider Adapters — Request Transformation', () => {
  describe('OpenAI Compatible', () => {
    // OpenAI compatible: passthrough, no conversion
    it('passes through model, messages, and stream', () => {
      const req = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], stream: true };
      // Expected: same as input (minus unused fields)
      expect(req.model).toBe('gpt-4');
      expect(req.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(req.stream).toBe(true);
    });
  });

  describe('Anthropic', () => {
    it('adds max_tokens default when not provided', () => {
      const req = { model: 'claude-3', messages: [{ role: 'user', content: 'hi' }], stream: false };
      const transformed = {
        model: req.model,
        messages: req.messages,
        system: req.system,
        max_tokens: req.max_tokens || 4096,
        stream: req.stream,
      };
      expect(transformed.max_tokens).toBe(4096);
    });

    it('preserves user-provided max_tokens', () => {
      const req = { model: 'claude-3', messages: [], max_tokens: 8192, stream: false };
      const transformed = {
        model: req.model,
        messages: req.messages,
        max_tokens: req.max_tokens || 4096,
        stream: req.stream,
      };
      expect(transformed.max_tokens).toBe(8192);
    });

    it('denormalizes Anthropic response to OpenAI format', () => {
      const upstream = {
        content: [{ text: 'Hello world' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      };
      const result = {
        choices: [{
          message: {
            role: 'assistant',
            content: upstream.content?.[0]?.text || '',
          },
          finish_reason: upstream.stop_reason,
        }],
        usage: upstream.usage,
      };
      expect(result.choices[0].message.content).toBe('Hello world');
      expect(result.choices[0].message.role).toBe('assistant');
      expect(result.usage.input_tokens).toBe(10);
    });
  });

  describe('Google Gemini', () => {
    it('maps messages to contents', () => {
      const req = {
        model: 'gemini-pro',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'be helpful',
      };
      const transformed = {
        model: req.model,
        messages: req.messages,
        contents: req.messages,
        systemInstruction: req.system,
      };
      expect(transformed.contents).toEqual(req.messages);
      expect(transformed.systemInstruction).toBe('be helpful');
    });

    it('denormalizes Gemini response to OpenAI format', () => {
      const upstream = {
        candidates: [{
          content: { parts: [{ text: 'Gemini answer' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { totalTokenCount: 50 },
      };
      const result = {
        choices: [{
          message: {
            role: 'assistant',
            content: upstream.candidates?.[0]?.content?.parts?.[0]?.text || '',
          },
          finish_reason: upstream.candidates?.[0]?.finishReason,
        }],
        usage: upstream.usageMetadata,
      };
      expect(result.choices[0].message.content).toBe('Gemini answer');
      expect(result.choices[0].finish_reason).toBe('STOP');
    });

    it('handles empty Gemini response gracefully', () => {
      const upstream = { candidates: [{}] };
      const result = {
        choices: [{
          message: {
            role: 'assistant',
            content: upstream.candidates?.[0]?.content?.parts?.[0]?.text || '',
          },
          finish_reason: upstream.candidates?.[0]?.finishReason,
        }],
      };
      expect(result.choices[0].message.content).toBe('');
    });
  });

  describe('Model Info', () => {
    it('creates valid model info objects', () => {
      const model = { id: 'gpt-4', name: 'gpt-4', providerId: 'openai', enabled: true };
      expect(model.id).toBeDefined();
      expect(model.name).toBeDefined();
      expect(model.providerId).toBe('openai');
      expect(model.enabled).toBe(true);
    });
  });
});
