// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * L004 回归测试：客户端断开 ⇒ 上游一起停（codex-proxy /v1/messages）
 *
 * 这个仓库早先的测试（proxy.test.js / stream-bypass.test.js）都是**自己再实现一份
 * 逻辑**再断言那份实现，proxy.js 一行没改测试也还是绿的。L004 就是被这种测试放过去的：
 * 实测「客户端 5 秒走、上游跑满 120 秒」时，没有任何一个测试真的 require 过 proxy.js。
 *
 * 所以这一份直接 require 真 app，并且**起真实 TCP 连接**（不发 supertest 的 thenable，
 * 因为 supertest 一 await 就发完了，没法在半路把客户端掐了）。链路是：
 *   真 socket → express app → 真 createUpstreamSignal → 被劫持的 fetch（记录 signal）
 * 断言点只有一条：客户端 destroy 之后，那份传给上游的 signal 必须已经 aborted。
 */

// 沙箱 node 22.22.2 下 require 真 proxy.js（express 依赖链）单例可 30s+，
// L004 端到端用例起真 TCP + AbortSignal 时序，全量并行时 CPU 争抢更慢。
jest.setTimeout(120000);

const http = require('http');
const { EventEmitter } = require('events');
const { ReadableStream } = require('stream/web');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. createUpstreamSignal 单元行为 ----------
// req / res 都是最小替身，只保留 proxy.js 真正依赖的几个属性
function fakeReq() {
  const e = new EventEmitter();
  e.complete = true;   // 请求体完整收完（客户端没走）
  e.destroyed = false;
  return e;
}
function fakeRes(writableEnded = false) {
  const e = new EventEmitter();
  e.writableEnded = writableEnded;
  return e;
}

describe('createUpstreamSignal', () => {
  const { createUpstreamSignal } = require('../proxy.js');

  test('客户端 aborted ⇒ signal 立刻 abort，reason 是人能读的 client aborted', () => {
    const req = fakeReq(), res = fakeRes();
    const signal = createUpstreamSignal(req, res, 60000);
    expect(signal.aborted).toBe(false);
    req.emit('aborted');
    expect(signal.aborted).toBe(true);
    expect(String(signal.reason && signal.reason.message)).toBe('client aborted');
  });

  test('req 没读完就关（destroyed）也算客户端走', () => {
    const req = fakeReq(), res = fakeRes();
    const signal = createUpstreamSignal(req, res, 60000);
    req.complete = false;
    req.emit('close');
    expect(signal.aborted).toBe(true);
  });

  test('res 先关（客户端拔了）也 abort', () => {
    const req = fakeReq(), res = fakeRes();
    const signal = createUpstreamSignal(req, res, 60000);
    res.emit('close'); // writableEnded=false ⇒ 是我们还没写完就被关
    expect(signal.aborted).toBe(true);
  });

  test('正常写完了才 close ⇒ 不能误伤上游（这里 L004 修之前会每笔请求都掐断）', () => {
    const req = fakeReq(), res = fakeRes(true); // writableEnded=true
    const signal = createUpstreamSignal(req, res, 60000);
    res.emit('close');
    req.emit('close');
    expect(signal.aborted).toBe(false);
  });

  test('超时兜底：还没走就到点，abort 且 reason 是 upstream timeout', async () => {
    const req = fakeReq(), res = fakeRes();
    const signal = createUpstreamSignal(req, res, 30);
    await sleep(120);
    expect(signal.aborted).toBe(true);
    expect(String(signal.reason && signal.reason.message)).toBe('upstream timeout');
  });
});

// ---------- 2. canWrite：客户端走了别往死 socket 上写 ----------
describe('canWrite', () => {
  const { canWrite } = require('../proxy.js');

  test('全新 res 可写 / destroyed 与 headersSent 都不可写', () => {
    expect(canWrite({ destroyed: false, headersSent: false })).toBe(true);
    expect(canWrite({ destroyed: true, headersSent: false })).toBe(false);
    expect(canWrite({ destroyed: false, headersSent: true })).toBe(false);
    expect(canWrite(null)).toBe(false);
  });
});

// ---------- 3. 端到端：真 socket → 真 app → 上游 signal ----------
describe('L004 端到端：客户端拔线后上游不再空跑', () => {
  const { app } = require('../proxy.js');
  let server, port, realFetch;

  // 上游替身：返回一条挂住不关的 SSE 流（模拟长任务），并记录 Proxy 就拿到的 signal
  let signals = [];
  function mockUpstream(hold = true) {
    signals = [];
    realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      signals.push(opts && opts.signal);
      if (process.env.DBG) console.log('[DBG] fetch', String(url), 'hasSignal=', !!(opts && opts.signal));
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: chunk-1\n\n'));
          if (!hold) c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  }
  // 拿到**第一个字节**就算「响应已经流起来了」。
  // 不能等 res 'end'：客户端拔线后服务端那半截响应永远不会 end，等它＝测试超时 20 秒。
  function postMessages(cb, waitEnd = false) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
          headers: { 'content-type': 'application/json' } },
        (res) => {
          res.once('data', () => { if (!waitEnd) resolve('first-byte'); });
          res.on('end', () => resolve('end'));
          res.resume();
        }
      );
      req.on('error', (e) => {
        // 客户端 destroy 的「socket hang up」是预期副作用，不算真错误
        if (e && e.code === 'ECONNRESET' || (e && e.message === 'socket hang up')) {
          if (!waitEnd) resolve('client-gone');
          else reject(e);
          return;
        }
        reject(e);
      });
      req.end(JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] }));
      if (typeof cb === 'function') cb(req);
    });
  }

  beforeAll(() => new Promise((resolve) => {
    process.env.PROXY_AUTH_TOKEN = ''; // 关鉴权，免得四个环境变量
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  }));
  afterAll(() => { global.fetch = realFetch; server.close(); });

  test('客户端中途 destroy ⇒ 那份上游 signal 被 abort', async () => {
    mockUpstream(true); // 上游永远不结束

    let closed = false;
    let destroyed = false;
    const started = postMessages((req) => {
      setTimeout(() => {
        destroyed = true;
        req.destroy(); // 客户端 5 秒走（这里 300ms）
        closed = true;
      }, 300);
    });
    started.catch(() => {}); // 别让它吊着

    await started;   // 响应已经在流了
    await sleep(700); // 等 destroy 生效 + signal 传播
    expect(closed).toBe(true);
    expect(destroyed).toBe(true);
    const seen = signals.filter(Boolean); // 成本上报那次 fetch 不带 signal，不算
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(true);
    expect(String(seen[0].reason && seen[0].reason.message)).toBe('client aborted');
  });

  test('客户端一直等到完 ⇒ signal 不 abort，账照报', async () => {
    mockUpstream(false); // 上游一次性给完

    await postMessages(null, true); // 这一轮等响应真走完再断言，别卡在首字节
    const seen = signals.filter(Boolean);
    console.log('[DBG] seen=', seen.length, 'allRaw=', signals.map(x => x ? x.aborted : 'none'));
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(false);
  });
});
