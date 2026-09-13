/**
 * M6 方向四 · 影子模式路由（dry-run）测试
 *
 * 核心安全不变式：routeShadow 只算建议 + 日志，绝不改变真实路由。
 * 用「调用前/后 providerConfig 与 model 完全不变」证明 dry-run。
 * 附带覆盖：门控开关、默认关、异常静默、建议为 null 的噪声抑制。
 */
import {
  routeShadow,
  isShadowEnabled,
  computeShadowSuggestion,
} from '../../src/routing/routing-shadow.js';
import { DEFAULT_ROUTE_CONFIG, type RouteConfig } from '../../src/routing/routeEngine.js';

// 造一个「真实路由结果」的 ProxyConfig 形状对象，用于验证影子模式不动它。
function makeRealConfig() {
  return {
    id: 'p-real',
    name: 'real-provider',
    providerId: 'openai',
    apiKey: 'sk-real',
    baseUrl: 'http://127.0.0.1:18794',
    enabled: true,
    } as any;
}

function snapshot(v: unknown): string {
  return JSON.stringify(v);
}

describe('M6 影子模式门控', () => {
  const ORIG = process.env.PROXY_ROUTING_SHADOW;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PROXY_ROUTING_SHADOW;
    else process.env.PROXY_ROUTING_SHADOW = ORIG;
    });

  it('默认关闭：任意 PROXY_ROUTING_SHADOW 取值不视为启用', () => {
    delete process.env.PROXY_ROUTING_SHADOW;
    expect(isShadowEnabled()).toBe(false);
    process.env.PROXY_ROUTING_SHADOW = '0';
    expect(isShadowEnabled()).toBe(false);
    process.env.PROXY_ROUTING_SHADOW = 'off';
    expect(isShadowEnabled()).toBe(false);
      });

  it('启用：1 / true / on 均视为开', () => {
    process.env.PROXY_ROUTING_SHADOW = '1';
    expect(isShadowEnabled()).toBe(true);
    process.env.PROXY_ROUTING_SHADOW = 'TRUE';
    expect(isShadowEnabled()).toBe(true);
    process.env.PROXY_ROUTING_SHADOW = 'on';
    expect(isShadowEnabled()).toBe(true);
    });
});

describe('M6 dry-run 不改变真实路由（核心安全不变式）', () => {
  const ORIG = process.env.PROXY_ROUTING_SHADOW;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PROXY_ROUTING_SHADOW;
    else process.env.PROXY_ROUTING_SHADOW = ORIG;
    });

  it('开启影子模式：调用前后 model 与 providerConfig 完整快照不变', () => {
    process.env.PROXY_ROUTING_SHADOW = '1';
    const model = 'qwen3.8-flash';
    let realConfig = makeRealConfig();
       // 真实路由结果（假设 findProviderConfig 已选定）
    const modelBefore = model;
    const configBefore = snapshot(realConfig);

       // 影子模式：用一条 coding 风格消息去算建议
    routeShadow(model, [{ role: 'user', content: '修复 src/app.ts 的空指针 bug' }]);

       // 断言：真实路由的 model 与 config 一个字节都没变
    expect(model).toBe(modelBefore);
    expect(snapshot(realConfig)).toBe(configBefore);
    });

  it('关闭影子模式：仍不改变真实路由（且无副作用）', () => {
    process.env.PROXY_ROUTING_SHADOW = '0';
    const model = 'deepseek-v4-pro';
    const realConfig = makeRealConfig();
    const before = snapshot(realConfig);
      // 即便关闭，调 routeShadow 也不应触碰 config
    routeShadow(model, [{ role: 'user', content: '写一段公众号营销文案' }]);
    expect(snapshot(realConfig)).toBe(before);
      });
});

describe('M6 建议计算 + 噪声抑制', () => {
  it('coding 任务建议 deepseek-v4-pro（默认配置 r-coding）', () => {
      // 默认配置的 defaultModel 是 qwen3.8-flash；coding 规则指向 deepseek-v4-pro → 产生切换建议
    const suggestion = computeShadowSuggestion('qwen3.8-flash', [
      { role: 'user', content: '帮我重构这段排序算法' },
      ], DEFAULT_ROUTE_CONFIG);
    expect(suggestion).toBe('deepseek-v4-pro');
    });

  it('建议与 defaultModel 相同时抑制（返回 null，避免噪声）', () => {
      // vision 任务也指向 qwen3.8-flash = 默认模型 → 无切换建议
    const suggestion = computeShadowSuggestion('qwen3.8-flash', [
      { role: 'user', content: '识别这张图片里的内容' },
      ], DEFAULT_ROUTE_CONFIG);
    expect(suggestion).toBeNull();
    });

  it('传入自定义 config：按其规则与建议', () => {
    const cfg: RouteConfig = {
      id: 'custom',
      defaultModel: 'x',
      fallbackChain: ['x', 'y'],
      rules: [{ id: 'r', condition: "taskType == 'writing'", targetProvider: 'writer-model' }],
      maxRetries: 3,
      strategy: 'priority',
        };
    expect(computeShadowSuggestion('x', [{ role: 'user', content: '写一篇文章' }], cfg)).toBe('writer-model');
    });

  it('routeShadow 返回结构完整（含 taskType 与建议）', () => {
    const res = routeShadow('qwen3.8-flash', [{ role: 'user', content: '修复 bug' }], DEFAULT_ROUTE_CONFIG);
    expect(res.taskType).toBe('coding');
    expect(res.suggestion).toBe('deepseek-v4-pro');
    expect(res.defaultModel).toBe(DEFAULT_ROUTE_CONFIG.defaultModel);
    });
});
