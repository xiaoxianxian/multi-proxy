'use strict';

// h3web adapter 契约测试（jest）—— 协议四类接口在 HTTP round-trip 下成立。
// 下游用 mock-h3web.js 替身（零依赖、零副作用、不起真 h3web、不触云端）。
// 真实"起 8731 h3web + 真文生视频"属 P1，不在本测试内。
const request = require('supertest');
const startMockH3web = require('../../../l2/mock-h3web.js');
const { H3webAdapter } = require('../../../l2/adapters/h3web-adapter.js');
const { AgentRegistry } = require('../../../l2/agent-registry.js');

describe('h3web adapter contract', () => {
    let mock;
    let mockPort;
    let adapter;
    let registry;

    beforeAll(async () => {
        mock = startMockH3web(0);
        await new Promise((r) => setTimeout(r, 30));
        mockPort = mock.getPort();
        // 候选端口为空、注入 mockPort → 验证「端口动态探测，不写死」
        adapter = new H3webAdapter({ id: 'h3web', port: mockPort, portCandidates: [] });
        registry = new AgentRegistry();
     });

    afterAll(async () => {
        if (mock) await mock.close();
     });

     test('能力声明含 video/image 能力', () => {
        const decl = adapter.capabilitiesDeclaration();
        expect(decl.capabilities).toEqual(expect.arrayContaining(['video', 'image']));
        expect(decl.adapter).toBe('h3web');
        expect(decl.transport).toEqual(['http']);
     });

     test('健康检查锁住动态探测出的端口（不写死）', async () => {
        const h = await adapter.health();
        expect(h.ok).toBe(true);
        expect(h.port).toBe(mockPort);
     });

     test('能力声明 → 经 Registry 按能力路由命中', () => {
        const decl = adapter.capabilitiesDeclaration();
        registry.create({
            id: decl.adapter, name: adapter.name, type: 'custom',
            capabilityTags: decl.capabilities, version: decl.version,
            description: 'local h3web video agent',
         });
        expect(registry.byCapability('video').some((p) => p.id === 'h3web')).toBe(true);
        expect(registry.byCapability('code').some((p) => p.id === 'h3web')).toBe(false);
     });

     test('任务接收 + 结果回传：1 个文生视频 round-trip 到 done', async () => {
        const res = await adapter.run({ type: 'generate-video', prompt: '一只猫坐在窗台上看雨' });
        expect(res.status).toBe('done');
        expect(res.output).toMatch(/^\/outputs\//);
     });

     test('submit 缺 type 抛错', async () => {
        await expect(adapter.submit({})).rejects.toThrow();
     });
});
