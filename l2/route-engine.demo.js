'use strict';

// Route Engine Demo — 演示按能力路由
// 用法：node l2/route-engine.demo.js

const { RouteEngine } = require('./route-engine');
const { AgentRegistry } = require('./agent-registry');
const { PluginRuntime } = require('./plugin-runtime');
const { H3webAdapter } = require('./adapters/h3web-adapter');

async function main() {
    console.log('=== Route Engine Demo ===\n');

    // 初始化内核
    const registry = new AgentRegistry();
    const pluginRuntime = new PluginRuntime({ logger: { log: () => {} } });

    // 注册 h3web adapter
    const h3web = new H3webAdapter({ id: 'h3web', port: 18799 }); // mock 端口
    registry.create({
        id: 'h3web-agent',
        name: 'H3web Agent',
        type: 'custom',
        adapterId: 'h3web',
        capabilityTags: ['video', 'text2video', 'image'],
    });

    // 注册 mock plugin
    pluginRuntime.register({
        name: 'mock-plugin',
        capabilities: ['text', 'vision'],
        init: async () => {},
        start: async () => {},
        stop: async () => {},
    });
    await pluginRuntime.enable('mock-plugin');
    await pluginRuntime.start('mock-plugin');

    // 初始化 Route Engine（shadow 模式）
    const engine = new RouteEngine({ registry, pluginRuntime, shadowMode: true });

    console.log('[1] 路由视频生成任务');
    const videoRoute = engine.route({
        id: 'task-001',
        type: 'video',
        prompt: '一只猫坐在窗台上看雨',
    });
    console.log(JSON.stringify(videoRoute, null, 2));

    console.log('\n[2] 路由文本任务');
    const textRoute = engine.route({
        id: 'task-002',
        type: 'text',
        prompt: '帮我写一首诗',
    });
    console.log(JSON.stringify(textRoute, null, 2));

    console.log('\n[3] 路由未知任务');
    const unknownRoute = engine.route({
        id: 'task-003',
        type: 'unknown',
        prompt: '测试',
    });
    console.log(JSON.stringify(unknownRoute, null, 2));

    console.log('\n[4] 路由日志');
    const logs = engine.getLogs(3);
    console.log(`日志数量: ${logs.length}`);
    for (const log of logs) {
        console.log(`  - ${log.timestamp}: ${log.taskType} → ${log.chosen ? log.chosen.adapterId : 'none'} (${log.action})`);
    }

    console.log('\n✅ Demo complete');
}

main().catch(e => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
