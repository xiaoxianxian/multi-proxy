// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// egress-ledger · Orchestrator / 路由 集成测试（P2 观测件 2026-10-17）。
// 验证三件事：① 未注入 = 零行为变更（无 egress 键、ledger 不记账）；
//            ② 注入 + 非 shadow = 三跳全记账，字段从 value 正确挖取；
//            ③ shadow = 记账但 bytes/tokens 为 null（不填 0）；路由门控 = 关 403 / 开 200。
// 隔离纪律：全内联 mock；env 用完即清（PROXY_L2_EGRESS_LEDGER）。

const path = require('path');
const express = require('express');
const request = require('supertest');

// 本文件走 jest（multi-proxy-manager 的 test runner），describe/test/expect/afterEach 由 jest 全局注入，
// 与同目录 relay-ledger.test.js 同一套。勿手写 require('node:test') —— 会遮蔽全局 expect。

const L2 = path.join(__dirname, '../../../l2');
const { createEgressLedger } = require(path.join(L2, 'egress-ledger.js'));
const { Orchestrator } = require(path.join(L2, 'orchestrator.js'));

const GATE = 'PROXY_L2_EGRESS_LEDGER';

function chatValueWithUsage({ prompt = 100, completion = 50, adapterId = 'codex' } = {}) {
    return {
        adapterId, bound: true, kind: 'chat',
        raw: {
            task_id: 'l1_x', type: 'chat', state: 'done', agent: adapterId,
            result: {
                content: 'ok', contentSource: 'content', model: 'm', id: 'x',
                raw: { id: 'x', model: 'm', usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } },
            },
            error: null,
        },
    };
}

const dag = {
    input: 'demo', template: 'chain', edges: [['a', 'b'], ['b', 'c']],
    subtasks: [
        { id: 'a', type: 'plan', prompt: 'a', deps: [] },
        { id: 'b', type: 'code', prompt: 'b', deps: ['a'] },
        { id: 'c', type: 'test', prompt: 'c', deps: ['b'] },
    ],
};

afterEach(() => { delete process.env[GATE]; });

