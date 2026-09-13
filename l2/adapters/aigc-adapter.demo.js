'use strict';

// AIGC(hujing-ai) adapter 端到端样例（P0 增量 · 协议可行性验证，非侵入）
//
// 验证：Agent Adapter 协议契约在真实 HTTP round-trip 下对 AIGC 也成立——
// 且验证 AIGC 独有的两处：① OAuth2 Bearer 鉴权（缺失/错误 → 401）② 任务 cancel 语义。
// 下游 AIGC 用 mock-aigc.js 替身（零依赖、零副作用、不起真 AIGC、不触生图/生视频云端）。
// 真实"起 AIGC 服务 + 真文生视频 round-trip"属 P1（AIGC 未运行、需真实 token、需云端）。
//
// 流程（与 adapter-protocol.md 四类接口逐一对应，+ AIGC 独有 cancel）：
//   ① 起 mock AIGC（随机端口，模拟下游 FastAPI 服务）
//   ② 动态探测端口（adapter 不写死端口 → 用注入端口探测）
//   ③ 能力声明（7 subtype → 能力合集）→ 经 Agent Registry 注册
//   ④ 健康检查（GET /api/v1/health，AIGC 原生有）
//   ⑤ 鉴权校验：无 token → submit 报 401；正确 token → 通过
//   ⑥ 任务接收 + 结果回传（1 个文生图 round-trip，轮询 pending→processing→completed）
//   ⑦ cancel（AIGC 独有 + M7 session abort 支撑）
//   ⑧ 收尾
//
// 关键：token 仅 mock 的 fake token，demo 绝不打印 token 本身（只打印长度/通过与否）。

const assert = require('assert');
const startMockAigc = require('../mock-aigc.js');
const { AigcAdapter } = require('./aigc-adapter.js');
const { AgentRegistry } = require('../agent-registry.js');

let n = 0;
const ok = (msg, a) => { assert(a, msg); n += 1; console.log(`PASS  ${msg}`); };

(async () => {
     // ① 起 mock AIGC（随机端口）
    const mock = startMockAigc(0);
    await new Promise((r) => setTimeout(r, 50));
    const mockPort = mock.getPort();
    console.log(`mock AIGC @ ${mockPort}（下游替身，零副作用），fixture token 长度=${mock.token.length}`);

     // ②+③ 能力声明 → 注册进 Agent Registry（token 由调用方注入，绝不打印本体）
     const adapter = new AigcAdapter({ id: 'aigc', port: mockPort, portCandidates: [], token: mock.token });
    const decl = adapter.capabilitiesDeclaration();
    const registry = new AgentRegistry();
    registry.create({
        id: decl.adapter, name: adapter.name, type: 'custom',
        capabilityTags: decl.capabilities, version: decl.version, description: 'local 绘境 AI 生图生视频 agent',
    });
    ok('能力声明含 image 能力', decl.capabilities.includes('image'));
    ok('能力声明含 video 能力（image_to_video）', decl.capabilities.includes('video'));
    ok('声明 supportsCancel=true（AIGC 独有）', decl.supportsCancel === true);
    ok('Registry 按能力查 image 命中 aigc', registry.byCapability('image').some((p) => p.id === 'aigc'));
    ok('Registry 按能力查 code 不命中 aigc', !registry.byCapability('code').some((p) => p.id === 'aigc'));

     // ④ 健康检查（AIGC 原生 /api/v1/health）
    const h = await adapter.health();
    ok('health ok=true 锁定了 mock 端口', h.ok && h.port === mockPort);

     // ⑤ 鉴权校验：无 token 的 adapter → submit 应报 401（证明鉴权真在转发）
     const noauth = new AigcAdapter({ id: 'aigc-noauth', port: mockPort, portCandidates: [] });
    let threw401 = false;
    try {
        await noauth.submit({ subtype: 'text_to_image', params: { prompt: 'x' } });
    } catch (e) {
        threw401 = /401/.test(e.message);
    }
    ok('无 Bearer token 时 submit 报 401（鉴权生效）', threw401);

     // ⑥ 任务接收 + 结果回传（1 个文生图 round-trip：轮询到 completed）
    const res = await adapter.run({ subtype: 'text_to_image', params: { prompt: '一只猫坐在窗台上看雨', resolution: 'hd' } });
    ok('round-trip 终态 completed', res.status === 'completed');
    ok('拿到 result 路径', Array.isArray(res.result_images) && res.result_images[0].startsWith('/api/v1/files/'));

     // ⑦ cancel（AIGC 独有）：提交一个任务后取消
    const { task_id } = await adapter.submit({ subtype: 'image_to_video', params: { prompt: '猫走动', duration: 3 } });
    const c = await adapter.cancel(task_id);
    ok('cancel 返回 cancelled', c.task && c.task.status === 'cancelled');

     // ⑧ 收尾
    await mock.close();
    console.log(`\n${n === 10 ? 'ALL PASS' : 'FAIL'}: ${n} checks — AIGC 协议四类接口+鉴权+cancel 在 HTTP round-trip 下成立`);
    process.exit(0);
})().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
