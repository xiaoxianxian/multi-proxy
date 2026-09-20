#!/usr/bin/env node
'use strict';

// L2 P3 · MCP orchestrate 真执行 E2E demo（PROXY_ADAPTER_REAL 二级门控）
// 纪律（与 l2/ 其它 demo 同构）：
//   - 双门控：PROXY_L2_MCP（bridge 开/关）+ PROXY_ADAPTER_REAL（编排真执行开/关），均默认关（非侵入铁律）。
//   - 真执行经 _realExecutor：每个子任务经 routeEngine.route 路由选中 adapter（非侵入：只算「该谁来跑」），
//     有注入 executor 时委托执行，无注入时退化为「仅路由、记录选中 adapter」（绝不触下游/不写 agent 文件/不联网）。
//   - 真启独立 stdio 子进程（PROXY_ADAPTER_REAL=1，走 require.main 真生产路径）+ 直接 McpServer 真执行 E2E。
//   - 全程零副作用：注入 executor 是 mock（计数 + 回真值，不碰真实 adapter、不触下游进程、不写盘、不联网）。

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.error('FAIL', name); }
}

const SERVER = path.join(__dirname, 'mcp-server.js');

// 把一组消息 pipe 进一个独立 stdio 子进程，按 id 索引响应（与 mcp-server.demo.js 同构）。
function runStdioWithEnv(messages, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    const byId = {};
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { const r = JSON.parse(line); byId[r.id] = r; } catch (_) { /* ignore */ }
      }
    });
    child.on('exit', () => resolve(byId));
    child.on('error', () => resolve(byId));
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.end(); // 关 stdin → 子进程 EOF → exit → 收齐响应
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(byId); }, 8000);
  });
}

(async () => {
  // ---- UC1: 直接 McpServer + gate 开 + 注入 executor → orchestrate 真执行（非 shadow）----
  {
    const { McpServer } = require('./mcp-server.js');
    const { AgentRegistry } = require('./agent-registry.js');
    const { seedDefaultProfiles } = require('./mcp-default-seed.js');
    const reg = new AgentRegistry();
    seedDefaultProfiles(reg);

    let calls = 0;
    const executor = async (adapterId, subtask) => {
      calls++;
      return `real-value-${adapterId}-${subtask.id}`;
    };
    // realGate='1' 由构造器注入（模拟 require.main 在 PROXY_ADAPTER_REAL=1 时的 wire）；
    // executor 注入 → 真执行（_realExecutor 路由 + 委托 executor）。
    const server = new McpServer({ gate: '1', registry: reg, realGate: '1', executor });
    const res = await server.handleMessageAsync({
      jsonrpc: '2.0', id: 50, method: 'tools/call',
      params: { name: 'orchestrate', arguments: { input: 'jwt fastapi 认证' } },
    });
    const p = JSON.parse(res.result.content[0].text);
    ok('UC1: gate 开 + 注入 executor → shadow=false（真执行）', p.shadow === false);
    ok('UC1: 真执行产 4 子任务（fastapi-jwt 模板）', p.subtasks.length === 4 && p.subtasks.every((s) => s.status === 'done'));
    // 非 shadow：value 不再是 {shadow:true}，而是 _realExecutor 的 {routedAdapterId, status:'executed', value}
    ok('UC1: 子任务 value 经 _realExecutor 路由（含 routedAdapterId）',
       p.report && p.report.subtasks.some((s) => s.value && s.value.routedAdapterId));
    ok('UC1: executor 真被调用 4 次（DAG 4 子任务）', calls === 4);
  }

  // ---- UC2: 直接 McpServer + gate 关 → 恒 shadow（per-call shadowMode:false 不可绕过门控）----
  {
    const { McpServer } = require('./mcp-server.js');
    const { AgentRegistry } = require('./agent-registry.js');
    const { seedDefaultProfiles } = require('./mcp-default-seed.js');
    const reg = new AgentRegistry();
    seedDefaultProfiles(reg);

    let calls = 0;
    const executor = async (a, s) => { calls++; return `v-${s.id}`; };
    const server = new McpServer({ gate: '1', registry: reg, realGate: '0', executor });
    // 即便 per-call 传 shadowMode:false，门控关 → 恒 shadow（非侵入）
    const res = await server.handleMessageAsync({
      jsonrpc: '2.0', id: 51, method: 'tools/call',
      params: { name: 'orchestrate', arguments: { input: 'jwt fastapi 认证', shadowMode: false } },
    });
    const p = JSON.parse(res.result.content[0].text);
    ok('UC2: gate 关 → 恒 shadow（per-call shadowMode:false 不可绕过门控）', p.shadow === true);
    ok('UC2: 门控关闭时 executor 不被调用（零副作用）', calls === 0);
  }

  // ---- UC3: 真启独立 stdio 子进程（PROXY_ADAPTER_REAL=1，走 require.main 真生产路径）→ orchestrate 真执行 ----
  // require.main 在 PROXY_ADAPTER_REAL=1 时把 realGate 设 '1'、executor 留 undefined →
  // _realExecutor 退化为「仅路由、记录选中 adapter」：非侵入证明真生产路径在门控开下真路由。
  {
    const resp = await runStdioWithEnv([
      { jsonrpc: '2.0', id: 60, method: 'tools/call',
        params: { name: 'orchestrate', arguments: { input: 'jwt fastapi 认证' } } },
    ], { PROXY_L2_MCP: '1', PROXY_ADAPTER_REAL: '1' });
    const r = resp[60];
    ok('UC3: 子进程 PROXY_ADAPTER_REAL=1 真启 stdio（有响应）', r && r.jsonrpc === '2.0' && r.id === 60);
    let p = null;
    try { p = JSON.parse(r.result.content[0].text); } catch (_) {}
    ok('UC3: 真执行 → shadow=false', p && p.shadow === false);
    ok('UC3: 4 子任务 done + value 含 routedAdapterId（退化「仅路由」记录选中 adapter）',
       p && p.subtasks.length === 4 && p.report && p.report.subtasks.some((s) => s.value && s.value.routedAdapterId));
  }

  console.log(`\nmcp-orchestrate-real demo: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
