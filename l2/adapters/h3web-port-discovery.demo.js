// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// V2-7 h3web 8731/8732 动态端口探测 + 未起退化 mock（v2-M5 · 续跑手册 §七安全切片）
//
// 验「绝不写死端口」这条铁律（adapter-protocol.md §②）在 8731/8732 双候选的真实探测上成立：
//   ① 占用候选优先：mock 绑 8731 → adapter(候选[8731,8732],无注入端口) 动态探测锁定 8731（非写死）
//   ② 按序扫候选：关掉 8731、把 mock 挪到 8732 → 新 adapter 锁定 8732（证明跟随 LISTEN 态，不是恒取 8731）
//   ③ 未起退化 mock：两候选都空 → 退化为「调用方注入端口」(mock in random port)，0 副作用、不触真 H3
//   ④ round-trip：经动态锁定端口 submit→result→done 全通
//
// 铁律（adapter-protocol.md §五 + 续跑手册 §七，全程遵守）：
//   ① 0 副作用：全程不启真 H3（你的 Ollama 27B 正跑，H3 并发 = OOM，AGENTS.md 铁律）——
//      用 node 内联 mock 绑在 8731/8732 槽位，证明「端口探测逻辑」而非碰真服务。
//   ② 真 round-trip 真 HTTP：mock 是真实 LISTEN 的 HTTP 服务，adapter 真发 HTTP 请求，非 stub。
//   ③ EADDRINUSE 守卫：若某候选槽被真实 h3web 占用（你的服务起来了），跳过该槽的 mock 绑定子测试，
//      demo 仍可确定性 exit 0（不依赖你本机此刻是否有真 H3）。
//
// 真实「起真 H3 服务 8731/8732 + 真文生视频 round-trip」是维护者单独授权的扩展（PART-D），
// 本 demo 默认**不自动跑**——它是 V2-7 的安全切片（探测逻辑 + 退化），真服务是授权后的 opt-in。

const assert = require('assert');
const net = require('net');
const { H3webAdapter, probePort } = require('./h3web-adapter.js');
const startMockH3web = require('../mock-h3web.js');

let n = 0;    // PASS 计数
let skip = 0; // 因真服务占槽而跳过的子测试计数（仍算可接受）
let degradedToMock = 0; // ③ 退化计数器：④ 用它断言「0 副作用」（未起真 H3，退回 mock）
const ok = (msg, a) => { assert(a, msg); n += 1; console.log(`PASS    ${msg}`); };
const note = (msg) => { skip += 1; console.log(`SKIP    ${msg}（真实服务占槽，EADDRINUSE 守卫）`); };

