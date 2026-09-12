/**
 * M6 方向四 · ① 影子转真实「前置安全闸门」
 *
 * 核心断言：开启 PROXY_ROUTING_SHADOW 后，handleChatCompletion 真实转发到的上游
 * （URL + 请求体 model）与未开启时**逐字节一致**——即影子模式绝不改动真实路由。
 * 这是「影子转真实」动手前必须先立住的不变式，由 chatHandler 级测试钉住
 *（而非仅在 routeShadow 单元层证明 dry-run）。
 *
 * 做法：mock undici.fetch 捕获上游地址与请求体（不触真实网络）；
 * 用真实 handleChatCompletion + 真实 findProviderConfig + 真实 DB；
 * 注册一个 passthrough adapter（让 forward 路径能跑通），再分别以
 * PROXY_ROUTING_SHADOW=off / on 调一次，断言两次上游地址与 model 完全相同。
 */
import { jest } from '@jest/globals';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderAdapter, ProviderConfig } from '../../src/providers/base.js';
import { db } from '../../src/db/database.js';

// 捕获 fetch 调用，返回一个可供非流式路径消费的 200 fake Response。
const fetchMock = jest.fn(async (_url: string, _init?: any) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Map(),
  body: null,
  json: async () => ({ id: 'mock', choices: [{ message: { content: 'ok' } }] }),
  text: async () => 'ok',
}) as any);

jest.unstable_mockModule('undici', () => ({ fetch: fetchMock }));

// passthrough adapter：normalizeRequest 原样回传 body，保证请求体 model === 入参 model。
function makeAdapter(id: string): ProviderAdapter {
  return {
    id: id as any,
    name: `passthrough-${id}`,
    defaultBaseUrl: 'http://127.0.0.1:0',
    wireApi: 'openai',
    async normalizeRequest(req: any) {
      return { model: req.model, messages: req.messages, stream: req.stream };
    },
    async denormalizeResponse() {
      return {};
    },
    async healthCheck() {
      return true;
    },
    async fetchModels() {
      return [];
    },
    supportsTools() {
      return false;
    },
    supportsVision() {
      return false;
    },
  };
}

// 动态 import：让 unstable_mockModule('undici') 对 chatHandler 的命名导入 fetch 生效。
async function runHandler(
  shadow: boolean,
  model: string,
  messages: unknown[],
): Promise<{ url: string; bodyModel: string }> {
  const orig = process.env.PROXY_ROUTING_SHADOW;
  if (shadow) process.env.PROXY_ROUTING_SHADOW = '1';
  else if (orig !== undefined) process.env.PROXY_ROUTING_SHADOW = orig;
  else delete process.env.PROXY_ROUTING_SHADOW;

  fetchMock.mockClear();

  const mod = await import('../../src/server/handlers/chatHandler.js');

  // 让真实 DB 选定的 provider 有 adapter 可用（否则 forward 路径会 500 不发起 fetch）。
  const realConfig = mod.findProviderConfig(model) as ProviderConfig | null;
  if (realConfig) {
    ProviderRegistry.getInstance().register(makeAdapter(realConfig.providerId));
    }

  const res: any = {
    status: jest.fn(() => res),
    json: jest.fn(),
    setHeader: jest.fn(),
    on: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    writableEnded: false,
    };
  const req: any = { body: { model, messages, stream: false } };

  await mod.handleChatCompletion(req, res);

  const call = fetchMock.mock.calls[0] as [string, any];
  return { url: call[0], bodyModel: JSON.parse(call[1].body).model };
}

describe('M6 ① 影子模式不改真实上游路由（chatHandler 级）', () => {
  // 钉住 routing_mode = 'priority' 测试 scope，跑完还原真实值。
  // 根因：round-robin 下 findProviderConfig 用持久化 rr_index 轮转 enabled providers，
  // 本 suite 在每次调用 handler 前先调一次 findProviderConfig（决定注册哪个 adapter），
  // handler 内部又调一次 → 两次落到不同 provider，后者没注册 adapter → 500，
  // fetch 不触发 → mock.calls 为空 → 断言崩。priority 下模型名不命中走
  // 「第一个 enabled provider」确定性路径，两次解析到同一 provider → 不变式成立。
  let savedMode: string | undefined;
  beforeEach(() => {
    savedMode = (db.prepare("SELECT value FROM settings WHERE key = 'routing_mode'").get() as any)?.value;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
     .run('routing_mode', 'priority', 'string');
   });

  afterEach(() => {
    if (savedMode === undefined) {
     db.prepare("DELETE FROM settings WHERE key = 'routing_mode'").run();
    } else {
     db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
      .run('routing_mode', savedMode, 'string');
    }
    delete process.env.PROXY_ROUTING_SHADOW;
    fetchMock.mockClear();
   });

  it('coding 任务：shadow on/off 转发到同一上游 URL + 同一 model', async () => {
    const model = 'qwen3.8-flash';
    const messages = [
      { role: 'user', content: 'Write a function that sorts an array, refactor src/foo.ts' },
      ];

     // shadow 关闭：基线
    const off = await runHandler(false, model, messages);
    expect(off.url).toMatch(/\/chat\/completions$/);
    expect(off.bodyModel).toBe(model);

     // shadow 开启：必须一致
    const on = await runHandler(true, model, messages);
    expect(on.url).toBe(off.url);      // 上游地址不变
    expect(on.bodyModel).toBe(model);   // 请求体 model 不变（未被影子建议替换）
    });

  it('shadow 开启时转发确实发生且 model 为请求原值（与影子建议解耦）', async () => {
    const model = 'qwen3.8-flash';
    const messages = [{ role: 'user', content: 'debug this bug in src/main.ts, compile error' }];

    const on = await runHandler(true, model, messages);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(on.url).toMatch(/\/chat\/completions$/);
     // 真实路由由 DB 决定；即便影子建议 deepseek-v4.1-flash，请求体 model 仍是原始入参。
    expect(on.bodyModel).toBe(model);
    });
});
