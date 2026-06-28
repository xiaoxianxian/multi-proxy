// Extract pure logic from proxy.js for testing
// These are the core functions that can be tested without a running server.

const fs = require('fs');
const path = require('path');

// ===== Mock UPSTREAM_MODELS =====
const UPSTREAM_MODELS = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-deepseek-test',
    availableModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: 'sk-moonshot-test',
    availableModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'moonshot-v1-128k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-8k-vision-preview', 'moonshot-v1-auto']
  },
  {
    name: 'Agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: 'sk-agnes-test',
    availableModels: ['agnes-2.0-flash', 'agnes-1.5-flash', 'agnes-image-2.0-flash', 'agnes-image-2.1-flash', 'agnes-video-v2.0']
  }
];

function findProvider(modelName) {
  if (!modelName) return null;
  let provider = UPSTREAM_MODELS.find(p => p.availableModels.includes(modelName));
  if (provider) return provider;
  const lower = modelName.toLowerCase();
  if (lower.includes('deepseek')) return UPSTREAM_MODELS[0];
  if (lower.includes('kimi') || lower.includes('moonshot')) return UPSTREAM_MODELS[1];
  if (lower.includes('agnes')) return UPSTREAM_MODELS[2];
  return null;
}

function parseConfigToml(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m);
    const modelProviderMatch = content.match(/^model_provider\s*=\s*"([^"]+)"/m);
    const wireApiMatch = content.match(/^wire_api\s*=\s*"([^"]+)"/m);
    const yamlModelMatch = content.match(/(?:^|\n)\s*default:\s*(\S+)/m);
    const yamlProviderMatch = content.match(/(?:^|\n)\s*provider:\s*(\S+)/m);

    let model = '';
    let model_provider = '';
    let wire_api = '';

    if (filePath.endsWith('.toml') || modelMatch) {
      model = modelMatch ? modelMatch[1] : '';
      model_provider = modelProviderMatch ? modelProviderMatch[1] : '';
      wire_api = wireApiMatch ? wireApiMatch[1] : '';
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml') || yamlModelMatch) {
      model = yamlModelMatch ? yamlModelMatch[1] : '';
      model_provider = yamlProviderMatch ? yamlProviderMatch[1] : '';
      wire_api = '';
    }

    return { model, model_provider, wire_api, raw: content };
  } catch (e) {
    return { model: '', model_provider: '', wire_api: '', raw: '', error: e.message };
  }
}

