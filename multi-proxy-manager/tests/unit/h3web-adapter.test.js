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

    // ---- 档位透传（2026-10-01 补）：adapter 只透 {prompt}，导致下游永远吃默认档 512×512 ----
    describe('档位字段透传（白名单）', () => {
        test('默认只发 prompt，不夹带档位字段（防误覆盖 h3web 默认档）', async () => {
            const r = await adapter.submit({ type: 'generate-video', prompt: '一只猫' });
            expect(r.echo).toEqual({ prompt: '一只猫' });
            expect(mock.getLastGenPayload()).toEqual({ prompt: '一只猫' });
        });

        test('task 上的白名单字段真的到达下游 /api/gen', async () => {
            const r = await adapter.submit({
                type: 'generate-video',
                prompt: '竖屏成片',
                width: 768, height: 1344, steps: 20, seconds: 5,
            });
            const p = mock.getLastGenPayload();
            expect(p.prompt).toBe('竖屏成片');
            expect(p.width).toBe(768);
            expect(p.height).toBe(1344);
            expect(p.steps).toBe(20);
            expect(p.seconds).toBe(5);
            // echo 自证：调用方能看见自己传的档位真的发出去了
            expect(r.echo.width).toBe(768);
        });

        test('opts.genMode=draft 落到下游 gen_mode', async () => {
            const r = await adapter.submit({ type: 'generate-video', prompt: '草稿' }, { genMode: 'draft' });
            expect(mock.getLastGenPayload().gen_mode).toBe('draft');
            expect(r.echo.gen_mode).toBe('draft');
        });

        test('⚠️ 反证：白名单外的键（拼错的 size）不会静默透传 —— 否则会假成功回落 512×512', async () => {
            await adapter.submit({
                type: 'generate-video', prompt: '竖屏',
                size: [768, 1344],          // 拼错：h3web 认 width/height，不是 size
            });
            const p = mock.getLastGenPayload();
            expect(p.size).toBeUndefined();   // 没被透传 → 下游 build_args 不会假装收到 width
            expect(p.width).toBeUndefined();  // 且不会偷偷回落成默认值（那是另一种静默）
        });
    });
});
