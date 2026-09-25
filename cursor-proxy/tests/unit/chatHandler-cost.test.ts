/**
 * Q3 P1-B 成本闭环 · chatHandler 实采集成测试
 *
 * 核心断言（非侵入证据，chatHandler 级钉住）：
 *   A. 门控默认关：转发后 cursor-cost.jsonl 零写入（门控关=零开销=热路径零行为改动）。
 *   B. 门控开（PROXY_CURSOR_COST=1）：非流传转发出口提 usage → 落盘 1 条含 L0 价的 record。
 *
 * 做法（仿 chat-handler-shadow.test.ts）：mock undici.fetch 返回带 usage 的 200 fake Response；
 * 用真实 handleChatCompletion + 真实 findProviderConfig + 真实 DB（routing_mode='priority'，
 * 确保转发到的就是首个 enabled provider，reqBody.model 不被 override 改写）；
 * PROXY_CURSOR_COST_LOG 指向隔离 tmp 文件，避免污染真实 sidecar。
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderAdapter, ProviderConfig } from '../../src/providers/base.js';
import { db } from '../../src/db/database.js';

// fake 上游：非流式 JSON 含 usage（OpenAI 风格，含 cached_tokens 验 cache 实采路径透传）
const costUsage = {
  prompt_tokens: 1_000_000,
  completion_tokens: 1_000_000,
  prompt_tokens_details: { cached_tokens: 800_000 },
};
const fetchMock = jest.fn(async (_url: string, _init?: any) => ({
   ok: true,
   status: 200,
   statusText: 'OK',
   headers: new Map(),
   body: null,
   json: async () => ({ id: 'mock', choices: [{ message: { content: 'ok' } }], usage: costUsage }),
   text: async () => 'ok',
   } as any));
jest.unstable_mockModule('undici', () => ({ fetch: fetchMock }));

let costFile = '';
function freshCostFile() {
  costFile = path.join(os.tmpdir(), 'cursor-cost-itest-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.jsonl');
  process.env.PROXY_CURSOR_COST_LOG = costFile;
}

function makeAdapter(id: string): ProviderAdapter {
  return {
     id: id as any,
     name: `itest-${id}`,
     defaultBaseUrl: 'http://127.0.0.1:0',
     wireApi: 'openai',
     async normalizeRequest(req: any) { return { model: req.model, messages: req.messages, stream: false }; },
     async denormalizeResponse() { return {}; },
     async healthCheck() { return true; },
     async fetchModels() { return []; },
     supportsTools() { return false; },
     supportsVision() { return false; },
   };
}

async function runOnce(model: string, messages: unknown[]) {
  fetchMock.mockClear();
  const mod = await import('../../src/server/handlers/chatHandler.js');
  const realConfig = mod.findProviderConfig(model) as ProviderConfig | null;
  if (realConfig) ProviderRegistry.getInstance().register(makeAdapter(realConfig.providerId));
  const res: any = {
     status: jest.fn(() => res),
     json: jest.fn(),
     setHeader: jest.fn(),
     on: jest.fn(),
     write: jest.fn(),
     end: jest.fn(),
     writableEnded: false,
     };
  await mod.handleChatCompletion({ body: { model, messages, stream: false } } as any, res);
  return res.json.mock.calls.length;       // >0 表示转发成功（非流 res.json(data)）
   }

describe('Q3 实采成本闭环（chatHandler 级 · 非侵入）', () => {
 let savedMode: string | undefined;
  beforeEach(() => {
    savedMode = (db.prepare("SELECT value FROM settings WHERE key = 'routing_mode'").get() as any)?.value;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)").run('routing_mode', 'priority', 'string');
     freshCostFile();
   });

 afterAll(() => {
   try { fs.rmSync(costFile, { force: true }); } catch { /* noop */ }
     });
 afterEach(() => {
    delete process.env.PROXY_CURSOR_COST;
    delete process.env.PROXY_CURSOR_COST_LOG;
    fetchMock.mockClear();
    if (savedMode === undefined) db.prepare("DELETE FROM settings WHERE key = 'routing_mode'").run();
     else db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)").run('routing_mode', savedMode, 'string');
    });

  it('门控默认关 → 转发成功但 cursor-cost.jsonl 零写入（零开销证据）', async () => {
    delete process.env.PROXY_CURSOR_COST;    // 默认关
    const jsonCalls = await runOnce('deepseek-v4-pro', [{ role: 'user', content: 'hi' }]);
    expect(jsonCalls).toBeGreaterThan(0);    // 转发确实发生
    expect(fs.existsSync(costFile)).toBe(false);  // 零写盘
     });

  it('门控开 → 非流传落盘 1 条，含 L0 价 + 实采 usage/cache 维度', async () => {
    process.env.PROXY_CURSOR_COST = '1';
    const jsonCalls = await runOnce('deepseek-v4-pro', [{ role: 'user', content: 'write code' }]);
    expect(jsonCalls).toBeGreaterThan(0);
    expect(fs.existsSync(costFile)).toBe(true);
    const rec = JSON.parse(fs.readFileSync(costFile, 'utf8').trim().split('\n')[0]);
    expect(rec.source).toBe('actual');
    expect(rec.model).toBe('deepseek-v4-pro');
    expect(rec.inputTokens).toBe(1_000_000);
    expect(rec.outputTokens).toBe(1_000_000);
    expect(rec.cacheReadTokens).toBe(800_000);   // OpenAI cached_tokens 透传提取
     // deepseek L0: 非缓存 input=0.2M×0.5=0.1；输出 1M×3=3；命中 0.8M×0.02=0.016 → 3.116
    expect(Math.round(rec.cost * 1e6) / 1e6).toBe(3.116);
     });
});