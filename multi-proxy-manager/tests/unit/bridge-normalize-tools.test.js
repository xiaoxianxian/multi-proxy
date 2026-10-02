'use strict';

// bridge normalizeTools · 工具类型归一化
//
// 2026-10-01 实测背景：codex 0.159.3 走 responses 协议会发 type:'namespace'
// （子代理容器）与 type:'web_search'，agnes 只认 function / web_search_preview /
// code_interpreter / mcp 四种 → 整包 400 `unknown variant namespace`。
// 这不是桥的 bug，是 adapter 层的兼容缺口。
//
// 本文件锁三条：
//   ① 归一化不丢能力（namespace 摊平成子 function，字段原样搬出）
//   ② 归一化在零改动时**完全不碰**请求体（普通 curl 不被序列化抖一遍）
//   ③ 归一化真的接进了转发路径（纯函数对但没接线 = 今天踩过的坑）
//      —— 所以必须有一个真穿过 HTTP 的回环用例，不能只测纯函数。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = '../../../';
let B;
let echo;
let echoPort;
let tmpLog;

const FN = (name) => ({
  type: 'function', name, description: 'd', strict: false,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});
const NS = {
  type: 'namespace', name: 'multi_agent_v1', description: 'sub',
  tools: [FN('close_agent'), FN('open_agent')],
};
const WS = { type: 'web_search', external_web_access: false };

function post(port, urlPath, obj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeAll(async () => {
  tmpLog = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-test-'));

  echo = http.createServer((req, res) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ echo: Buffer.concat(c).toString() }));
    });
  });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  echoPort = echo.address().port;

  // 必须在 require 桥之前设好——UPSTREAM / NORMALIZE_TOOLS 都是模块加载时读的常量
  process.env.UPSTREAM = `http://127.0.0.1:${echoPort}`;
  process.env.BRIDGE_NORMALIZE_TOOLS = '1';
  process.env.BRIDGE_LOG_DIR = tmpLog;
  process.env.BRIDGE_AGENT_TYPE = 'coding';
  B = require(ROOT + 'tools/token-policy-bridge.js');
});

afterAll(() => {
  if (echo) echo.close();
  if (tmpLog) fs.rmSync(tmpLog, { recursive: true, force: true });
});

describe('normalizeTools 纯函数', () => {
  it('namespace 摊平成子 function，字段原样搬出（能力不丢）', () => {
    const r = B.normalizeTools({ tools: [NS] });
    expect(r.changed).toBe(true);
    expect(r.from).toEqual(['namespace']);
    expect(r.body.tools.length).toBe(2);
    expect(r.body.tools[0]).toEqual(NS.tools[0]);
  });

  it('web_search → web_search_preview，其余字段保留', () => {
    const r = B.normalizeTools({ tools: [WS] });
    expect(r.from).toEqual(['web_search']);
    expect(r.body.tools[0]).toEqual({ type: 'web_search_preview', external_web_access: false });
  });

  it('无子工具的 namespace 退化成无参 function 壳（请求还能发出去）', () => {
    const r = B.normalizeTools({ tools: [{ type: 'namespace', name: 'orphan', tools: [] }] });
    expect(r.body.tools[0].type).toBe('function');
    expect(r.body.tools[0].parameters.properties).toEqual({});
  });

  it('全 function 的包零改动，且返回原对象引用', () => {
    const body = { tools: [FN('a'), FN('b')] };
    const r = B.normalizeTools(body);
    expect(r.changed).toBe(false);
    expect(r.from).toEqual([]);
    expect(r.body).toBe(body);
  });

  it('幂等：已归一化的包再跑一次无改动', () => {
    const r = B.normalizeTools(B.normalizeTools({ tools: [NS, WS] }).body);
    expect(r.changed).toBe(false);
  });

  it('null / 字符串等非法元素原样透传，不抛', () => {
    const r = B.normalizeTools({ tools: [null, 'str'] });
    expect(r.changed).toBe(false);
    expect(r.body.tools).toEqual([null, 'str']);
  });

  it('没有 tools 字段不炸（无参 bodies）', () => {
    expect(() => B.normalizeTools({ model: 'x', input: 'hi' })).not.toThrow();
    expect(B.normalizeTools({ model: 'x', input: 'hi' }).changed).toBe(false);
  });

  // 2026-10-02 抓到的真包：codex 0.159.3 会发 custom（apply_patch，freeform 编辑）
  // 与 tool_search（客户端执行的工具发现器），上游两者都不认 → 之前整包 400。
  // 规则是**剔除**而不是压成无参 function 壳：壳是给上游一个假工具，
  // 而这两类本来就是 codex 本地执行的能力。
  it('custom 被剔除（freeform 编辑工具映射不过去）', () => {
    const r = B.normalizeTools({
      tools: [FN('exec_command'), { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
    });
    expect(r.body.tools.map((t) => t.type)).toEqual(['function']);
    expect(r.body.tools[0].name).toBe('exec_command');
    expect(r.from).toEqual(['custom']);
  });

  it('tool_search 被剔除（客户端执行，且不能伪装成 function）', () => {
    const r = B.normalizeTools({ tools: [{ type: 'tool_search', execution: 'client', description: 'd' }] });
    expect(r.body.tools).toEqual([]);
    expect(r.from).toEqual(['tool_search']);
  });

  it('白名单内的 mcp / code_interpreter 原样保留', () => {
    const r = B.normalizeTools({ tools: [{ type: 'mcp', name: 'y' }, { type: 'code_interpreter' }] });
    expect(r.changed).toBe(false);
    expect(r.body.tools.map((t) => t.type)).toEqual(['mcp', 'code_interpreter']);
  });
});

describe('接线：归一化真的改写转发出去的包', () => {
  let bridge;
  let bport;

  beforeAll(async () => {
    bridge = B.server;
    await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
    bport = bridge.address().port;
  });

  afterAll(() => {
    if (bridge) bridge.close();
  });

  it('observe 模式下也生效（归一化独立于 rewrite）', async () => {
    const payload = { model: 'demo', stream: false, tools: [NS, WS] };
    const res = await post(bport, '/v1/chat/completions', payload);
    expect(res.status).toBe(200);

    const up = JSON.parse(JSON.parse(res.text).echo);
    const types = up.tools.map((t) => t.type);
    expect(types).not.toContain('namespace');
    expect(types).not.toContain('web_search');
    expect(up.tools.filter((t) => t.type === 'web_search_preview').length).toBe(1);
    // namespace 摊出 2 个 function + 原有 0 → 共 3
    expect(up.tools.length).toBe(3);
    expect(up.tools.map((t) => t.name)).toContain('close_agent');
  });

  it('没有非法 type 的包逐字节原样转发（零副作用没被破坏）', async () => {
    const payload = { model: 'demo', stream: false, tools: [FN('a')] };
    const res = await post(bport, '/v1/chat/completions', payload);
    const up = JSON.parse(JSON.parse(res.text).echo);
    expect(up).toEqual(payload);
  });
});
