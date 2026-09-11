'use strict';

// jest test for RouteEngine
const { RouteEngine } = require('../../../l2/route-engine');
const { AgentRegistry } = require('../../../l2/agent-registry');
const { PluginRuntime } = require('../../../l2/plugin-runtime');

describe('RouteEngine', () => {
    let registry;
    let pluginRuntime;
    let engine;

    beforeEach(() => {
        registry = new AgentRegistry();
        pluginRuntime = new PluginRuntime({ logger: { log: () => {} } });
        engine = new RouteEngine({ registry, pluginRuntime, shadowMode: true });

        // 注册测试用的 registry entries
        registry.create({
            id: 'h3web-agent',
            name: 'H3web Agent',
            type: 'custom',
            adapterId: 'h3web',
            capabilityTags: ['video', 'text2video', 'image'],
        });
        registry.create({
            id: 'codex-agent',
            name: 'Codex Agent',
            type: 'codex',
            adapterId: 'codex',
            capabilityTags: ['code', 'review'],
        });

        // 注册测试用的 plugin
        pluginRuntime.register({
            name: 'test-plugin',
            capabilities: ['text', 'vision'],
            init: async () => {},
            start: async () => {},
            stop: async () => {},
        });
        pluginRuntime.start('test-plugin');
    });

    test('route video task → h3web', () => {
        const decision = engine.route({ id: 't1', type: 'video', prompt: 'cat' });
        expect(decision.chosen).toEqual({ adapterId: 'h3web', source: 'registry', confidence: 1 });
        expect(decision.shadowMode).toBe(true);
        expect(decision.action).toBe('log-only');
        expect(decision.candidates.length).toBe(2); // h3web + test-plugin
        expect(decision.candidates[0].adapterId).toBe('h3web');
    });

    test('route text task → test-plugin (from plugin)', () => {
        const decision = engine.route({ id: 't2', type: 'text', prompt: 'write' });
        expect(decision.chosen.adapterId).toBe('test-plugin');
    });

    test('route unknown task → returns candidates with confidence 0', () => {
        const decision = engine.route({ id: 't3', type: 'unknown', prompt: 'x' });
        // 未知类型时仍返回候选（confidence=0），但 chosen 仍为 null（因为最高 confidence 是 0）
        expect(decision.candidates.length).toBe(1);
        expect(decision.candidates[0].confidence).toBe(0);
        // chosen 应该还是 mock-plugin（最高 confidence），只是 confidence 是 0
        // 这个行为是合理的：router 不知道哪个 adapter 适合，但仍展示候选
    });

    test('shadowMode=true logs only, does not execute', () => {
        const decision = engine.route({ id: 't4', type: 'video', prompt: 'cat' });
        expect(decision.action).toBe('log-only');
    });

    test('shadowMode=false sets action=execute when candidate exists', () => {
        engine.setShadowMode(false);
        const decision = engine.route({ id: 't5', type: 'video', prompt: 'cat' });
        expect(decision.action).toBe('execute');
    });

    test('batchRoute routes multiple tasks', () => {
        const results = engine.batchRoute([
            { id: 'b1', type: 'video', prompt: 'a' },
            { id: 'b2', type: 'text', prompt: 'b' },
        ]);
        expect(results).toHaveLength(2);
        expect(results[0].chosen.adapterId).toBe('h3web');
        expect(results[1].chosen.adapterId).toBe('test-plugin');
    });

    test('getLogs returns recent decisions', () => {
        engine.route({ id: 'l1', type: 'video', prompt: 'x' });
        engine.route({ id: 'l2', type: 'text', prompt: 'y' });
        const logs = engine.getLogs(1);
        expect(logs).toHaveLength(1);
        expect(logs[0].taskId).toBe('l2');
    });

    test('clearLogs empties log', () => {
        engine.route({ id: 'c1', type: 'video', prompt: 'x' });
        engine.clearLogs();
        expect(engine.getLogs()).toHaveLength(0);
    });

    test('throws if task.type missing', () => {
        expect(() => engine.route({ id: 'e1' })).toThrow('task.type required');
    });

    test('candidates sorted by confidence desc', () => {
        const decision = engine.route({ id: 't6', type: 'video', prompt: 'x' });
        // h3web has confidence 1, test-plugin has confidence 0
        expect(decision.candidates[0].confidence).toBeGreaterThanOrEqual(decision.candidates[1].confidence);
    });
});
