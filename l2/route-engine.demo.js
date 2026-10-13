// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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

    console.log('\n[4] complexity 路由：按难度选模型档位（low→small / high→large）');
    // 注册带 modelTier 的 profile（complexity 路由的落点）
    const registryWithTier = new AgentRegistry();
    registryWithTier.create({
        id: 'agnes-ti', name: 'Agnes small', type: 'custom',
        adapterId: 'agnes', capabilityTags: ['text'], modelTier: 'small',
    });
    registryWithTier.create({
        id: 'qwen-ti', name: 'Qwen large', type: 'custom',
        adapterId: 'qwen', capabilityTags: ['text'], modelTier: 'large',
    });
    const tierEngine = new RouteEngine({ registry: registryWithTier, pluginRuntime, shadowMode: true });
    const lowR = tierEngine.route({ id: 'c-low', type: 'text', complexity: 'low', prompt: '简单翻译' });
    console.log('  low → small:', lowR.chosen ? `${lowR.chosen.adapterId} (tier=${lowR.chosen.modelTier}, match=${lowR.chosen.tierMatch}, conf=${lowR.chosen.confidence})` : 'none');
    const highR = tierEngine.route({ id: 'c-high', type: 'text', complexity: 'high', prompt: '复杂架构设计' });
    console.log('  high→ large:', highR.chosen ? `${highR.chosen.adapterId} (tier=${highR.chosen.modelTier}, match=${highR.chosen.tierMatch}, conf=${highR.chosen.confidence})` : 'none');
    // 向后兼容：旧 profile 无 modelTier，complexity 高也能命中（不降级，仍参与路由）
    const compatR = tierEngine.route({ id: 'c-compat', type: 'text', complexity: 'high', prompt: '', modelType: 'text' });
    console.log('  compat high（无 tier profile）:', compatR.chosen ? `${compatR.chosen.adapterId} (tierMatch=${compatR.chosen.tierMatch})` : 'none');

    console.log('\n[5] 路由日志');
    const logs = engine.getLogs(3);
    console.log(`日志数量: ${logs.length}`);
    for (const log of logs) {
        console.log(`  - ${log.timestamp}: ${log.taskType} → ${log.chosen ? log.chosen.adapterId : 'none'} (${log.action})`);
    }

    console.log('\n[6] 硬规则覆盖（门控 PROXY_ROUTE_HARD_RULES，默认关；此处显式开）');
    const hrEngine = new RouteEngine({ registry: registryWithTier, pluginRuntime, shadowMode: true, hardRules: true });
    const base = { id: 'hr', type: 'text', complexity: 'low', prompt: '简单翻译' };
    const forcedR = hrEngine.route({ ...base, id: 'hr-1', force_provider: 'qwen' });
    console.log(`  force_provider=qwen → chosen=${forcedR.chosen.adapterId}（无规则时是 agnes）`);
    const excludedR = hrEngine.route({ ...base, id: 'hr-2', exclude_providers: ['agnes'] });
    console.log(`  exclude_providers=[agnes] → chosen=${excludedR.chosen.adapterId}`);
    const forceMissR = hrEngine.route({ ...base, id: 'hr-3', force_provider: 'godzilla' });
    console.log(`  force 不在候选 → chosen=${forceMissR.chosen.adapterId}，reason=${forceMissR.hardRule.reason}`);
    const noRuleR = hrEngine.route({ ...base, id: 'hr-4' });
    console.log(`  没写规则（门控开着）→ chosen=${noRuleR.chosen.adapterId}，hardRule 字段存在=${noRuleR.hardRule !== undefined}（应为 false）`);

    console.log('\n[7] shadow 日志算钱（门控 PROXY_ROUTE_SHADOW_COST，默认关；此处显式开）');
    // 价目表由调用方注入（CNY / 百万 token）——引擎不内置价格，此处是 demo 造的示意价。
    const costEngine = new RouteEngine({
        registry: registryWithTier, pluginRuntime, shadowMode: true, shadowCost: true,
        pricing: { agnes: { input: 2, output: 8 }, qwen: { input: 20, output: 80 } },
    });
    const costR = costEngine.route({
        id: 'cost-1', type: 'text', complexity: 'low', prompt: '简单翻译',
        actualProvider: 'qwen', tokens: { promptTokens: 100000, completionTokens: 20000 },
    });
    const c = costR.shadowCost;
    console.log(`  建议 ${c.suggested}（¥${c.suggestedCost}）vs 实际 ${c.baseline}（¥${c.baselineCost}）→ 可省 ¥${c.savings}`);
    console.log(`  汇总: ${JSON.stringify(costEngine.savingsSummary())}`);
    console.log(`  门控关时: shadowCost 字段存在=${tierEngine.route({ ...base, id: 'cost-2' }).shadowCost !== undefined}（应为 false）`);

    console.log('\n✅ Demo complete');
}

main().catch(e => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
