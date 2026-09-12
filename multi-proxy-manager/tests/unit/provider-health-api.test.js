'use strict';

// M2 Provider Health API 测试 — 验证 /api/provider-health 端点：
// observe 模式（默认）下 listIsolated 返回建议隔离清单 + 跨 proxy 聚合 verdict。
// 通过 jest setup 重定向 provider-health 到 tmp，保证零污染。
const request = require('supertest');
const os = require('os');
const path = require('path');
const fs = require('fs');

describe('M2 Provider Health API', () => {
    let app;
    let healthFile;

    beforeEach(() => {
        healthFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-api-')), 'ph.json');
        app = require('../../server');
        const ph = require('../../lib/provider-health');
        ph.setHealthFile(healthFile);
        ph.resetProviderHealth();
     });

    afterAll(() => {
        try { fs.unlinkSync(healthFile); } catch (_) {}
     });

    test('GET /api/provider-health — 无隔离 provider 时返回空列表 + isolateEnabled=false', async () => {
        const res = await request(app).get('/api/provider-health');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.isolateEnabled).toBe(false); // 默认 observe
        expect(res.body.count).toBe(0);
        expect(Array.isArray(res.body.isolated)).toBe(true);
     });

    test('连续 3 次失败 → provider 出现在 isolated 清单', async () => {
        const ph = require('../../lib/provider-health');
        ph.setHealthFile(healthFile);
        ph.setHealthConfig({ failureThreshold: 3 });
        ph.recordProbe('agnes-2.5-flash', false, { source: 'codex', persist: true });
        ph.recordProbe('agnes-2.5-flash', false, { source: 'codex', persist: true });
        ph.recordProbe('agnes-2.5-flash', false, { source: 'codex', persist: true });

        const res = await request(app).get('/api/provider-health');
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        const item = res.body.isolated[0];
        expect(item.providerId).toBe('agnes-2.5-flash');
        expect(item.status).toBe('unhealthy');
        expect(item.correlation.verdict).toBe('single-proxy'); // 仅 codex 一个来源
     });

    test('跨 proxy 聚合：≥2 个 source 报同一 provider 失败 → network-wide', async () => {
        const ph = require('../../lib/provider-health');
        ph.setHealthFile(healthFile);
        ph.setHealthConfig({ failureThreshold: 3, crossProxyThreshold: 2 });
        ph.recordProbe('glm-5.3-flash', false, { source: 'codex', persist: true });
        ph.recordProbe('glm-5.3-flash', false, { source: 'hermes', persist: true });
        ph.recordProbe('glm-5.3-flash', false, { source: 'codex', persist: true });

        const res = await request(app).get('/api/provider-health');
        expect(res.body.count).toBe(1);
        expect(res.body.isolated[0].correlation.verdict).toBe('network-wide');
        expect(res.body.isolated[0].correlation.count).toBe(2);
     });

    test('GET /api/provider-health/:id — 未知 provider 返回 404', async () => {
        const res = await request(app).get('/api/provider-health/does-not-exist');
        expect(res.status).toBe(404);
        expect(res.body.ok).toBe(false);
     });

    test('GET /api/provider-health/:id — 已知 provider 返回健康记录 + 跨 proxy 聚合', async () => {
        const ph = require('../../lib/provider-health');
        ph.setHealthFile(healthFile);
        ph.recordProbe('agnes-2.5-flash', true, { source: 'manual', persist: true });

        const res = await request(app).get('/api/provider-health/agnes-2.5-flash');
        expect(res.status).toBe(200);
        expect(res.body.providerId).toBe('agnes-2.5-flash');
        expect(res.body.status).toBe('healthy');
        expect(res.body.correlation).toBeDefined();
     });
});
