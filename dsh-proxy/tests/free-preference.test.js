// 阶段二 pickFreeProvider 纯函数单测（门控/去前缀/跳过禁用/未命中回退）。
// 关掉 model-sync，避免 require proxy.js 时触发上游拉取（本测试只测纯函数，不触网）。
process.env.PROXY_MODEL_SYNC = '0';

const { test } = require('node:test');
const assert = require('node:assert');
const { pickFreeProvider } = require('../proxy.js');

const providers = [
  {
    name: 'WorkBuddy', provider_id: 'workbuddy',
    base_url: 'http://127.0.0.1:18789/v1', api_key: '', enabled: true,
    models: ['wb-deepseek-v3.2', 'wb-glm-4.5'], freeModels: ['deepseek-v3.2'],
  },
  {
    name: 'Paid', provider_id: 'deepseek',
    base_url: 'https://paid.example/v1', api_key: 'k', enabled: true,
    models: ['deepseek-v3.2'], freeModels: [],
  },
];

test('门控关 → 恒返回 null（关时 findProvider 逐字节回上线前）', () => {
  assert.strictEqual(pickFreeProvider('deepseek-v3.2', providers, { gate: false }), null);
  assert.strictEqual(pickFreeProvider('wb-deepseek-v3.2', providers, { gate: false }), null);
});

test('门控开 + freeModels 命中（去 wb- 前缀）→ 返回免费 provider', () => {
  const r = pickFreeProvider('deepseek-v3.2', providers, { gate: true });
  assert.ok(r, '应命中免费 provider');
  assert.strictEqual(r.name, 'WorkBuddy');
  assert.strictEqual(r.baseUrl, 'http://127.0.0.1:18789/v1');
});

test('门控开 + 请求带 wb- 前缀也能命中（两侧都去前缀）', () => {
  const r = pickFreeProvider('wb-deepseek-v3.2', providers, { gate: true });
  assert.ok(r);
  assert.strictEqual(r.name, 'WorkBuddy');
});

test('门控开 + 未标免费的模型 → null（回退原模糊/内置逻辑）', () => {
  assert.strictEqual(pickFreeProvider('glm-4.5', providers, { gate: true }), null);
  assert.strictEqual(pickFreeProvider('some-unknown-model', providers, { gate: true }), null);
});

test('门控开 + 仅 disabled provider 有免费匹配 → null（跳过禁用项）', () => {
  const only = [{ name: 'Disabled', base_url: 'http://x/v1', enabled: false, models: ['deepseek-v3.2'], freeModels: ['deepseek-v3.2'] }];
  assert.strictEqual(pickFreeProvider('deepseek-v3.2', only, { gate: true }), null);
});

test('非数组 providers / 空 modelName → null', () => {
  assert.strictEqual(pickFreeProvider('deepseek-v3.2', null, { gate: true }), null);
  assert.strictEqual(pickFreeProvider('', providers, { gate: true }), null);
});

test('绝不拿「无 freeModels」的付费 provider 冒充免费', () => {
  // Paid provider models 含 deepseek-v3.2 但 freeModels 空 → 不得被选中
  const r = pickFreeProvider('deepseek-v3.2', [providers[1]], { gate: true });
  assert.strictEqual(r, null);
});