describe('egress-ledger · Orchestrator 集成', () => {
    test('未注入（默认）：返回不含 egress 键、ledger 不动作 —— 零行为变更', async () => {
        const orch = new Orchestrator({ shadowMode: true });
        const out = await orch.run(dag, {});
        expect(out.egress).toBeUndefined();
        expect(out.relay).toBeUndefined();
        expect(Object.keys(out).sort()).toEqual(['history', 'report', 'results']);
    });

    test('注入 + 非 shadow：三跳全记账，client/destHost/bytes/tokens 挖对', async () => {
        const led = createEgressLedger();
        const orch = new Orchestrator({
            shadowMode: false,
            egressLedger: led,
            executor: async (st) => {
                const v = chatValueWithUsage({
                    prompt: 100, completion: st.id === 'c' ? 50 : 200,
                    adapterId: st.id === 'a' ? 'codex' : 'claude',
                });
                // 模拟 proxy 转发层已把出站字节与上游 host 注入 value（本轮未做，列为下一步）
                v.bytesOut = 313070842;
                v.upstreamHost = 'oss.example.com';
                return v;
            },
        });
        const out = await orch.run(dag, {});
        expect(out.egress).toBeUndefined();           // egress 字段是 routes 层附加，Orchestrator.run 不挂
        expect(led.size()).toBe(3);                  // 三跳全记账
        const rows = led.getRows();
        const codexRow = rows.find((r) => r.client === 'codex');
        expect(codexRow).toBeDefined();
        expect(codexRow.destHost).toBe('oss.example.com');
        expect(codexRow.bytes).toBe(313070842);
        expect(codexRow.tokens).toBe(300);           // a: prompt 100 + completion 200
        expect(codexRow.bytesFound).toBe(true);
        expect(codexRow.proxy).toBeNull();
        // 异常判定：oversize（313MB >> 50MB）应命中；ratio 也应命中（字节巨大、token 极小）
        const report = led.report();
        expect(report.rowCount).toBe(3);
        expect(report.anomalousCount).toBeGreaterThan(0);
        expect(report.anomalous[0].anomalies).toContain('oversize');
    });

    test('注入 + 适配器形态（raw.egress）：字节/目的地从 l1-agent adapter 的 egress 字段挖取', async () => {
        // 模拟真实 adapter 输出：executor-bind 的 def.invoke 把 adapter.invoke() 的返回包成
        // { adapterId, kind, agent, content, model, raw }，而 raw.egress 由 adapter 在 invoke 里量好带上。
        const led = createEgressLedger();
        const orch = new Orchestrator({
            shadowMode: false,
            egressLedger: led,
            executor: async () => ({
                adapterId: 'codex',
                kind: 'chat', agent: 'codex', content: 'ok', model: 'm',
                raw: {
                    type: 'chat', state: 'done', agent: 'codex',
                    result: {
                        content: 'ok', model: 'm', id: 'x',
                        raw: { id: 'x', model: 'm', usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } },
                    },
                    egress: { bytesOut: 24576, upstreamHost: '127.0.0.1:18790', usage: null },
                },
            }),
        });
        await orch.run(dag, {});
        expect(led.size()).toBe(3);
        const row = led.getRows()[0];
        expect(row.bytes).toBe(24576);                 // 从 raw.egress.bytesOut 挖到（value 顶层没有）
        expect(row.destHost).toBe('127.0.0.1:18790');  // 适配器下一跳（本地代理），诚实记、非真实 provider
        expect(row.tokens).toBe(300);                  // usage 仍由 extractUsage 从 raw.result.raw.usage 挖
        expect(row.bytesFound).toBe(true);
    });

    test('shadow 模式：记账但 bytes/tokens/destHost 均 null（不拿 0 冒充没出站）', async () => {
        const led = createEgressLedger();
        const orch = new Orchestrator({ shadowMode: true, egressLedger: led });
        const out = await orch.run(dag, {});
        expect(led.size()).toBe(3);                  // shadow 照记账
        const rows = led.getRows();
        for (const r of rows) {
            expect(r.client).toBeNull();             // shadow value 无 adapterId
            expect(r.destHost).toBeNull();
            expect(r.bytes).toBeNull();
            expect(r.tokens).toBeNull();
            expect(r.bytesFound).toBe(false);
        }
        const report = led.report();
        expect(report.bytesFound).toBe(0);
        expect(report.bytesMissing).toBe(3);
        expect(report.anomalousCount).toBe(0);       // 全 null → 无异常（不虚增判据）
    });
});

describe('egress-ledger · 路由 sidecar（/api/orchestration）', () => {
    let app;
    const build = () => {
        app = express();
        app.use(express.json());
        const r = require('../../routes/orchestration');
        r._resetForTest && r._resetForTest();
        app.use('/api/orchestration', r);
        return app;
    };

    beforeEach(() => {
        delete require.cache[require.resolve('../../routes/orchestration')];
    });
    afterEach(() => {
        delete process.env.PROXY_ORCHESTRATION;
        delete process.env[GATE];
    });

    test('egress 门控关（默认，但 orchestration 门控开）：GET /egress → 403', async () => {
        process.env.PROXY_ORCHESTRATION = '1';
        delete process.env[GATE];
        build();
        const res = await request(app).get('/api/orchestration/egress');
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('egress-ledger-gate-closed');
    });

    test('egress 门控开：GET /egress → 200（空报告）', async () => {
        process.env.PROXY_ORCHESTRATION = '1';
        process.env[GATE] = '1';
        build();
        const res = await request(app).get('/api/orchestration/egress');
        expect(res.status).toBe(200);
        expect(res.body.rowCount).toBe(0);
    });
});
