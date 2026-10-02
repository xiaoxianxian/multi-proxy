'use strict';
// token-policy-bridge 的保护网（28 号文档 §八 · apply() 接进真实转发链路）。
//
// 三条最要紧的断言：
//   ① observe 模式转发到上游的包逐字节未变 —— 零行为改变是敢长期挂着的底线
//   ② rewrite 模式 handler 输出真的写进上游请求 —— 否则接了等于没接
//   ③ 改写只认白名单字段 —— 未知字段写进上游等于赌 provider 容忍度

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
process.env.BRIDGE_LOG_DIR = LOG_DIR;
process.env.BRIDGE_AGENT_TYPE = 'coding';

const CHAT = {
  model: 'demo-model',
  messages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ],
  tools: [{ type: 'function', function: { name: 'mcp__heavy__search' } }],
};

const RESP = {
  model: 'demo-model',
  instructions: '你是一个助手',
  input: [
    { role: 'user', content: 'r1' },
    { role: 'assistant', content: 'r2' },
    { role: 'user', content: 'r3' },
    { role: 'assistant', content: 'r4' },
    { role: 'user', content: 'r5' },
  ],
};

function post(port, urlPath, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// echo 上游：原样回显收到的 body，用来断言「转发前包长什么样」。
// 请求体带 stream:true 时改回 SSE，用来断言桥是分块透传而不是攒成整块。
function startEcho() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const c = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => {
        const raw = Buffer.concat(c).toString();
        let body = {};
        try { body = JSON.parse(raw); } catch { /* 非 JSON 按普通回显 */ }
        if (body && body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const parts = [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A"}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"B"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":456,"output_tokens":9}}}\n\n',
          ];
          let i = 0;
          const tick = () => {
            if (i < parts.length) { res.write(parts[i++]); setTimeout(tick, 60); }
            else { res.end(); }
          };
          tick();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echo: raw, usage: { prompt_tokens: 123, completion_tokens: 7 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

let B, TP, echo, bridge, bport;

beforeAll(async () => {
  // UPSTREAM 是 bridge 加载时读的常量，必须在 require 之前定端口
  echo = await startEcho();
  process.env.UPSTREAM = `http://127.0.0.1:${echo.address().port}`;
  B = require('../../../tools/token-policy-bridge.js');
  TP = require('../../../l2/token-policy.js');
  TP.registerPolicy({
    hook: 'onRequestAssemble',
    name: '__test_prune',
    enabled: true,
    priority: 100, // 保证是 results[0]，rewrite 取的就是它
    handler(ctx) {
      const before = JSON.stringify(ctx.messages).length;
      const kept = ctx.messages.length > 2 ? ctx.messages.slice(-2) : ctx.messages;
      return { messages: kept, netTokenDelta: JSON.stringify(kept).length - before };
    },
  });
  bridge = B.server;
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  bport = bridge.address().port;
});

afterAll(() => {
  if (bridge) bridge.close();
  if (echo) echo.close();
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
});

describe('协议归一 ctxFromRequest', () => {
  test('chat/completions：system 剥离、history = 非 system 数 - 1', () => {
    const c = B.ctxFromRequest(CHAT, 'chat-completions');
    expect(c.messages).toHaveLength(5);
    expect(c.history).toHaveLength(4);
    expect(c.systemPrompt).toBe('SYS');
    expect(c.tools).toHaveLength(1);
  });

  test('responses：instructions → systemPrompt，input 数组归一', () => {
    const c = B.ctxFromRequest({ model: 'm', instructions: 'SYS', input: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] }, 'responses');
    expect(c.systemPrompt).toBe('SYS');
    expect(c.messages).toHaveLength(2);
    expect(c.history).toHaveLength(1);
  });

  test('responses：input 为字符串时归一成单条 user', () => {
    const c = B.ctxFromRequest({ input: '单轮' }, 'responses');
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].role).toBe('user');
  });

  test('agentType 必填——token-policy 在缺它时是静默跳过，这里必须给全', () => {
    const c = B.ctxFromRequest(CHAT, 'chat-completions');
    expect(c.agentType).toBeTruthy();
    expect(TP.AGENT_TYPES).toContain(c.agentType);
  });
});

describe('改写合并 mergeOutToRequest', () => {
  test('白名单外字段被忽略，绝不写进上游请求', () => {
    const m = B.mergeOutToRequest(CHAT, { messages: [{ role: 'user', content: 'x' }], evil: 1, netTokenDelta: -3 }, 'chat-completions');
    expect(m.ignored).toEqual(['evil']);
    expect(m.changed).toBe(true);
    expect(m.body.evil).toBeUndefined();
  });

  test('history 写回不吞掉当前这轮输入（最危险的坑）', () => {
    const m = B.mergeOutToRequest(CHAT, { history: [{ role: 'user', content: 'kept' }] }, 'chat-completions');
    const last = m.body.messages[m.body.messages.length - 1];
    expect(last.content).toBe('u3');
    expect(m.body.messages[1].content).toBe('kept');
  });

  test('systemPrompt 替换后只保留一个 system', () => {
    const m = B.mergeOutToRequest(CHAT, { systemPrompt: 'NEW' }, 'chat-completions');
    expect(m.body.messages[0].content).toBe('NEW');
    expect(m.body.messages.filter((x) => x.role === 'system')).toHaveLength(1);
  });

  test('无输出时不产生任何改动（changed=false）', () => {
    const m = B.mergeOutToRequest(CHAT, null, 'chat-completions');
    expect(m.changed).toBe(false);
    expect(m.body).toBe(CHAT);
  });
});

