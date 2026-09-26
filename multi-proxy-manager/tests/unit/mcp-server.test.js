'use strict';

// L2 P3 · McpServer unit test
// 覆盖：initialize / ping / tools/list / tools/call / 门控关 / 错误码 / adapter 能力映射。
// 所有测试不 spawn 子进程，直接调 handleMessage（纯函数路径）。

const { McpServer, PROTOCOL_VERSION, SERVER_INFO } = require('../../../l2/mcp-server');
const { AgentRegistry } = require('../../../l2/agent-registry');
const { PluginRuntime } = require('../../../l2/plugin-runtime');

function newServer(gate = '1') {
    const reg = new AgentRegistry();
    reg.create({ id: 'h3web',  name: 'H3Web',  type: 'custom', adapterId: 'h3web',
                 capabilityTags: ['video', 'text2video', 'image'], description: '本地视频引擎' });
    reg.create({ id: 'codex',  name: 'Codex',  type: 'codex',  adapterId: 'codex',
                 capabilityTags: ['code', 'review'],              description: '代码 agent' });
    return new McpServer({ gate, registry: reg });
}

describe('McpServer · JSON-RPC 2.0 over stdio', () => {

    describe('协议元信息', () => {
        test('PROTOCOL_VERSION / SERVER_INFO 导出一致', () => {
            expect(PROTOCOL_VERSION).toBe('2025-03-26');
            expect(SERVER_INFO.name).toBe('l2-mcp-bridge');
            expect(SERVER_INFO.version).toEqual(expect.any(String));
        });
    });

    describe('initialize', () => {
        test('回 protocolVersion + capabilities + serverInfo', () => {
            const s = newServer();
            const r = s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
            expect(r.jsonrpc).toBe('2.0');
            expect(r.id).toBe(1);
            expect(r.result.protocolVersion).toBe(PROTOCOL_VERSION);
            expect(r.result.serverInfo.name).toBe('l2-mcp-bridge');
            expect(r.result.capabilities).toBeDefined();
        });

        test('重复 initialize 幂等不报错', () => {
            const s = newServer();
            const r1 = s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
            const r2 = s.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize' });
            expect(r1.result.protocolVersion).toEqual(r2.result.protocolVersion);
        });
    });

    describe('ping', () => {
        test('ping 回 null result（MCP 规范 health check）', () => {
            const s = newServer();
            const r = s.handleMessage({ jsonrpc: '2.0', id: 9, method: 'ping' });
            expect(r.id).toBe(9);
            expect(r.result).toBeNull();
        });
    });

    describe('tools/list', () => {
        test('含 adapter 工具 + routeTask，每项有 name + object inputSchema', () => {
            const s = newServer();
            const r = s.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
            const tools = r.result.tools;
            expect(Array.isArray(tools)).toBe(true);
            expect(tools.some(t => t.name === 'routeTask')).toBe(true);
            expect(tools.some(t => t.name === 'h3web')).toBe(true);
            expect(tools.some(t => t.name === 'codex')).toBe(true);
            for (const t of tools) {
                expect(typeof t.name).toBe('string');
                expect(t.inputSchema.type).toBe('object');
            }
        });
    });

    describe('tools/call', () => {
        test('routeTask 路由 video → shadow 决策（不真执行）', () => {
            const s = newServer();
            const r = s.handleMessage({
                jsonrpc: '2.0', id: 4, method: 'tools/call',
                params: { name: 'routeTask', arguments: { type: 'video', prompt: 'cat' } },
            });
            expect(r.result.content[0].type).toBe('text');
            const payload = JSON.parse(r.result.content[0].text);
            expect(payload.shadow).toBe(true);
            expect(payload.route.chosen.adapterId).toBeTruthy();
        });

        test('未知 tool name → -32602 + available 列表', () => {
            const s = newServer();
            const r = s.handleMessage({
                jsonrpc: '2.0', id: 5, method: 'tools/call',
                params: { name: 'no-such-tool' },
            });
            expect(r.error.code).toBe(-32602);
            expect(Array.isArray(r.error.data.available)).toBe(true);
        });

        test('缺 tool name → -32602', () => {
            const s = newServer();
            const r = s.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {} });
            expect(r.error.code).toBe(-32602);
        });
    });

    describe('错误码', () => {
        test('未知 method → -32601', () => {
            const s = newServer();
            const r = s.handleMessage({ jsonrpc: '2.0', id: 7, method: 'does/not/exist' });
            expect(r.error.code).toBe(-32601);
        });

        test('缺 jsonrpc=2.0 → -32600 Invalid Request', () => {
            const s = newServer();
            const r = s.handleMessage({ id: 8, method: 'ping' });
            expect(r.error.code).toBe(-32600);
        });
    });

    describe('门控', () => {
        test('门控关时 handleMessage 抛 gate closed', () => {
            const s = newServer('0');
            expect(() => s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }))
                  .toThrow(/gate closed/);
         });

        test('门控关时 startStdio() 抛 gate closed（不开 stdio）', () => {
            const s = newServer('0');
            expect(() => s.startStdio()).toThrow(/gate closed/);
         });

        test('默认构造器门控关（gate 缺省 0）→ handleMessage 拒绝', () => {
             // 不传 gate 时走 process.env 默认 0，非侵入
            delete process.env.PROXY_L2_MCP;
            const s = new McpServer();
            expect(s.isGateOpen()).toBe(false);
         });
     });

    // ---- L2 编排能力经 MCP bridge 暴露 ----
    // orchestrate（经 callToolAsync/handleMessageAsync，本质 async：DAG 并发调度，shadow 不真执行）
    // + decompose（同步：经 templateDecompose 拆 DAG，零 LLM）。
    // 同步 callTool/handleMessage 仍是纯同步不回归——async 工具仅走 *Async 路径。
    describe('L2 编排能力（orchestrate / decompose，经 async bridge）', () => {
        test('tools/list 含 orchestrate + decompose 能力', () => {
            const s = newServer();
            const tools = s.listTools();
            expect(tools.some((t) => t.name === 'orchestrate')).toBe(true);
            expect(tools.some((t) => t.name === 'decompose')).toBe(true);
            // orchestrate 是 async 工具，schema 声明 async 语义（input/dag/shadowMode/maxRetries）
            const orch = tools.find((t) => t.name === 'orchestrate');
            expect(orch.inputSchema.properties).toHaveProperty('input');
            expect(orch.inputSchema.properties).toHaveProperty('dag');
            expect(orch.inputSchema.properties).toHaveProperty('shadowMode');
        });

        test('orchestrate（dag 直供）→ shadow 调度，回 template + subtasks + report', async () => {
            const s = newServer();
            const r = await s.handleMessageAsync({
                jsonrpc: '2.0', id: 11, method: 'tools/call',
                params: { name: 'orchestrate', arguments: {
                    dag: {
                        input: 'e2e', template: 'e2e',
                        subtasks: [
                            { id: 'a', type: 'code', complexity: 'low', prompt: 'p', deps: [] },
                            { id: 'b', type: 'code', complexity: 'medium', prompt: 'q', deps: ['a'] },
                        ],
                        edges: [['a', 'b']],
                    },
                } },
            });
            expect(r.result.content[0].type).toBe('text');
            const p = JSON.parse(r.result.content[0].text);
            expect(p.shadow).toBe(true);              // 非侵入铁律：默认 shadow，不真执行 adapter
            expect(p.template).toBe('e2e');
            expect(p.subtasks).toEqual([
                { id: 'a', type: 'code', status: 'done' },
                { id: 'b', type: 'code', status: 'done' },
            ]);
            expect(p.report).toBeTruthy();
        });

        test('orchestrate（input → 内置模板拆解后跑）→ shadow 产 DAG', async () => {
            const s = newServer();
            const r = await s.handleMessageAsync({
                jsonrpc: '2.0', id: 12, method: 'tools/call',
                params: { name: 'orchestrate', arguments: { input: '做一个视频短片' } },
            });
            const p = JSON.parse(r.result.content[0].text);
            expect(p.shadow).toBe(true);
            // '视频' 命中 video-workflow 模板 → 5 个子任务（understand/storyboard/gen-clip-a/gen-clip-b/compose）
            expect(p.template).toBe('video-workflow');
            expect(p.subtasks.length).toBe(5);
            expect(p.subtasks.every((s) => s.status === 'done')).toBe(true);
        });

        test('decompose → templateDecompose 拆 DAG（确定性、零 LLM）', async () => {
            const s = newServer();
            const r = await s.handleMessageAsync({
                jsonrpc: '2.0', id: 13, method: 'tools/call',
                params: { name: 'decompose', arguments: { input: '实现 jwt 认证' } },
            });
            const p = JSON.parse(r.result.content[0].text);
            expect(p.shadow).toBe(true);
            // 'jwt' 命中 fastapi-jwt 模板 → 4 个子任务 + 3 条依赖边（线性）
            expect(p.template).toBe('fastapi-jwt');
            expect(p.subtasks).toHaveLength(4);
            expect(p.edges).toHaveLength(3);
            expect(p.subtasks[0]).toMatchObject({ id: 'design-api', type: 'code', complexity: 'low' });
        });

        test('decompose 缺 input → -32602', async () => {
            const s = newServer();
            const r = await s.handleMessageAsync({
                jsonrpc: '2.0', id: 14, method: 'tools/call',
                params: { name: 'decompose', arguments: {} },
            });
            expect(r.error.code).toBe(-32602);
            expect(r.error.message).toMatch(/decompose: missing input/);
        });

        test('同步 callTool 仍纯同步不回归（orchestrate 委托到 sync 路径）', () => {
            const s = newServer();
            // 同步 callTool 对 orchestrate 不特判 → 落到 adapter/routeTask 分支（行为不变、零 async）
            const r = s.callTool('routeTask', { type: 'video', prompt: 'x' });
            expect(r.shadow).toBe(true);
            expect(r.route.chosen.adapterId).toBeTruthy();
        });
    });

    describe('异步门控（async-gate）', () => {
        test('门控关时 handleMessageAsync 抛 gate closed（与同步一致）', async () => {
            const s = newServer('0');
            await expect(s.handleMessageAsync({ jsonrpc: '2.0', id: 1, method: 'ping' }))
                  .rejects.toThrow(/gate closed/);
         });

        test('门控关时 startStdioAsync() 抛 gate closed（不开 async stdio）', () => {
            const s = newServer('0');
            expect(() => s.startStdioAsync()).toThrow(/gate closed/);
         });

        test('门控开时 handleMessageAsync 走 async 路径（tools/call orchestrate）', async () => {
            const s = newServer('1');
            const r = await s.handleMessageAsync({
                jsonrpc: '2.0', id: 1, method: 'tools/call',
                params: { name: 'orchestrate', arguments: { input: 'jwt 认证' } },
             });
            expect(r.id).toBe(1);
            expect(r.result.content[0]).toHaveProperty('type', 'text');
          });
       });

    // ---- L2 P3 · 编排「真执行」二级门控（PROXY_ADAPTER_REAL）----
    // 非侵入铁律：门控关（默认）→ orchestrate 恒 shadow（不触下游 adapter）；门控开 → 真执行
    // （经 _realExecutor 路由选中 adapter；无注入 executor 时退化为「仅路由」）。
    describe('编排真执行（PROXY_ADAPTER_REAL 二级门控）', () => {
       // 门控开 + 注入 executor → 真执行：shadow=false，executor 真跑，value 含路由选中 adapter
       test('门控开 + 注入 executor → 真执行 shadow=false + executor 被调用', async () => {
           let calls = 0;
           const s = newServer('1');
           s.realGate = '1';
           s.executor = async (adapterId, subtask) => { calls++; return `real-${adapterId}-${subtask.id}`; };
           const r = await s.handleMessageAsync({
               jsonrpc: '2.0', id: 70, method: 'tools/call',
               params: { name: 'orchestrate', arguments: { input: 'jwt fastapi 认证' } },
             });
           const p = JSON.parse(r.result.content[0].text);
           expect(p.shadow).toBe(false);             // 真执行（非 shadow）
           expect(p.subtasks).toHaveLength(4);        // fastapi-jwt 模板 4 节点
           expect(p.subtasks.every((s) => s.status === 'done')).toBe(true);
           // value 经 _realExecutor：status executed + 路由选中的 adapter
           const values = p.report.subtasks.map((s) => s.value);
           expect(values.some((v) => v && v.status === 'executed' && v.routedAdapterId)).toBe(true);
           expect(calls).toBe(4);                     // executor 真被调用（DAG 4 子任务）
          });

        // 门控开但无注入 executor → 退化「仅路由」：所有子任务 status='routed'；
        // 有注册 adapter 的类型带 routedAdapterId（快类型如 test 无 adapter → null，是正确退化，非缺陷）
        test('门控开 + 无 executor → 退化仅路由（routed，不触下游）', async () => {
          const s = newServer('1');
          s.realGate = '1';                           // 模拟 require.main：PROXY_ADAPTER_REAL=1 时 realGate 开、executor 仍 undefined
          const r = await s.handleMessageAsync({
              jsonrpc: '2.0', id: 71, method: 'tools/call',
              params: { name: 'orchestrate', arguments: { input: 'jwt fastapi 认证' } },
            });
          const p = JSON.parse(r.result.content[0].text);
          expect(p.shadow).toBe(false);
          const values = p.report.subtasks.map((s) => s.value);
           // 全部子任务退化「仅路由」（无 executor → 不触下游 adapter）
          expect(values.every((v) => v && v.status === 'routed')).toBe(true);
           // 有注册 adapter 的类型（code→codex）带 routedAdapterId；test 无注册 adapter → null（正确退化）
          expect(values.some((v) => v.routedAdapterId)).toBe(true);
          expect(values.some((v) => v.routedAdapterId === 'codex')).toBe(true);
          });

        // 门控关（默认）→ 恒 shadow：即便 per-call 传 shadowMode:false 也无法绕过门控（非侵入）
       test('门控关 → 恒 shadow（per-call shadowMode:false 不可绕过门控）', async () => {
           let calls = 0;
           const s = newServer('1');
           s.realGate = '0';
           s.executor = async (a, st) => { calls++; return `v-${st.id}`; };  // 即便注入也应在门控关时不被调用
           const r = await s.handleMessageAsync({
               jsonrpc: '2.0', id: 72, method: 'tools/call',
               params: { name: 'orchestrate', arguments: { input: 'jwt fastapi 认证', shadowMode: false } },
            });
           const p = JSON.parse(r.result.content[0].text);
           expect(p.shadow).toBe(true);               // 门控关恒 shadow（per-call 不能绕过）
           expect(calls).toBe(0);                    // executor 不被调用（零副作用）
          });

        // 默认（realGate 缺省 0）orchestrate 仍 shadow=true（向后兼容既有 22 例的行为，零回归断言）
       test('默认门控关 → orchestrate shadow=true（既有行为零回归）', async () => {
         const s = newServer('1');
         const r = await s.handleMessageAsync({
             jsonrpc: '2.0', id: 73, method: 'tools/call',
             params: { name: 'orchestrate', arguments: { input: '做一个视频短片' } },
           });
         const p = JSON.parse(r.result.content[0].text);
         expect(p.shadow).toBe(true);
         expect(p.template).toBe('video-workflow');
         expect(p.subtasks.every((s) => s.status === 'done')).toBe(true);
           });
           });

           // ---- L2 Step 6（A3 #4）· MCP 资源面（非侵入只读视图）----
       // resources/list = 活跃 agent 注册表；resources/read = 单 agent 只读视图（密钥脱敏）。
       // 纯只读、不触下游 adapter；与 PROXY_ADAPTER_REAL 真执行路径解耦。
       describe('L2 Step 6 · MCP 资源面（resources/list + resources/read，非侵入只读）', () => {
       test('initialize 声明 resources.listChanged=false', () => {
           const s = newServer();
           const r = s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
           expect(r.result.capabilities.resources).toEqual({ listChanged: false });
        });

       test('resources/list → 活跃 agent 注册表（每项含 uri/name/tags/mimeType）', () => {
           const s = newServer();
           const r = s.handleMessage({ jsonrpc: '2.0', id: 80, method: 'resources/list' });
           expect(r.jsonrpc).toBe('2.0');
           expect(Array.isArray(r.result.resources)).toBe(true);
           const uris = r.result.resources.map((x) => x.uri);
           expect(uris).toContain('l2://agent/h3web');
           expect(uris).toContain('l2://agent/codex');
           for (const x of r.result.resources) {
               expect(x.uri).toMatch(/^l2:\/\/agent\//);
               expect(x.mimeType).toBe('application/json');
               expect(Array.isArray(x.tags)).toBe(true);
            }
        });

       test('resources/read → 单 agent 只读视图（mimeType + contents）+ 密钥脱敏', () => {
           const s = newServer();
           // 注册一个带 token 字段的 agent，验证读视图脱敏
           s.registry.create({ id: 'codex-secret', name: 'CodexSec', type: 'codex', adapterId: 'codex-secret',
                               capabilityTags: ['code'], description: '测脱敏', token: 'sk-SECRET' });
           const r = s.handleMessage({ jsonrpc: '2.0', id: 81, method: 'resources/read',
                                      params: { uri: 'l2://agent/h3web' } });
           expect(r.result.uri).toBe('l2://agent/h3web');
           expect(r.result.mimeType).toBe('application/json');
           expect(Array.isArray(r.result.contents)).toBe(true);
           const view = JSON.parse(r.result.contents[0].text);
           expect(view.id).toBe('h3web');

           // 带 token 的 agent → read 视图里 token 被脱敏，绝不回传明文
           const r2 = s.handleMessage({ jsonrpc: '2.0', id: 82, method: 'resources/read',
                                       params: { uri: 'l2://agent/codex-secret' } });
           const view2 = JSON.parse(r2.result.contents[0].text);
           expect(view2.token).toEqual(expect.stringMatching(/\[redacted\]/));
           expect(JSON.stringify(view2)).not.toContain('sk-SECRET');
        });

       test('resources/read 未知 uri → -32602 + available 列表', () => {
           const s = newServer();
           const r = s.handleMessage({ jsonrpc: '2.0', id: 83, method: 'resources/read',
                                      params: { uri: 'l2://agent/nope' } });
           expect(r.error.code).toBe(-32602);
           expect(Array.isArray(r.error.data.available)).toBe(true);
        });

       test('resources/read 缺 uri → -32602', () => {
           const s = newServer();
           const r = s.handleMessage({ jsonrpc: '2.0', id: 84, method: 'resources/read', params: {} });
           expect(r.error.code).toBe(-32602);
        });

       test('async 路径：handleMessageAsync 同支持 resources/list + resources/read', async () => {
           const s = newServer('1');
           const r1 = await s.handleMessageAsync({ jsonrpc: '2.0', id: 85, method: 'resources/list' });
           expect(Array.isArray(r1.result.resources)).toBe(true);
           const r2 = await s.handleMessageAsync({ jsonrpc: '2.0', id: 86, method: 'resources/read',
                                                  params: { uri: 'l2://agent/codex' } });
           expect(r2.result.uri).toBe('l2://agent/codex');
        });

       test('门控关 → resources 面同样被 gate 拒绝（非侵入一致）', () => {
            const s = newServer('0');
            expect(() => s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }))
                    .toThrow(/gate closed/);
          });
     });
});
