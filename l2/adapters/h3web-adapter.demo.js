'use strict';

// h3web adapter 端到端样例（P0 增量 4 · 协议可行性验证，非侵入）
//
// 验证：adapter 协议契约在真实 HTTP round-trip 下成立。
// 下游 h3web 用 mock-h3web.js 替身（零依赖、零副作用、不起真 h3web、不触 Minimax 云端）。
// 真实"起 8731 h3web 服务 + 真文生视频"属 P1（h3web 未运行、云端费用、时长长）。
//
// 流程（与 adapter-protocol.md 四类接口逐一对应）：
//   ① 起 mock h3web（随机端口，模拟下游 agent）
//   ② 动态探测端口（adapter 不写死端口 → 用注入端口探测）
//   ③ 能力声明 → 经 Agent Registry 注册
//   ④ 健康检查
//   ⑤ 任务接收 + 结果回传（1 个文生视频 round-trip，轮询 pending→running→done）
//   ⑥ 收尾（关 mock，停 Registry）
const assert = require('assert');
const startMockH3web = require('../mock-h3web.js');
const { H3webAdapter } = require('./h3web-adapter.js');
const { AgentRegistry } = require('../agent-registry.js');

let n = 0;
const ok = (msg, a) => { assert(a, msg); n += 1; console.log(`PASS  ${msg}`); };
(async () => {
    // ① 起 mock h3web（随机端口）
    const mock = startMockH3web(0);
    await new Promise((r) => setTimeout(r, 50));
    const mockPort = mock.getPort();
    console.log(`mock h3web @ ${mockPort}（下游替身，零副作用）`);

    // ② adapter 动态探测端口（候选空 → fall back 到注入端口，绝不写死）
    const adapter = new H3webAdapter({ id: 'h3web', port: mockPort, portCandidates: [] });

    // ③ 能力声明 → 注册进 Agent Registry
    const decl = adapter.capabilitiesDeclaration();
    const registry = new AgentRegistry();
    registry.create({
        id: decl.adapter, name: adapter.name, type: 'custom',
        capabilityTags: decl.capabilities, version: decl.version, description: 'local h3web video agent',
    });
    ok('能力声明含 video 能力', decl.capabilities.includes('video'));
    ok('Registry 按能力查 video 命中 h3web', registry.byCapability('video').some((p) => p.id === 'h3web'));
    ok('Registry 按能力查 code 不命中 h3web', !registry.byCapability('code').some((p) => p.id === 'h3web'));

    // ④ 健康检查（GET 根路径 → 200）
    const h = await adapter.health();
    ok('health ok=true 锁定了 mock 端口', h.ok && h.port === mockPort);

    // ⑤ 任务接收 + 结果回传（1 个文生视频 round-trip：轮询到 done）
    const res = await adapter.run({ type: 'generate-video', prompt: '一只猫坐在窗台上看雨' });
    ok('round-trip 终态 done', res.status === 'done');
    ok('拿到 output 路径', typeof res.output === 'string' && res.output.startsWith('/outputs/'));

    // ⑥ 收尾
    await mock.close();
    console.log(`\n${n === 6 ? 'ALL PASS' : 'FAIL'}: ${n} checks — adapter 协议四类接口在 HTTP round-trip 下成立`);
    process.exit(0);
})().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