describe('端到端转发对照', () => {
  test('observe：上游收到的包逐字节等于原包（零行为改变）', async () => {
    process.env.BRIDGE_MODE = 'observe';
    const r = await post(bport, '/v1/chat/completions', CHAT);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).echo).toBe(JSON.stringify(CHAT));
  });

  test('rewrite：上游收到的包真的被改写了', async () => {
    process.env.BRIDGE_MODE = 'rewrite';
    const r = await post(bport, '/v1/chat/completions', CHAT);
    const up = JSON.parse(JSON.parse(r.text).echo);
    expect(JSON.stringify(up)).not.toBe(JSON.stringify(CHAT));
    expect(up.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(up.messages).toHaveLength(3);
    expect(up.messages[2].content).toBe('u3');
  });

  test('responses 协议（codex 主力链路）· observe 原样转发', async () => {
    process.env.BRIDGE_MODE = 'observe';
    const r = await post(bport, '/v1/responses', RESP);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).echo).toBe(JSON.stringify(RESP));
  });

  test('responses 协议 · rewrite 裁剪 input、instructions 不受影响', async () => {
    process.env.BRIDGE_MODE = 'rewrite';
    const r = await post(bport, '/v1/responses', RESP);
    const up = JSON.parse(JSON.parse(r.text).echo);
    expect(up.input).toHaveLength(2);
    expect(up.input[1].content).toBe('r5');
    expect(up.instructions).toBe('你是一个助手');
  });

  test('度量落盘：七类组成 + policy 净增量 + 上游实测 usage', async () => {
    const f = fs.readdirSync(LOG_DIR).find((x) => x.endsWith('.jsonl'));
    const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').trim().split('\n').map(JSON.parse);
    const rw = lines.find((l) => l.mode === 'rewrite' && l.api === 'chat-completions');
    const ob = lines.find((l) => l.mode === 'observe' && l.api === 'chat-completions');
    expect(rw).toBeTruthy();
    expect(ob).toBeTruthy();
    expect(ob.estTotal).toBeGreaterThan(0);
    expect(ob.byCategory.tools).toBeGreaterThan(0);
    expect(rw.reported).toBe(1);
    expect(rw.estSaved).toBeLessThan(0);
    expect(rw.rewrote).toBe(true);
    expect(ob.actualPromptTokens).toBe(123);
  });

  test('responses 也能测到七类组成（折叠前必须归一，否则恒为 0）', async () => {
    const f = fs.readdirSync(LOG_DIR).find((x) => x.endsWith('.jsonl'));
    const lines = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').trim().split('\n').map(JSON.parse);
    const rs = lines.find((l) => l.api === 'responses');
    expect(rs).toBeTruthy();
    // 修复前这里是 0——fold 只认 messages，responses 的 input 直接喂就是全 0
    expect(rs.estTotal).toBeGreaterThan(0);
  });
});

