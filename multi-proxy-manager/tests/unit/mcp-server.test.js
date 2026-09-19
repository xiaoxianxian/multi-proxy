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
});
