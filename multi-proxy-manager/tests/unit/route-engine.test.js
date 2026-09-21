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
        expect(decision.chosen).toMatchObject({ adapterId: 'h3web', source: 'registry', confidence: 1 });
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
        // also verify modelTypeMatch field exists
        expect(decision.candidates[0]).toHaveProperty('modelTypeMatch');
     });

     // ---- complexity 路由（complexity→modelTier 档位，见 l2/COMPLEXITY-MODE.md）----
     // 用局部 registry/engine，不污染 beforeEach 的共享 setup（保证上面 10 个 test 不变）

    test('complexity low routes to small tier profile', () => {
        const reg = new AgentRegistry();
        reg.create({ id: 'agnes', name: 'Agnes', type: 'custom', adapterId: 'agnes', capabilityTags: ['text'], modelTier: 'small' });
        reg.create({ id: 'qwen', name: 'Qwen', type: 'custom', adapterId: 'qwen', capabilityTags: ['text'], modelTier: 'large' });
        const e = new RouteEngine({ registry: reg, pluginRuntime, shadowMode: true });
        const d = e.route({ id: 'x1', type: 'text', complexity: 'low', prompt: 'translate' });
        expect(d.chosen).toMatchObject({ adapterId: 'agnes', tierMatch: true, modelTier: 'small' });
        expect(d.expectedTier).toBe('small');
     });

    test('complexity high routes to large tier profile (no downgrade)', () => {
        const reg = new AgentRegistry();
        reg.create({ id: 'agnes', name: 'Agnes', type: 'custom', adapterId: 'agnes', capabilityTags: ['text'], modelTier: 'small' });
        reg.create({ id: 'qwen', name: 'Qwen', type: 'custom', adapterId: 'qwen', capabilityTags: ['text'], modelTier: 'large' });
        const e = new RouteEngine({ registry: reg, pluginRuntime, shadowMode: true });
        const d = e.route({ id: 'x2', type: 'text', complexity: 'high', prompt: 'arch design' });
        expect(d.chosen).toMatchObject({ adapterId: 'qwen', tierMatch: true, modelTier: 'large' });
        expect(d.expectedTier).toBe('large');
     });

    test('legacy profile without modelTier still routes on complexity (backward compat)', () => {
        const reg = new AgentRegistry();
         // 旧 profile：有 capabilityTags、无 modelTier。type 'code' 不被 plugin（text/vision）命中，保证 chosen 唯一
        reg.create({ id: 'codex-old', name: 'Codex old', type: 'codex', adapterId: 'codex', capabilityTags: ['code'] });
        const e = new RouteEngine({ registry: reg, pluginRuntime, shadowMode: true });
        const d = e.route({ id: 'x3', type: 'code', complexity: 'high', prompt: 'x' });
         // tierMatch=false（旧 profile 无 tier 不参与档位加分），但照样选中（不降级、不漏路由）
        expect(d.chosen).toMatchObject({ adapterId: 'codex', tierMatch: false });
        expect(d.chosen.modelTier).toBeNull();
     });

    test('unknown/absent complexity maps to medium tier (conservative, no downgrade)', () => {
        const reg = new AgentRegistry();
        reg.create({ id: 'agnes', name: 'Agnes', type: 'custom', adapterId: 'agnes', capabilityTags: ['text'], modelTier: 'small' });
        reg.create({ id: 'med', name: 'Med', type: 'custom', adapterId: 'med', capabilityTags: ['text'], modelTier: 'medium' });
        reg.create({ id: 'qwen', name: 'Qwen', type: 'custom', adapterId: 'qwen', capabilityTags: ['text'], modelTier: 'large' });
        const e = new RouteEngine({ registry: reg, pluginRuntime, shadowMode: true });
        const d = e.route({ id: 'x4', type: 'text', prompt: 'no complexity field' });
        expect(d.expectedTier).toBe('medium');
        expect(d.chosen).toMatchObject({ adapterId: 'med', tierMatch: true, modelTier: 'medium' });
     });

     // ---- log_redaction 三档（默认 full = 现状，门控默认关不改变行为）----
     // 局部 engine，不污染共享 setup

    test('log_redaction default is full (status quo: 50-char truncation, zero behavior change)', () => {
        const reg = new AgentRegistry();
        reg.create({ id: 'h', name: 'H', type: 'custom', adapterId: 'h', capabilityTags: ['text'] });
        const e = new RouteEngine({ registry: reg, pluginRuntime, shadowMode: true });
        // 默认档 = full：长 prompt 截前 50 字
        const d = e.route({ id: 'r1', type: 'text', prompt: 'x'.repeat(200) });
        expect(d.taskPrompt).toHaveLength(50);
        // 非字符串 prompt → '...'（现状不变）
        const d2 = e.route({ id: 'r2', type: 'text', prompt: 12345 });
        expect(d2.taskPrompt).toBe('...');
        // 无 prompt → null（现状不变）
        const d3 = e.route({ id: 'r3', type: 'text' });
        expect(d3.taskPrompt).toBeNull();
     });

    test('log_redaction metadata_only: 不记正文，只留元数据', () => {
        const reg = new AgentRegistry();
        reg.create({ id: 'h', name: 'H', type: 'custom', adapterId: 'h', capabilityTags: ['text'] });
        const e = new RouteEngine({ registry: reg, pluginRuntime, shadowMode: true });
        e.setLogRedaction('metadata_only');
        const d = e.route({ id: 'r4', type: 'text', prompt: 'secret content here' });
        expect(typeof d.taskPrompt).toBe('object');
        expect(d.taskPrompt.hasPrompt).toBe(true);
        expect(d.taskPrompt.length).toBe('secret content here'.length);
        expect(JSON.stringify(d.taskPrompt)).not.toContain('secret'); // 正文不进日志
     });

    test('log_redaction off: taskPrompt 完全不记', () => {
        const reg = new AgentRegistry();
        reg.create({ id: 'h', name: 'H', type: 'custom', adapterId: 'h', capabilityTags: ['text'] });
        const e = new RouteEngine({ registry: reg, pluginRuntime, shadowMode: true });
        e.setLogRedaction('off');
        const d = e.route({ id: 'r5', type: 'text', prompt: 'secret content here' });
        expect(d.taskPrompt).toBeNull();
     });
});