// 流式：codex 走 SSE，桥若把流攒成整块再吐，客户端会卡到超时。
// 「内容对」不足以证明这件事，必须断言分块到达，所以单独一组。
// 复用同一个 bridge 实例——UPSTREAM 是模块加载时常量，新建实例改 env 无效。
describe('token-policy-bridge · 流式透传', () => {
  test('joinUrl：上游带 /v1 且路径也带 /v1 时不得拼成 /v1/v1（否则全 404）', () => {
    expect(B.joinUrl('https://x.cn/v1', '/v1/responses')).toBe('https://x.cn/v1/responses');
    expect(B.joinUrl('https://x.cn/v1/', '/v1/responses')).toBe('https://x.cn/v1/responses');
    expect(B.joinUrl('https://x.cn', '/v1/responses')).toBe('https://x.cn/v1/responses');
    expect(B.joinUrl('https://x.cn/v1', '/responses')).toBe('https://x.cn/v1/responses');
    expect(B.joinUrl('https://x.cn/v2', '/v2/chat/completions')).toBe('https://x.cn/v2/chat/completions');
    // 别的路径前缀不该被误伤
    expect(B.joinUrl('https://x.cn/v1', '/models')).toBe('https://x.cn/v1/models');
  });

  test('extractUsageFromSSE：responses 与 chat 两种形状都能抽', () => {
    expect(B.extractUsageFromSSE('event: response.completed\ndata: {"response":{"usage":{"input_tokens":456,"output_tokens":9}}}\n\n'))
      .toEqual({ prompt_tokens: 456, completion_tokens: 9, hit: null, miss: null });
    expect(B.extractUsageFromSSE('data: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\ndata: [DONE]\n\n'))
      .toEqual({ prompt_tokens: 11, completion_tokens: 2, hit: null, miss: null });
  });

  test('extractUsageFromSSE：cache hit/miss 也要抽得出来（k 自测的输入）', () => {
    // codex 全走流式，usage 只在最后一个事件里；hit/miss 抽不到 →
    // observeSample 直接 return → 裁剪模式永远停在未标定的默认值上，rewrite 亏不亏就成了猜的。
    const r = B.extractUsageFromSSE('data: {"usage":{"prompt_tokens":456,"completion_tokens":9,'
      + '"prompt_cache_hit_tokens":100,"prompt_cache_miss_tokens":356}}\n\n');
    expect(r.hit).toBe(100);
    expect(r.miss).toBe(356);
    expect(r.prompt_tokens).toBe(456);
  });

  test('extractUsageFromSSE：.provider 只在 prompt_tokens_details 里给 cache 数时也能抽', () => {
    const r = B.extractUsageFromSSE('data: {"usage":{"prompt_tokens":500,"prompt_tokens_details":{"cached_tokens":80}}}\n\n');
    expect(r.hit).toBe(80);
    expect(r.miss).toBeNull(); // 抽不到是 null，不是 0
  });

  test('extractUsageFromSSE：抽不到返回 null，不填 0（0 会被读成「确实没用」）', () => {
    expect(B.extractUsageFromSSE('data: {"nope":1}\n\n')).toBeNull();
    expect(B.extractUsageFromSSE('')).toBeNull();
    expect(B.extractUsageFromSSE(null)).toBeNull();
  });

  test('pickRequestHeaders：放行鉴权/OpenAI 系/x- 头，剔除 hop-by-hop 与无关头', () => {
    const h = B.pickRequestHeaders({
      Authorization: 'Bearer sk-x', 'OpenAI-Organization': 'org-1', 'X-Title': 'codex',
      Host: 'upstream.example', 'Content-Length': '12', Connection: 'keep-alive', Cookie: 'nope',
    });
    expect(h.Authorization).toBe('Bearer sk-x');
    expect(h['OpenAI-Organization']).toBe('org-1');
    expect(h['X-Title']).toBe('codex');
    expect(h.Host).toBeUndefined();
    expect(h.Cookie).toBeUndefined();
  });

  test('流式：content-type 保持 text/event-stream，且分块到达（不被攒成整块）', async () => {
    const r = await postStream(bport, '/v1/responses', {
      model: 'm', stream: true, instructions: 'SYS', input: [{ role: 'user', content: 'x' }],
    });
    expect(r.ctype).toMatch(/text\/event-stream/i);
    expect(r.times.length).toBeGreaterThanOrEqual(2);
    const span = r.times[r.times.length - 1] - r.times[0];
    expect(span).toBeGreaterThanOrEqual(30);
    expect(r.text).toContain('"delta":"A"');
    expect(r.text).toContain('response.completed');
  });
});

// 这一组专治「模块级引用未定义」这类只在 `node tools/token-policy-bridge.js`
// 独立启动时才暴露的崩溃。此前所有用例都是 require 本模块（不触发 listen），
// 所以「能不能真的起来」从没被任何用例覆盖过——上一版就是在这里带着
// ReferenceError 提交了。spawn 真进程 + 读 /health 才能堵住。
describe('token-policy-bridge · 独立进程真能启动', () => {
  const { spawn } = require('child_process');
  const BRIDGE = path.join(__dirname, '../../../tools/token-policy-bridge.js');
  const port = 18999;
  let child;

  beforeAll(async () => {
    child = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        PORT: String(port), BINDING: '127.0.0.1', BRIDGE_MODE: 'observe',
        UPSTREAM: 'http://127.0.0.1:1', // 故意指向不可达地址：health 不需要转发
        BRIDGE_LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-boot-')),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const errs = [];
    child.stderr.on('data', (d) => errs.push(d.toString()));
    child.stdout.resume();

    const deadline = Date.now() + 10000;
    let up = false;
    while (Date.now() < deadline && !up) {
      up = await new Promise((r) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
          res.resume();
          r(res.statusCode === 200);
        });
        req.on('error', () => r(false));
      });
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    if (!up) throw new Error(`桥启动失败：${errs.join('') || '（无 stderr）'}`);
  });

  afterAll(() => { if (child) child.kill(); });

  test('独立进程能起来，/health 返回模式与上游', async () => {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    const j = JSON.parse(body);
    expect(j.ok).toBe(true);
    expect(j.mode).toBe('observe');
    expect(String(j.upstream)).toContain('127.0.0.1:1');
  });
});

function postStream(port, urlPath, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const c = [];
      const times = [];
      const t0 = Date.now();
      res.on('data', (d) => { c.push(d); times.push(Date.now() - t0); });
      res.on('end', () => resolve({ status: res.statusCode, ctype: res.headers['content-type'] || '',
        text: Buffer.concat(c).toString(), times }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