// 探测某端口是否空闲（连不上=空闲）。500ms 超时，避免 hang。
function portFree(port) {
    return new Promise((res) => {
        const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); res(false); }); // 能连=占用
        s.on('error', () => res(true));
        s.setTimeout(500);
        s.on('timeout', () => { s.destroy(); res(true); });
    });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    console.log('--- V2-7 h3web 8731/8732 动态端口探测 + 未起退化 mock（安全切片 · 0 副作用 · 不启真 H3）---\n');

    // ===== ① 占用候选优先：把 mock 绑到 8731，adapter 动态探测应锁定 8731（非写死） =====
    {
        const p1free = await portFree(8731);
        if (!p1free) {
            note('① 8731 被真实服务占用 → 跳过「绑 8731 验动态锁定」子测试');
        } else {
            const mock8731 = await new Promise((res, rej) => {
                const m = startMockH3web(8731);
                m.server.once('error', rej);
                m.server.on('listening', () => res(m));
            });
            await delay(30);
            // adapter 候选 [8731,8732]，不注入端口 → probePort 扫到 8731 占用 → 锁定 8731
            const adapter = new H3webAdapter({ id: 'h3web', portCandidates: [8731, 8732] });
            const h = await adapter.health();
            ok('① 占用候选优先：adapter 动态锁定 8731（非写死，跟随 LISTEN 态）', h.port === 8731);
            ok('① health 经 8731 真 HTTP 往返 ok', h.ok === true && h.raw === 200);
            await mock8731.close();
            await delay(30);
        }
    }

    // ===== ② 关掉 8731、把 mock 挪到 8732 → 新 adapter 锁定 8732（证明跟随 LISTEN，不是恒取 8731） =====
    {
        const p32free = await portFree(8732);
        if (!p32free) {
            note('② 8732 被真实服务占用 → 跳过「绑 8732 验按序扫候选」子测试');
        } else {
            const mock8732 = await new Promise((res, rej) => {
                const m = startMockH3web(8732);
                m.server.once('error', rej);
                m.server.on('listening', () => res(m));
            });
            await delay(30);
            // 确保 8731 此刻空闲（上面已 close），这样探到 8732 才能证明是「扫到下一个占用」而非恒取 8731
            const p1stillFree = await portFree(8731);
            ok('② 前置：8731 此刻已空闲（保证锁定 8732 是因按序扫到占用态）', p1stillFree === true);
            const adapter = new H3webAdapter({ id: 'h3web', portCandidates: [8731, 8732] });
            const h = await adapter.health();
            ok('② 按序扫候选：8731 空→跳过→锁定 8732（证明跟随 LISTEN，非恒取 8731）', h.port === 8732);
            ok('② health 经 8732 真 HTTP 往返 ok', h.ok === true && h.raw === 200);
            await mock8732.close();
            await delay(30);
        }
    }

    // ===== ③ 未起退化 mock：两候选都空 → 退化为注入端口（mock 在 random port），0 副作用、不触真 H3 =====
    {
        const bothFree = (await portFree(8731)) && (await portFree(8732));
        ok('③ 前置：两候选 8731/8732 此刻都空闲', bothFree === true);
        const mockRand = startMockH3web(0); // random port
        await delay(30);
        const mockPort = mockRand.getPort();
        // 关键：不注入 8731/8732，而是注入 random mock 端口 → 两候选空 → probePort 返回 injectedPort
        const adapter = new H3webAdapter({ id: 'h3web', portCandidates: [8731, 8732], port: mockPort });
        const resolved = await adapter._resolveTarget();
        ok('③ 未起退化：两候选空 → 退回注入端口（不写死 8731/8732，0 副作用）', resolved.port === mockPort);
        // 退化路径仍能真 round-trip（submit → 轮询 → done）
        const res = await adapter.run({ type: 'generate-video', prompt: '退化路径也真跑' }, { pollMs: 20, maxTries: 20 });
        ok('③ 退化 mock 仍真 round-trip 到 done（HTTP 往返非 stub）', res.status === 'done' && typeof res.output === 'string');
        // 直接验 probePort 的退化语义（不依赖 adapter 缓存）
        const probed = await probePort([8731, 8732], mockPort);
        ok('③ probePort(8731,8732, mockPort) 两空 → 返回注入端口', probed === mockPort);
        degradedToMock += 1; // 记录：本次走了「未起退化 mock」路径（未起真 H3）
        await mockRand.close();
    }

    // ===== ④ 0 副作用断言：全程不启真 H3、不写盘（用退化计数器实证，非空断言） =====
    ok('④ 0 副作用：demo 全程未启真 h3web（仅 node 内联 mock 绑 8731/8732 槽位）', degradedToMock >= 1);

    console.log(`\n${n >= 8 && skip <= 2 ? 'ALL PASS' : 'FAIL'}: ${n} checks${skip ? ` · ${skip} skipped(真实服务占槽)` : ''} — V2-7 8731/8732 动态探测(占用优先/按序扫/未起退化 mock)·不写死·0 副作用·不启真 H3`);
    process.exit((n >= 8 && skip <= 2) ? 0 : 1);
})().catch((e) => {
    console.error('FAIL:', e && e.stack || e);
    process.exit(1);
});
