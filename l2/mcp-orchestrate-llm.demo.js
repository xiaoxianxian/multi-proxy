#!/usr/bin/env node
'use strict';

// L2 P3 option3 二期 · MCP orchestrate LLM 拆解真接线 E2E demo
// 纪律（与 l2/ 其它 demo 同构）：
//    - 门控 PROXY_LLM_DECOMPOSE（默认关，非侵入铁律）：关 → orchestrate 走内置模板拆解（既有 22 例行为、零 LLM）。
//    - 开 → orchestrate 在拆解步尝试 LLM（镜像 routes/orchestration.js 的 isLlmDecomposeOpen + makeLlmDecomposer）；
//      内核内已带失败降级（LLM 不可达 / 坏 JSON / 自环 → templateDecompose），绝不冒泡。
//    - 与 PROXY_ADAPTER_REAL 正交：本 demo 全在 PROXY_ADAPTER_REAL=0（shadow）下跑，验证「L 拆解」与「adapter 真执行」解耦。
//    - 全程零副作用：假 LLM 是本地 http（不起真模型、不触真实 adapter、不写盘）。
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.error('FAIL', name); }
}

const SERVER = path.join(__dirname, 'mcp-server.js');

// LLM 产出的合法 3 子任务 DAG（design → impl → test 线性无环）
const LLM_DAG_JSON = JSON.stringify({
  subtasks: [
    { id: 'design', type: 'plan', complexity: 'low', prompt: '设计 API', deps: [] },
    { id: 'impl', type: 'code', complexity: 'medium', prompt: '实现 + JWT', deps: ['design'] },
    { id: 'test', type: 'test', complexity: 'low', prompt: '写测试', deps: ['impl'] },
   ],
});

// 起一个假 LLM /v1/chat/completions 服务；handler 收请求 body、返助手消息文本。
function startMockLlm(handler) {
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      let parsed; try { parsed = JSON.parse(buf); } catch { parsed = {}; }
      const out = handler(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-x', model: parsed.model || 'default',
          choices: [{ message: { content: out } }] }));
     });
   });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    res({ server, port: server.address().port, close: () => server.close() });
   }));
}

// 真启独立 stdio 子进程（PROXY_L2_MCP=1 + PROXY_LLM_DECOMPOSE=1 + 假/宕机 LLM）跑一把 orchestrate：
// 子进程 startStdioAsync 内已做「drain-on-EOF」（EOF 先等在飞 async 响应 flush 落地再 exit），
// 故 collect 按 child exit 收齐响应是安全的、确定性的；exit 是响应已落地的信号。
function runStdioLlm(messages, env) {
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
    child.stdin.end(); // 关 stdin → 子进程 EOF（drain-on-EOF 保证响应已写出）
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(byId); }, 8000);
       });
}

