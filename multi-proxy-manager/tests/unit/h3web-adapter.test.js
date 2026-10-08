// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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

        test('opts.perf=true 一键塞省时参数，且不改写尺寸（final 档专用）', async () => {
            const r = await adapter.submit(
                { type: 'generate-video', prompt: '竖屏成片', width: 512, height: 896, steps: 20 },
                { perf: true },
            );
            const p = mock.getLastGenPayload();
            // 预设四件套都到了下游
            expect(p.layers).toBe(40);
            expect(p.reuse).toBe(2);
            expect(p.token_reduction).toBe(true);
            expect(p.ssd_streaming).toBe(true);
            // 关键：走 final 档，调用方指定的尺寸原样保留（draft 会把宽高压成 384×672）
            expect(p.width).toBe(512);
            expect(p.height).toBe(896);
            expect(p.gen_mode).toBeUndefined();
            expect(r.echo.layers).toBe(40);
            expect(r.echo.width).toBe(512);
        });

        test('opts.perf 不覆盖 task 显式给的同名 key（显式值优先）', async () => {
            await adapter.submit(
                { type: 'generate-video', prompt: 'x', layers: 32, reuse: 1 },
                { perf: true },
            );
            const p = mock.getLastGenPayload();
            expect(p.layers).toBe(32);   // task 显式值胜出，预设不许悄悄改
            expect(p.reuse).toBe(1);
            expect(p.token_reduction).toBe(true);  // 没显式给的照补
        });

        test('opts.perf={layers:24} 只做微调，其余仍取预设', async () => {
            await adapter.submit({ type: 'generate-video', prompt: 'x' }, { perf: { layers: 24 } });
            const p = mock.getLastGenPayload();
            expect(p.layers).toBe(24);
            expect(p.reuse).toBe(2);
            expect(p.token_reduction).toBe(true);
            expect(p.ssd_streaming).toBe(true);
        });

        test('opts.perf 与 opts.genMode 同时给时互不影响（perf 保参数、draft 只管标志）', async () => {
            await adapter.submit({ type: 'generate-video', prompt: 'x' }, { perf: true, genMode: 'draft' });
            const p = mock.getLastGenPayload();
            expect(p.gen_mode).toBe('draft');
            expect(p.layers).toBe(40);
            expect(p.reuse).toBe(2);
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

    // ---- 多镜头故事板（2026-10-02 补，走 POST /api/storyboard）----
    describe('多镜头故事板（submitStoryboard）', () => {
        const shots = () => [
            { prompt: '第一镜：猫在窗台醒来', width: 512, height: 896, steps: 16 },
            { prompt: '第二镜：猫跳上书桌', width: 512, height: 896, steps: 16 },
        ];

        test('shots 逐镜的档位真的到达下游 /api/storyboard', async () => {
            const r = await adapter.submitStoryboard(shots());
            const s = mock.getLastStoryboardPayload().shots;
            expect(s).toHaveLength(2);
            expect(s[0].prompt).toBe('第一镜：猫在窗台醒来');
            expect(s[0].width).toBe(512);
            expect(s[0].height).toBe(896);
            expect(s[1].prompt).toBe('第二镜：猫跳上书桌');
            // echo 可自证：调用方拿得到逐镜真正发出去的 payload
            expect(r.echo.shots[0].height).toBe(896);
            expect(r.task_id).toBeTruthy();
        });

        test('opts.perf 逐镜补位，且显式给的 key 不被覆盖', async () => {
            await adapter.submitStoryboard(
                [{ prompt: 'A', layers: 45 }, { prompt: 'B' }],
                { perf: true },
            );
            const s = mock.getLastStoryboardPayload().shots;
            expect(s[0].layers).toBe(45);        // 显式胜出
            expect(s[0].reuse).toBe(2);          // 没给的照补
            expect(s[1].layers).toBe(40);
            expect(s[1].token_reduction).toBe(true);
            // 故事板走 final 档语义：不落 gen_mode，尺寸不被 draft 强转
            expect(s[1].gen_mode).toBeUndefined();
        });

        test('opts.resumeJob 落到下游 resume_job（断点续跑用）', async () => {
            await adapter.submitStoryboard(shots(), { resumeJob: 'job_1790876828830' });
            expect(mock.getLastStoryboardPayload().resume_job).toBe('job_1790876828830');
        });

        test('opts.chain=false 逐镜落到下游 chain:false（关链上镜→多镜耗时恒定，手册 §6.1）', async () => {
            const r = await adapter.submitStoryboard(shots(), { chain: false });
            const s = mock.getLastStoryboardPayload().shots;
            expect(s[0].chain).toBe(false);
            expect(s[1].chain).toBe(false);
            expect(r.echo.shots[0].chain).toBe(false); // echo 同样可自证
        });

        test('opts.chain=true 逐镜落到下游 chain:true', async () => {
            const r = await adapter.submitStoryboard(shots(), { chain: true });
            const s = mock.getLastStoryboardPayload().shots;
            expect(s[0].chain).toBe(true);
            expect(s[1].chain).toBe(true);
        });

        test('⚠️ 反证：不传 opts.chain 时下游不带 chain 键 —— 沿用 h3web 默认 true，不偷偷改默认行为', async () => {
            await adapter.submitStoryboard(shots());
            const s = mock.getLastStoryboardPayload().shots;
            expect(s[0].chain).toBeUndefined();
            expect(s[1].chain).toBeUndefined();
        });

        test('⚠️ 反证：shots 为空立刻抛错，不下发', async () => {
            await expect(adapter.submitStoryboard([])).rejects.toThrow(/非空/);
            await expect(adapter.submitStoryboard(null)).rejects.toThrow(/非空/);
        });

        test('⚠️ 反证：某镜缺 prompt 在 adapter 层就拒 —— 否则下发后跑到第 N 镜才炸', async () => {
            mock.resetLastStoryboard();   // 清掉上一次记录，否则「没下发」会被旧 payload 干扰
            await expect(adapter.submitStoryboard(
                [{ prompt: 'A' }, { prompt: '' }, { prompt: 'C' }],
            )).rejects.toThrow(/prompt 必填/);
            expect(mock.getLastStoryboardPayload()).toBeNull();
        });

        test('⚠️ 反证：某镜 reuse 与 core_reuse 同时传 → 提交前拒 —— 否则引擎退出码 1 秒退', async () => {
            mock.resetLastStoryboard();
            await expect(adapter.submitStoryboard(
                [{ prompt: 'A', reuse: 3 }, { prompt: 'B', reuse: 3, core_reuse: 6 }],
            )).rejects.toThrow(/不能同时传/);
            expect(mock.getLastStoryboardPayload()).toBeNull(); // 一镜错、整单不下发
        });

        test('只给 reuse 或只给 core_reuse 不误伤（二者本就互斥，单给合法）', async () => {
            await expect(adapter.submit(
                { type: 'generate-video', prompt: 'A', reuse: 3 },
            )).resolves.toBeTruthy();
            await expect(adapter.submit(
                { type: 'generate-video', prompt: 'A', core_reuse: 6 },
            )).resolves.toBeTruthy();
        });
    });

    describe('reuse / core_reuse 互斥（h3gen 层限制，本 adapter 提前 fail-fast）', () => {
        // 2026-10-02 真跑坑：同时传 → h3gen 直接退出码 1，
        // 但 /api/gen 照样 200 返回 job_id，只有 job log / "{产物}.engine.log" 首行写着
        // "h3: core reuse and denoiser reuse cannot be combined"。h3web.py 只各自校验取值
        // 枚举（reuse 1/2/3 → :1634-1638；core_reuse 1/4/6 → :1645-1650），组合放行走引擎。
        test('submit 同时给 reuse 与 core_reuse → 立即抛错，不发请求', async () => {
            await expect(adapter.submit({
                type: 'generate-video', prompt: 'A', reuse: 3, core_reuse: 6,
            })).rejects.toThrow(/不能同时传/);
        });

        test('perf 预设不会自己引入 core_reuse（预设只有 reuse，不会撞上显式值）', async () => {
            const r = await adapter.submit(
                { type: 'generate-video', prompt: 'A', width: 512, height: 896 },
                { perf: true },
            );
            expect(r.echo.reuse).toBe(2);
            expect(r.echo.core_reuse).toBeUndefined();
        });
    });
});
