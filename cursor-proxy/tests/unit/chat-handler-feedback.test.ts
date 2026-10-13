// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * M6 方向四 · ② P0-2 反馈闭环「热路径回填」钉住
 *
 * 核心断言（修 2026-10-13 缺口）：
 *   开启 PROXY_ROUTING_FEEDBACK=1 后，handleChatCompletion 真实转发成功后，
 *   routing_feedback.latency_ms 必须被回填（非 NULL）——即 forwardToProvider 把
 *   applyRouting 拿到的 rowid 串到 recordRuntimeUpdate。
 *
 *   这是此前断链点：recordRuntimeUpdate 已定义+import 却从未在热路径调用，
 *   导致 routing_feedback.latency_ms 永远 NULL → aggregateFeedback 的 forwarded 恒 0
 *   → capability-derive 把所有格判「样本不足」打回 null → 校准链完全失效。
 *
 * 同时钉住端到端：gate 开后 跑 handler → aggregateFeedback → deriveCapabilityEvidence
 * 必须产出「非空」能力档（证明闭环现在真能产出校准数据）。
 *
 * 做法：mock undici.fetch 返回 200 fake Response（不触真实网络）；
 *   真实 handleChatCompletion + 真实 findProviderConfig + 真实 DB；
 *   注册 passthrough adapter 让 forward 路径跑通。
 */
import { jest } from '@jest/globals';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderAdapter, ProviderConfig } from '../../src/providers/base.js';
import { db } from '../../src/db/database.js';
import { aggregateFeedback } from '../../src/routing/routeFeedback.js';
import { deriveCapabilityEvidence } from '../../src/routing/capability-derive.js';

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

const MODEL = 'qwen3.8-flash';

async function runHandlerOnce(): Promise<void> {
  const mod = await import('../../src/server/handlers/chatHandler.js');
  const realConfig = mod.findProviderConfig(MODEL) as ProviderConfig | null;
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
  const req: any = {
    body: { model: MODEL, messages: [{ role: 'user', content: 'Write a function that sorts an array, refactor src/foo.ts' }], stream: false },
  };
  await mod.handleChatCompletion(req, res);
}

describe('M6 ② P0-2 反馈闭环：热路径回填 latency + 端到端产出校准', () => {
  let savedMode: string | undefined;

  beforeEach(() => {
    // gate 开
    process.env.PROXY_ROUTING_FEEDBACK = '1';
    delete process.env.PROXY_ROUTING_OVERRIDE;
    delete process.env.PROXY_ROUTING_SHADOW;

    // 清空反馈表
    db.prepare('DELETE FROM routing_feedback').run();

    // routing_mode = priority（与影子测试同因：确定性解析，避免 rr 轮转致 adapter 错配 500）
    savedMode = (db.prepare("SELECT value FROM settings WHERE key = 'routing_mode'").get() as any)?.value;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
      .run('routing_mode', 'priority', 'string');
  });

  afterEach(() => {
    delete process.env.PROXY_ROUTING_FEEDBACK;
    delete process.env.PROXY_ROUTING_OVERRIDE;
    delete process.env.PROXY_ROUTING_SHADOW;
    db.prepare('DELETE FROM routing_feedback').run();
    if (savedMode === undefined) {
      db.prepare("DELETE FROM settings WHERE key = 'routing_mode'").run();
    } else {
      db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)")
        .run('routing_mode', savedMode, 'string');
    }
  });

  it('gate 开：handler 跑完后 routing_feedback.latency_ms 被回填（非 NULL）', async () => {
    await runHandlerOnce();

    const row = db.prepare('SELECT model, latency_ms, retried FROM routing_feedback WHERE model = ?')
      .get(MODEL) as any;
    expect(row).toBeTruthy();
    expect(row.latency_ms).not.toBeNull();   // 关键：热路径回填触发（此前恒 NULL）
    expect(Number(row.latency_ms)).toBeGreaterThanOrEqual(0);
  });

  it('gate 开：端到端 aggregateFeedback→deriveCapabilityEvidence 产出非空能力档', async () => {
    // 攒够 minSamples(默认 30) 样本，验证真实阈值下闭环产出非空校准档（而非全 null）。
    for (let i = 0; i < 35; i++) {
      await runHandlerOnce();
    }

    const groups = aggregateFeedback(7) as any[];
    const g = groups.find((x) => x.model === MODEL);
    expect(g).toBeTruthy();
    expect(g.forwarded).toBeGreaterThanOrEqual(30);   // 此前恒 0 → 全部判样本不足
    expect(g.avg_latency_ms).not.toBeNull();

    const evidence = deriveCapabilityEvidence(groups, undefined, '2026-10-13');
    const mine = evidence.find((e) => e.model === MODEL);
    expect(mine).toBeTruthy();
    expect(mine!.suggestedLevel).not.toBeNull();      // 闭环修复前这里是 null
  });

  it('gate 关：handler 跑完零写入（热路径默认零行为变更）', async () => {
    delete process.env.PROXY_ROUTING_FEEDBACK;
    await runHandlerOnce();
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM routing_feedback').get() as any;
    expect(cnt.c).toBe(0);
  });
});
