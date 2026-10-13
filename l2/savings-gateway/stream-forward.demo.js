// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// SSE 透传执行器 Demo（2026-10-13 补）
// 用法：node l2/savings-gateway/stream-forward.demo.js
//
// 为什么单开一个 demo：18796 能不能接 dsh / Cursor 这类**流式客户端**，全看这条路径。
// 之前内核 JSON-only ⇒ stream:true 一律 501，现象是「连得上、一条都用不了」。
// 这里用一个**本机假上游**（真 http server，回真 SSE 字节）+ 假 res 收集写入，
// 全程 127.0.0.1、不碰外网、不依赖 18790 是否在跑 ⇒ 确定性可复现。
//
// 覆盖：流式字节真到达 / 头正确 / 上游 4xx 不写头 / 上游 5xx 判失败 /
//       上游不可达 / 上游给了 JSON 不是流 / 没给 res 时不假装成功。

const http = require('http');
const { createStreamForwardExecutor } = require('./gateway.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 假 res：只记录 writeHead / write / end，不真发字节
function fakeRes() {
    return {
        head: null, chunks: [], ended: false,
        writeHead(status, headers) { this.head = { status, headers }; },
        write(c) { this.chunks.push(Buffer.from(c)); return true; },
        end() { this.ended = true; },
        text() { return Buffer.concat(this.chunks).toString('utf8'); },
    };
}

function startFakeUpstream() {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let model = '';
            try { model = JSON.parse(body || '{}').model || ''; } catch { /* 留空 */ }
            // 坏 key：4xx JSON（不该写头、不该记上游不健康）
            if (model === 'bad-key') {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
                return;
            }
            // 上游自身故障
            if (model === 'boom') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end('{"error":"upstream exploded"}');
                return;
            }
            // 上游健康但**没给流**（比如被降级成 JSON）——同样不许当成成功
            if (model === 'json-only') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"choices":[{"message":{"content":"hi"}}]}');
                return;
            }
            // 正常 SSE
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
    });
}

async function demo() {
    console.log('=== Savings Gateway · SSE 透传 Demo（2026-10-13）===\n');
    const { server, base } = await startFakeUpstream();
    const exec = createStreamForwardExecutor(base);

    console.log('[1] 正常流式：字节真的 pipe 到客户端');
    const r1 = fakeRes();
    const s1 = await exec('agnes', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }, { auth: 'Bearer k' }, r1);
    check('返回 streamed', s1.status === 'streamed', JSON.stringify(s1));
    check('响应头 200 + event-stream', r1.head && r1.head.status === 200 && /text\/event-stream/i.test(r1.head.headers['Content-Type']), JSON.stringify(r1.head));
    check('关掉中间层缓冲（X-Accel-Buffering: no）', r1.head && r1.head.headers['X-Accel-Buffering'] === 'no');
    check('收到 3 个 SSE 事件（含 [DONE]）', (r1.text().match(/^data: /gm) || []).length === 3, r1.text());
    check('res 已 end', r1.ended === true);

    console.log('\n[2] 上游 4xx（坏 key）：不写头、不算上游不健康');
    const r2 = fakeRes();
    const s2 = await exec('agnes', { model: 'bad-key', messages: [{ role: 'user', content: 'hi' }] }, {}, r2);
    check('返回 client_error + 401', s2.status === 'client_error' && s2.statusCode === 401, JSON.stringify(s2));
    check('一个字节都没写给客户端（头都没写）', r2.head === null && r2.chunks.length === 0);

    console.log('\n[3] 上游 5xx：判 failed（只有这种才喂熔断）');
    const r3 = fakeRes();
    const s3 = await exec('agnes', { model: 'boom', messages: [{ role: 'user', content: 'hi' }] }, {}, r3);
    check('返回 failed', s3.status === 'failed', JSON.stringify(s3));

    console.log('\n[4] 上游给了 JSON 不是流：不许当成流成功');
    const r4 = fakeRes();
    const s4 = await exec('agnes', { model: 'json-only', messages: [{ role: 'user', content: 'hi' }] }, {}, r4);
    check('返回 failed（不是 streamed）', s4.status === 'failed', JSON.stringify(s4));
    check('没给客户端写流头', r4.head === null);

    console.log('\n[5] 上游不可达 / 没给可写 res');
    const dead = createStreamForwardExecutor('http://127.0.0.1:1');   // 1 号端口没人听
    const r5 = fakeRes();
    const s5 = await dead('agnes', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, {}, r5);
    check('上游不可达 → failed', s5.status === 'failed', JSON.stringify(s5));
    const s6 = await exec('agnes', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, {}, null);
    check('没给 res → unsupported（不假装成功）', s6.status === 'unsupported', JSON.stringify(s6));

    server.close();
    console.log(`\nPASS ${pass} / ${pass + fail}`);
    if (fail > 0) process.exit(1);
}

demo().catch((e) => { console.error('demo 崩了：', e); process.exit(1); });