function updateConfigToml(filePath, newModel) {
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.toml')) {
      content = content.replace(/^model\s*=\s*".+"$/m, `model = "${newModel}"`);
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      content = content.replace(/(default:\s*)(\S+)/m, `$1${newModel}`);
      if (!content.includes(`default: ${newModel}`)) {
        content = content.replace(/(model:\s*\n\s*default:\s*)(\S+)/m, `$1${newModel}`);
      }
    } else {
      content = content.replace(/^model\s*=\s*".+"$/m, `model = "${newModel}"`);
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, message: `Updated model to ${newModel}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

describe('findProvider', () => {
  it('finds by exact model name match', () => {
    expect(findProvider('deepseek-v4-pro').name).toBe('DeepSeek');
    expect(findProvider('kimi-k2.5').name).toBe('Kimi');
    expect(findProvider('agnes-2.0-flash').name).toBe('Agnes');
  });

  it('finds by pattern matching (deepseek)', () => {
    expect(findProvider('DEEPSEEK-V4-PRO').name).toBe('DeepSeek');
    expect(findProvider('my-deepseek-model').name).toBe('DeepSeek');
  });

  it('finds by pattern matching (kimi/moonshot)', () => {
    expect(findProvider('kimi-k2.7-code').name).toBe('Kimi');
    expect(findProvider('moonshot-v1-auto').name).toBe('Kimi');
    expect(findProvider('custom-kimi-model').name).toBe('Kimi');
  });

  it('finds by pattern matching (agnes)', () => {
    expect(findProvider('agnes-image-2.1-flash').name).toBe('Agnes');
    expect(findProvider('custom-agnes-model').name).toBe('Agnes');
  });

  it('returns null for unknown model', () => {
    expect(findProvider('unknown-xyz')).toBe(null);
  });

  it('returns null for empty model', () => {
    expect(findProvider('')).toBe(null);
    expect(findProvider(undefined)).toBe(null);
  });

  it('returns correct baseUrl for each provider', () => {
    expect(findProvider('deepseek-v4-pro').baseUrl).toBe('https://api.deepseek.com/v1');
    expect(findProvider('kimi-k2.5').baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(findProvider('agnes-2.0-flash').baseUrl).toBe('https://apihub.agnes-ai.com/v1');
  });
});

describe('parseConfigToml', () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('parses TOML format', () => {
    tmpFile = path.join('/tmp', 'test-config-' + Date.now() + '.toml');
    fs.writeFileSync(tmpFile, 'model = "gpt-4"\nmodel_provider = "openai"\nwire_api = "openai"');
    const result = parseConfigToml(tmpFile);
    expect(result.model).toBe('gpt-4');
    expect(result.model_provider).toBe('openai');
    expect(result.wire_api).toBe('openai');
  });

  it('parses YAML format', () => {
    tmpFile = path.join('/tmp', 'test-config-' + Date.now() + '.yaml');
    fs.writeFileSync(tmpFile, 'model:\n  default: claude-3\n  provider: anthropic');
    const result = parseConfigToml(tmpFile);
    expect(result.model).toBe('claude-3');
  });

  it('returns empty strings for missing fields', () => {
    tmpFile = path.join('/tmp', 'test-config-' + Date.now() + '.toml');
    fs.writeFileSync(tmpFile, '# empty config');
    const result = parseConfigToml(tmpFile);
    expect(result.model).toBe('');
    expect(result.model_provider).toBe('');
  });

  it('handles non-existent file gracefully', () => {
    const result = parseConfigToml('/tmp/nonexistent-config-12345.toml');
    expect(result.error).toBeDefined();
    expect(result.model).toBe('');
  });
});

describe('updateConfigToml', () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('updates TOML model field', () => {
    tmpFile = path.join('/tmp', 'test-update-' + Date.now() + '.toml');
    fs.writeFileSync(tmpFile, 'model = "old-model"\nother = "value"');
    const result = updateConfigToml(tmpFile, 'new-model');
    expect(result.success).toBe(true);
    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).toContain('model = "new-model"');
    expect(content).toContain('other = "value"');
  });

  it('updates YAML default field', () => {
    tmpFile = path.join('/tmp', 'test-update-' + Date.now() + '.yaml');
    fs.writeFileSync(tmpFile, 'model:\n  default: old-model');
    const result = updateConfigToml(tmpFile, 'new-model');
    expect(result.success).toBe(true);
    const content = fs.readFileSync(tmpFile, 'utf-8');
    expect(content).toContain('new-model');
  });

  it('returns error for non-existent file', () => {
    const result = updateConfigToml('/tmp/nonexistent-' + Date.now() + '.toml', 'x');
    expect(result.success).toBe(false);
  });
});

describe('UPSTREAM_MODELS', () => {
  it('has 3 providers', () => {
    expect(UPSTREAM_MODELS).toHaveLength(3);
  });

  it('all providers have api keys set (for test)', () => {
    UPSTREAM_MODELS.forEach(p => {
      expect(p.apiKey).toBeDefined();
      expect(p.apiKey.length).toBeGreaterThan(0);
    });
  });

  it('DeepSeek has 2 models', () => {
    expect(UPSTREAM_MODELS[0].availableModels).toHaveLength(2);
  });

  it('Kimi has 11 models', () => {
    expect(UPSTREAM_MODELS[1].availableModels).toHaveLength(11);
  });

  it('Agnes has 5 models', () => {
    expect(UPSTREAM_MODELS[2].availableModels).toHaveLength(5);
  });
});