(async () => {
   // 确保 adapter 真执行门控关（本 demo 只验 LLM 拆解，与 PROXY_ADAPTER_REAL 正交）
  process.env.PROXY_ADAPTER_REAL = '0';

   // ---- UC1: 默认 PROXY_LLM_DECOMPOSE 关 → orchestrate 走内置模板（既有 22 例行为、无 decomposeSource、零 LLM 依赖）----
  {
    const { McpServer } = require('./mcp-server.js');
    const { AgentRegistry } = require('./agent-registry.js');
    const { seedDefaultProfiles } = require('./mcp-default-seed.js');
    const reg = new AgentRegistry();
    seedDefaultProfiles(reg);
    const server = new McpServer({ gate: '1', registry: reg });
    delete process.env.PROXY_LLM_DECOMPOSE;
    const res = await server.handleMessageAsync({
      jsonrpc: '2.0', id: 70, method: 'tools/call',
      params: { name: 'orchestrate', arguments: { input: '做一个短片 视频创作' } },
     });
    const p = JSON.parse(res.result.content[0].text);
     // 内置 video-workflow 模板 5 子任务；LLM 门控关 → 不出现 decomposeSource 字段
    ok('UC1: 门控关 → 走内置 video-workflow 模板(5 子任务)', p.template === 'video-workflow' && p.subtasks.length === 5);
    ok('UC1: 门控关 → shadow=true（恒 shadow，不触下游）', p.shadow === true);
    ok('UC1: 门控关 → 无 decomposeSource 观测字段（LLM 未介入）', !('decomposeSource' in p));
   }

   // ---- UC2: 真启独立 stdio 子进程（PROXY_LLM_DECOMPOSE=1 + 假 LLM）→ orchestrate 真 LLM 拆解 ----
  {
    const llm = await startMockLlm(() => LLM_DAG_JSON);
    const resp = await runStdioLlm([
       { jsonrpc: '2.0', id: 80, method: 'tools/call',
        params: { name: 'orchestrate', arguments: { input: '帮我做一个带 JWT 认证的 API + 测试' } } },
     ], {
        PROXY_L2_MCP: '1',
        PROXY_LLM_DECOMPOSE: '1',
        PROXY_LLM_BASE_URL: `http://127.0.0.1:${llm.port}`,
        PROXY_LLM_MODEL: 'qwen3.8:27b-mlx',
        PROXY_ADAPTER_REAL: '0',
       });
    const r = resp[80];
    const rp = r ? JSON.parse(r.result.content[0].text) : null;
    ok('UC2: 门控开 + 真 http 假 LLM → template=llm', rp && rp.template === 'llm');
    ok('UC2: LLM 拆解产 3 子任务全 done（shadow 下 status=done）',
        rp && rp.subtasks.length === 3 && rp.subtasks.every((s) => s.status === 'done'));
    ok('UC2: decomposeSource=llm（观测标 LLM 成功）', rp && rp.decomposeSource === 'llm');
    ok('UC2: 与 PROXY_ADAPTER_REAL 解耦 → 仍 shadow=true', rp && rp.shadow === true);
    llm.close();
   }

   // ---- UC3: 真启独立 stdio 子进程（PROXY_LLM_DECOMPOSE=1 + LLM 宕机）→ 自动降级回模板 ----
  {
     // 起一个 LLM 服务再关闭，制造 connection refused（ECONNREFUSED → 归类 llm-down）
    const closed = await startMockLlm(() => LLM_DAG_JSON);
    const deadPort = closed.server.address().port;
    closed.close();

    const resp = await runStdioLlm([
       { jsonrpc: '2.0', id: 81, method: 'tools/call',
        params: { name: 'orchestrate', arguments: { input: '做一个短片 视频创作' } } },
      ], {
        PROXY_L2_MCP: '1',
        PROXY_LLM_DECOMPOSE: '1',
        PROXY_LLM_BASE_URL: `http://127.0.0.1:${deadPort}`,
        PROXY_LLM_TIMEOUT_MS: '1500',
        PROXY_ADAPTER_REAL: '0',
       });
    const r = resp[81];
    const rp = r ? JSON.parse(r.result.content[0].text) : null;
    ok('UC3: LLM 宕机 → 降级仍产 DAG（不抛、orchestrate 成功返回）', rp && rp.subtasks.length >= 1);
    ok('UC3: 降级 → video-workflow 模板（视频 5 子任务）', rp && rp.template === 'video-workflow');
    ok('UC3: decomposeSource 含 llm-down（观测降级原因）', rp && /llm-down/.test(rp.decomposeSource || ''));
   }

   // ---- UC4: 直供 dag → LLM 不介入（即便门控开，dag 路径跳过拆解）----
  {
    const { McpServer } = require('./mcp-server.js');
    const { AgentRegistry } = require('./agent-registry.js');
    const { seedDefaultProfiles } = require('./mcp-default-seed.js');
    const reg = new AgentRegistry();
    seedDefaultProfiles(reg);
    const server = new McpServer({ gate: '1', registry: reg });
    process.env.PROXY_LLM_DECOMPOSE = '1';
    const res = await server.handleMessageAsync({
      jsonrpc: '2.0', id: 72, method: 'tools/call',
      params: { name: 'orchestrate', arguments: {
        dag: { input: 'x', template: 'prebuilt', subtasks: [{ id: 'a', type: 'code', prompt: 'p', deps: [] }], edges: [] },
       } },
     });
    const p = JSON.parse(res.result.content[0].text);
    ok('UC4: 直供 dag → 跳过 LLM（无 decomposeSource 观测）', !('decomposeSource' in p));
    ok('UC4: 直供 dag → template=prebuilt（保持直供语义）', p.template === 'prebuilt');
    delete process.env.PROXY_LLM_DECOMPOSE;
   }

  console.log(`\nmcp-orchestrate-llm demo: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
