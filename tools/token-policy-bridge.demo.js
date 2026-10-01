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

// echo 上游：把收到的原始 body 原样回显，用来断言「转发前包长什么样」
function startEcho() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const c = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echo: Buffer.concat(c).toString(), usage: { prompt_tokens: 123, completion_tokens: 7 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
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

  bridge.close();
  echo.close();
  fs.rmSync(LOG_DIR, { recursive: true, force: true });

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
