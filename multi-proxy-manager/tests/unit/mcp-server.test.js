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
});
