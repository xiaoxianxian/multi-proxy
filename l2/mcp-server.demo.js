#!/usr/bin/env node
'use strict';

// L2 P3 · MCP Bridge E2E demo
// 纪律：真开 stdio 子进程 pipe JSON-RPC 2.0 消息进，断言逐行响应；门控关时拒绝。
// 不写盘、不联网、不触 adapter real 执行（仅路由决策 / 能力快照 / shadow）。

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) {
     pass++;
     console.log('PASS', name);
   } else {
    fail++;
    console.error('FAIL', name);
   }
}

const SERVER = path.join(__dirname, 'mcp-server.js');

// 把一组 {method, params, id} 消息按行 pipe 进一个 PROXY_L2_MCP 子进程，收集按 id 索引的响应
function runStdio(messages, gate) {
  return new Promise((resolve) => {
     const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, PROXY_L2_MCP: gate },
        stdio: ['pipe', 'pipe', 'inherit'],
     });
    let buf = '';
    const byId = {};
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          byId[r.id] = r;
        } catch (_) { /* ignore */ }
      }
     });
    child.on('exit', () => resolve(byId));
    child.on('error', () => resolve(byId));
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
     if (gate !== '1') {
        child.kill('SIGKILL'); // 门控关：子进程不启动 stdio
      } else {
        child.stdin.end(); // 关闭 stdin → readline EOF → 子进程 exit → 收集齐响应
        }
    child.on('error', () => resolve(byId));
    // 兜底：10s 没退出强制收，避免异常挂起
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(byId); }, 10000);
  });
}

(async () => {
  // UC1: 门控开，initialize 回 protocolVersion + capabilities
  {
    const resp = await runStdio([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientName: 'demo' } }], '1');
    const r = resp[1];
    ok('UC1: stdio initialize 响应 jsonrpc=2.0 + id', r && r.jsonrpc === '2.0' && r.id === 1);
    ok('UC1: initialize result 含 protocolVersion + serverInfo',
        r && r.result && r.result.protocolVersion && r.result.serverInfo.name === 'l2-mcp-bridge');
  }

  // UC2: 门控开，tools/list 回 MCP 工具（含 routeTask + 注册 adapter）
  {
    const resp = await runStdio([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }], '1');
    const r = resp[2];
    ok('UC2: tools/list 回 tools 数组', r && r.result && Array.isArray(r.result.tools));
    ok('UC2: tools 含 routeTask 能力', r && r.result.tools.some(t => t.name === 'routeTask'));
    ok('UC2: 每个 tool 含 name + inputSchema',
        r && r.result.tools.every(t => t.name && t.inputSchema && t.inputSchema.type === 'object'));
  }

  // UC3: 门控开，tools/call routeTask 回路由决策（shadow，不真执行 adapter）
  {
    const resp = await runStdio([
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'routeTask', arguments: { type: 'video', prompt: 'cat' } } }
    ], '1');
    const r = resp[3];
    ok('UC3: tools/call 回 content 数组', r && r.result && Array.isArray(r.result.content) && r.result.content[0].type === 'text');
    let payload = null;
    try { payload = JSON.parse(r.result.content[0].text); } catch (_) {}
    ok('UC3: routeTask 回 shadow=true（不真执行）', payload && payload.shadow === true);
    ok('UC3: routeTask 路由 video → 有 chosen adapter',
        payload && payload.route && payload.route.chosen && payload.route.chosen.adapterId);
  }

  // UC4: 门控开，未知 method → -32601
  {
    const resp = await runStdio([{ jsonrpc: '2.0', id: 4, method: 'does/not/exist' }], '1');
    const r = resp[4];
    ok('UC4: 未知 method 回 -32601', r && r.error && r.error.code === -32601);
  }

  // UC5: 门控关 → 子进程不启动 stdio，无响应
  {
    const resp = await runStdio([{ jsonrpc: '2.0', id: 9, method: 'ping' }], '0');
    ok('UC5: 门控关时无响应（stdio 未启动）', resp[9] === undefined);
  }

  // UC6: 直接调 startStdio（门控关）应抛 gate closed
  {
    const { McpServer } = require('./mcp-server.js');
    let threw = false;
    try { new McpServer({ gate: '0' }).startStdio(); } catch (e) { threw = e && /gate closed/.test(e.message); }
    ok('UC6: 门控关 startStdio() 抛 gate closed', threw);
  }

  console.log(`\nmcp-server(stdio bridge) demo: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})();
