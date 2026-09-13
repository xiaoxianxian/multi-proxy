/**
 * M6 方向四 · D4=C · 路由 override 机制回归测试
 *
 * D4 拍定 C（override 主路径）：引擎路由建议可接管真实路由，但默认关（PROXY_ROUTE_OVERRIDE=0）。
 *
 * 本 suite 锁「override 机制正确性」，与 D5 对齐解耦：
 *   - 门控关闭（默认）：override 整段跳过，请求体 model 与 url 逐字节不变（与影子测试对称）。
 *   - 门控开启：引擎建议的 model 写入请求体（Q2=① 发引擎名），且落 overrideLog 审计（applied=true）。
 *   - 引擎不给建议（suggestion=null，如 writing/vision）：override 不触发，请求体不变。
 *   - 审计缓冲 getOverrideLog/clearOverrideLog 可读写。
 *
 * 不锁「路由到哪个具体 provider」——那取决于 D5 对齐（models 表命名空间映射），
 *   override 在 D5 完成前会 fallback 到首个 enabled provider，url 断言只锁 /chat/completions$。
 *
 * 做法：mock undici.fetch 捕获上游请求体（不触网络）；真实 handleChatCompletion +
 * 真实 findProviderConfig + 真实 DB；routing_mode pin='priority'（避免 rr_index 轮转扰动），
 * 跑完还原。
 */
import { jest } from '@jest/globals';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderConfig } from '../../src/providers/base.js';
import { db } from '../../src/db/database.js';

// 捕获 fetch 调用，返回可被非流式路径消费的 200 fake Response。
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
function makeAdapter(id: string) {
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
   } as any;
}

// 动态 import 让 unstable_mockModule('undici') 对 chatHandler 的 fetch 生效。
async function runHandler(
  override: boolean,
  model: string,
  messages: any[],
): Promise<{ url: string | null; bodyModel: string | null }> {
  const mod = await import('../../src/server/handlers/chatHandler.js');

  if (override) {
    process.env.PROXY_ROUTE_OVERRIDE = '1';
    } else {
    const orig = process.env.PROXY_ROUTE_OVERRIDE;
    if (orig !== undefined) delete process.env.PROXY_ROUTE_OVERRIDE;
    }

  fetchMock.mockClear();

   // 让真实 DB 中所有启用的 provider 类型都有 adapter 可用（override 可能改写到任意类型），
   // 否则 forward 路径 500、不发起 fetch。
   const allTypes = db.prepare(
     "SELECT DISTINCT provider_id FROM providers WHERE enabled = 1"
    ).all().map((r: any) => r.provider_id as string);
   const reg = ProviderRegistry.getInstance();
   for (const ptype of allTypes) {
     reg.register(makeAdapter(ptype));
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

  const call = fetchMock.mock.calls[0] as [string, any] | undefined;
  return {
    url: call ? call[0] : null,
    bodyModel: call ? JSON.parse(call[1].body).model : null,
  };
}

// coding / general / cheap 三类会让引擎给出建议（实测值）；writing / vision 建议为 null。
const MESSAGES = {
  coding:  [{ role: 'user', content: 'debug this bug in src/main.ts, compile error, refactor' }],
  general: [{ role: 'user', content: '你好 今天天气怎么样' }],
  cheap:   [{ role: 'user', content: '翻译 你好今天天气' }],
  writing: [{ role: 'user', content: '帮我写篇公众号文章 润色文案' }],
  vision:  [{ role: 'user', content: '看图 识别 image_url screenshot' }],
 };

describe('M6 D4=C · 路由 override 机制（chatHandler 级）', () => {
  let savedMode: string | undefined;

  beforeEach(() => {
   // pin routing_mode='priority'：避免 rr_index 轮转扰动，两次解析确定性落同一 provider。
    savedMode = (db.prepare("SELECT value FROM settings WHERE key = 'routing_mode'").get() as any)?.value;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
      .run('routing_mode', 'priority', 'string');
    delete process.env.PROXY_ROUTE_OVERRIDE;
    fetchMock.mockClear();
    });

  afterEach(() => {
    if (savedMode === undefined) {
      db.prepare("DELETE FROM settings WHERE key = 'routing_mode'").run();
      } else {
      db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
        .run('routing_mode', savedMode, 'string');
      }
    delete process.env.PROXY_ROUTE_OVERRIDE;
    fetchMock.mockClear();
    });

  it('门控关闭（默认）时 coding 任务：请求体 model 不被 override 改写（逐字节不变）', async () => {
    const { url, bodyModel } = await runHandler(false, 'qwen3.8-flash', MESSAGES.coding);
    expect(url).toMatch(/\/chat\/completions$/);
    expect(bodyModel).toBe('qwen3.8-flash');     // 未被 override 改写，保持输入原样
    });

  it('门控开启时 coding 任务：引擎建议写入请求体（Q2=① 发引擎名 deepseek-v4-pro）', async () => {
    const { url, bodyModel } = await runHandler(true, 'qwen3.8-flash', MESSAGES.coding);
    expect(url).toMatch(/\/chat\/completions$/);
    expect(bodyModel).toBe('deepseek-v4-pro');    // D5 对齐后：coding → deepseek-v4-pro
    });

  it('门控开启时 coding 任务：override 落审计日志（applied=true）', async () => {
    const mod = await import('../../src/server/handlers/chatHandler.js');
    mod.clearOverrideLog();
    await runHandler(true, 'qwen3.8-flash', MESSAGES.coding);
    const log = mod.getOverrideLog();
    const last = log[log.length - 1];
    expect(last).toBeDefined();
    expect(last.applied).toBe(true);
    expect(last.requestModel).toBe('qwen3.8-flash');
    expect(last.overrideModel).toBe('deepseek-v4-pro');
    expect(last.engineTaskType).toBe('coding');
     });

  it('门控开启但引擎不给建议（writing）：请求体不变，且无 override 审计', async () => {
    const mod = await import('../../src/server/handlers/chatHandler.js');
    mod.clearOverrideLog();
    const { bodyModel } = await runHandler(true, 'qwen3.8-flash', MESSAGES.writing);
    expect(bodyModel).toBe('qwen3.8-flash');   // suggestion=null，override 不触发
       // 不产生新审计条目
    expect(mod.getOverrideLog().length).toBe(0);
    });

  it('审计缓冲可读写：getOverrideLog 快照后 clearOverrideLog 清空', async () => {
    const mod = await import('../../src/server/handlers/chatHandler.js');
    mod.clearOverrideLog();
    await runHandler(true, 'qwen3.8-flash', MESSAGES.coding);
    expect(mod.getOverrideLog().length).toBe(1);
    mod.clearOverrideLog();
    expect(mod.getOverrideLog().length).toBe(0);
    });
});
