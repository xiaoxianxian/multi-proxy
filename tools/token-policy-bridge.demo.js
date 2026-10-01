#!/usr/bin/env node
'use strict';
// token-policy-bridge 真跑验证：纯函数 + 端到端转发对照
//
// 核心要证明两件事：
//   ① observe 模式下转发到上游的包**逐字节未变**（零行为改变，这是敢于长期挂着的底线）
//   ② rewrite 模式下 handler 的输出**真的写进了上游请求**（否则接了等于没接）
// 另加一条：policy 报的 netTokenDelta 能落到日志，不是只在内存里打转。

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-demo-'));
process.env.BRIDGE_LOG_DIR = LOG_DIR;
process.env.BRIDGE_AGENT_TYPE = 'coding';

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

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

// echo 上游：把收到的原始 body 原样回显，用来断言「转发前包长什么样」。
// 请求体带 stream:true 时改回 SSE —— 用来断言桥是分块透传，而不是攒成整块再吐。
function startEcho() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const c = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => {
        const raw = Buffer.concat(c).toString();
        let body = {};
        try { body = JSON.parse(raw); } catch { /* 非 JSON 一律按普通回显处理 */ }
        if (body && body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
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

// 记录每个分块的到达时刻——「内容对」不够，还得证明是分块到达的。
// 一次性吐出全部内容同样能通过内容断言，却会把 codex 卡到超时。
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

const CHAT = {
  model: 'demo-model',
  messages: [
    { role: 'system', content: '你是一个助手' },
    { role: 'user', content: '第一条提问' },
    { role: 'assistant', content: '第一条回答' },
    { role: 'user', content: '第二条提问' },
    { role: 'assistant', content: '第二条回答' },
    { role: 'user', content: '第三条提问' },
  ],
  tools: [{ type: 'function', function: { name: 'mcp__heavy__search' } }],
};

(async () => {
  // UPSTREAM 是 bridge 模块加载时读的常量，必须在 require 之前定好端口，
  // 否则会打到默认的 18790（真 codex-proxy），对照结果全是假的。
  const echo = await startEcho();
  process.env.UPSTREAM = `http://127.0.0.1:${echo.address().port}`;
  const B = require('./token-policy-bridge.js');

  console.log('\n=== 一、纯函数：协议归一与改写合并 ===');

  ok('chat/completions：system 剥离、history = 总数-1', () => {
    const c = B.ctxFromRequest(CHAT, 'chat-completions');
    assert.strictEqual(c.messages.length, 5);
    assert.strictEqual(c.history.length, 4);
    assert.strictEqual(c.systemPrompt, '你是一个助手');
    assert.strictEqual(c.tools.length, 1);
  });

  ok('responses：instructions → systemPrompt，input 数组归一', () => {
    const c = B.ctxFromRequest({ model: 'm', instructions: 'SYS', input: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] }, 'responses');
    assert.strictEqual(c.systemPrompt, 'SYS');
    assert.strictEqual(c.messages.length, 2);
    assert.strictEqual(c.history.length, 1);
  });

  ok('responses：input 为字符串时归一成单条 user', () => {
    const c = B.ctxFromRequest({ input: '单轮' }, 'responses');
    assert.strictEqual(c.messages.length, 1);
    assert.strictEqual(c.messages[0].role, 'user');
  });

  ok('改写合并：白名单外字段被忽略、不写进上游', () => {
    const m = B.mergeOutToRequest(CHAT, { messages: [{ role: 'user', content: 'x' }], 恶意字段: 1, netTokenDelta: -3 }, 'chat-completions');
    assert.deepStrictEqual(m.ignored, ['恶意字段']);
    assert.strictEqual(m.changed, true);
    assert.strictEqual(m.body['恶意字段'], undefined);
  });

  ok('改写合并：history 写回不吞掉当前这轮输入', () => {
    const m = B.mergeOutToRequest(CHAT, { history: [{ role: 'user', content: '保留的历史' }] }, 'chat-completions');
    const last = m.body.messages[m.body.messages.length - 1];
    assert.strictEqual(last.content, '第三条提问', '最后一条必须是本轮输入');
    assert.strictEqual(m.body.messages[1].content, '保留的历史');
  });

  ok('改写合并：systemPrompt 替换且保留 system 位', () => {
    const m = B.mergeOutToRequest(CHAT, { systemPrompt: '新提示词' }, 'chat-completions');
    assert.strictEqual(m.body.messages[0].content, '新提示词');
    assert.strictEqual(m.body.messages.filter((x) => x.role === 'system').length, 1);
  });

  console.log('\n=== 二、端到端：转发对照 ===');
  const bridge = B.server;
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  const bport = bridge.address().port;

  // 注册一条真会裁剪历史的 policy（priority 100 保证它是 results[0]，rewrite 取的就是它）
  const TP = require('../l2/token-policy.js');
  TP.registerPolicy({
    hook: 'onRequestAssemble',
    name: '__demo_prune',
    enabled: true,
    priority: 100,
    handler(ctx) {
      const before = JSON.stringify(ctx.messages).length;
      const kept = ctx.messages.length > 2 ? ctx.messages.slice(-2) : ctx.messages;
      return { messages: kept, netTokenDelta: JSON.stringify(kept).length - before };
    },
  });

  process.env.BRIDGE_MODE = 'observe';
  const r1 = await post(bport, '/v1/chat/completions', CHAT);
  const up1 = JSON.parse(r1.text).echo;

  ok('observe：上游收到的包逐字节等于原包（零行为改变）', () => {
    assert.strictEqual(up1, JSON.stringify(CHAT));
  });

  process.env.BRIDGE_MODE = 'rewrite';
  const r2 = await post(bport, '/v1/chat/completions', CHAT);
  const up2 = JSON.parse(r2.text).echo;
  const body2 = JSON.parse(up2);

  ok('rewrite：上游收到的包真的被改写了', () => {
    assert.notStrictEqual(up2, JSON.stringify(CHAT));
  });

  ok('rewrite：裁剪生效——5 条对话裁到 2 条，system 仍在', () => {
    assert.strictEqual(body2.messages.filter((m) => m.role === 'system').length, 1);
    assert.strictEqual(body2.messages.length, 3, '1 system + 2 保留对话');
    assert.strictEqual(body2.messages[2].content, '第三条提问', '当前这轮输入必须还在');
  });

  // codex 现在走的是 responses 协议（config.toml wire_api="responses"），
  // 只验 chat/completions 等于没验主力链路，这里必须补。
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

  process.env.BRIDGE_MODE = 'observe';
  const r3 = await post(bport, '/v1/responses', RESP);
  ok('responses · observe：上游收到的包逐字节等于原包', () => {
    assert.strictEqual(JSON.parse(r3.text).echo, JSON.stringify(RESP));
  });

  process.env.BRIDGE_MODE = 'rewrite';
  const r4 = await post(bport, '/v1/responses', RESP);
  const upResp = JSON.parse(JSON.parse(r4.text).echo);
  ok('responses · rewrite：input 被裁剪且 instructions 不受影响', () => {
    assert.strictEqual(upResp.input.length, 2, '5 条裁到 2 条');
    assert.strictEqual(upResp.input[1].content, 'r5', '当前这轮输入必须还在');
    assert.strictEqual(upResp.instructions, '你是一个助手', 'instructions 不该被动');
  });

  console.log('\n=== 三、度量是否真的落盘 ===');
  const logFile = fs.readdirSync(LOG_DIR).find((f) => f.endsWith('.jsonl'));
  const lines = fs.readFileSync(path.join(LOG_DIR, logFile), 'utf8').trim().split('\n').map(JSON.parse);
  const pick = (mode, api) => lines.find((l) => l.mode === mode && l.api === api);

  ok('四次请求都落了日志（两种协议 × 两种模式）', () => assert.strictEqual(lines.length, 4));

  ok('测到了真实七类组成（tools 桶 > 0）', () => {
    const ob = pick('observe', 'chat-completions');
    assert.ok(ob.estTotal > 0, 'estTotal 应大于 0');
    assert.ok(ob.byCategory.tools > 0, 'tools 桶应大于 0');
  });

  ok('policy 上报的净增量是负数（裁剪=省）且落进日志', () => {
    const ob = pick('observe', 'chat-completions');
    assert.strictEqual(ob.reported, 1, '应有 1 条 policy 上报了净增量');
    assert.ok(ob.estSaved < 0, `estSaved 应为负，实际 ${ob.estSaved}`);
  });

  ok('observe 不改写、rewrite 改写（两种协议都成立）', () => {
    assert.strictEqual(pick('observe', 'chat-completions').rewrote, undefined);
    assert.strictEqual(pick('rewrite', 'chat-completions').rewrote, true);
    assert.strictEqual(pick('observe', 'responses').rewrote, undefined);
    assert.strictEqual(pick('rewrite', 'responses').rewrote, true);
  });

  ok('拿到了上游实测 prompt_tokens（实测轨通了）', () => {
    assert.strictEqual(pick('observe', 'chat-completions').actualPromptTokens, 123);
  });

  console.log('\n=== 四、流式：codex 走 SSE，不能被攒成整块 ===');

  ok('extractUsageFromSSE：responses 形状（response.usage.input_tokens）', () => {
    const sse = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":456,"output_tokens":9}}}\n\n';
    const u = B.extractUsageFromSSE(sse);
    assert.deepStrictEqual(u, { prompt_tokens: 456, completion_tokens: 9 });
  });

  ok('extractUsageFromSSE：chat 形状（usage.prompt_tokens）', () => {
    const sse = 'data: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    assert.deepStrictEqual(B.extractUsageFromSSE(sse), { prompt_tokens: 11, completion_tokens: 2 });
  });

  ok('extractUsageFromSSE：抽不到返回 null，不填 0', () => {
    assert.strictEqual(B.extractUsageFromSSE('data: {"nope":1}\n\n'), null);
    assert.strictEqual(B.extractUsageFromSSE(''), null);
    assert.strictEqual(B.extractUsageFromSSE(null), null);
  });

  ok('pickRequestHeaders：只放行鉴权 / OpenAI 系 / x- 头，hop-by-hop 一律剔除', () => {
    const h = B.pickRequestHeaders({
      Authorization: 'Bearer sk-x', 'Content-Type': 'application/json',
      'OpenAI-Organization': 'org-1', 'X-Title': 'codex',
      Host: 'upstream.example', 'Content-Length': '12', Connection: 'keep-alive',
      Cookie: 'nope',
    });
    assert.strictEqual(h.Authorization, 'Bearer sk-x');
    assert.strictEqual(h['OpenAI-Organization'], 'org-1');
    assert.strictEqual(h['X-Title'], 'codex');
    assert.strictEqual(h.Host, undefined, 'host 不能透传');
    assert.strictEqual(h.Cookie, undefined, '无关头不带');
  });

  const sseResp = await postStream(bridge.address().port, '/v1/responses', {
    model: 'demo-model', stream: true, instructions: '你是一个助手',
    input: [{ role: 'user', content: '流式提问' }],
  });

  ok('流式：content-type 保持 text/event-stream（没被写死成 json）', () => {
    assert.ok(/text\/event-stream/i.test(sseResp.ctype), `实际 ${sseResp.ctype}`);
  });

  ok('流式：分块透传——不是攒成整块一次性吐出', () => {
    assert.ok(sseResp.times.length >= 2, `只收到 ${sseResp.times.length} 块，疑似被攒成整块`);
    const span = sseResp.times[sseResp.times.length - 1] - sseResp.times[0];
    assert.ok(span >= 30, `首块与末块间隔 ${span}ms，应跨越上游的分块间隔`);
  });

  ok('流式：内容一块不少（三块 delta/delta/completed 都在）', () => {
    assert.ok(sseResp.text.includes('"delta":"A"'), '缺第一块');
    assert.ok(sseResp.text.includes('"delta":"B"'), '缺第二块');
    assert.ok(sseResp.text.includes('response.completed'), '缺结束事件');
  });

  await new Promise((r) => setTimeout(r, 120)); // 等 pipe end 后落盘

  ok('流式：从 SSE 尾部抽到了 usage（实测轨在流式下不废）', () => {
    const f2 = fs.readFileSync(path.join(LOG_DIR, logFile), 'utf8').trim().split('\n').map(JSON.parse);
    const st = f2.find((l) => l.streamed === true);
    assert.ok(st, '没有标记为 streamed 的记录');
    assert.strictEqual(st.actualPromptTokens, 456);
    assert.strictEqual(st.actualCompletionTokens, 9);
  });

  console.log('\n=== 五、桥跑的不止一个 hook：历史压缩不能被晾在链路外 ===');
  // 历史压缩挂在 onHistory，而桥最初只跑 onRequestAssemble——
  // 那样最大的一档杠杆永远不会被真实流量触发。
  const TP2 = require('../l2/token-policy.js');
  TP2.registerPolicy({
    hook: 'onHistory',
    name: '__demo_fold_tool',
    enabled: true,
    priority: 100,
    handler(ctx) {
      const before = JSON.stringify(ctx.history || []).length;
      const h = (ctx.history || []).map((m) => (m && m.role === 'tool'
        ? Object.assign({}, m, { content: '[工具输出已折叠 · 演示]' }) : m));
      return { history: h, netTokenDelta: JSON.stringify(h).length - before };
    },
  });

  process.env.BRIDGE_MODE = 'rewrite';
  const CHAT2 = {
    model: 'demo-model',
    messages: [
      { role: 'tool', content: 'L'.repeat(300), name: 'grep' },
      { role: 'user', content: '最后一条提问' },
    ],
  };
  const r5 = await post(bport, '/v1/chat/completions', CHAT2);
  const up5 = JSON.parse(r5.text).echo;

  ok('onHistory 确实被跑了（hook 列表里有两个）', () => {
    const f2 = fs.readFileSync(path.join(LOG_DIR, logFile), 'utf8').trim().split('\n').map(JSON.parse);
    const last = f2[f2.length - 1];
    const hooks = (last.policies || []).map((p) => p.hook);
    assert.ok(hooks.includes('onHistory'), `hook 列表: ${JSON.stringify(hooks)}`);
    assert.ok(hooks.includes('onRequestAssemble'), `hook 列表: ${JSON.stringify(hooks)}`);
  });

  ok('历史压缩没被后一个 hook 的原样 messages 盖掉', () => {
    // prompt-assemble 这类 passthrough policy 会原样吐回 ctx.messages，
    // 若照写就会把 onHistory 刚折叠好的内容整个覆盖——压缩白算且日志看不出来
    assert.ok(up5.includes('已折叠'), '上游收到的包里应有折叠标记');
    assert.ok(up5.includes('最后一条提问'), '当前这轮输入不能被吞掉');
  });

  bridge.close();
  echo.close();
  fs.rmSync(LOG_DIR, { recursive: true, force: true });

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
