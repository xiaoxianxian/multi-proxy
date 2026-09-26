'use strict';

// L2 Step 5 ·「一切皆插件」bootstrap 真跑验证。
// 全程零副作用：纯内存注册，不写 home / agent 文件、不触网。
// 验收（docs/10-initiatives/02-L2热路径改造计划.md §四 A3 #5）：
//    4. pluginCaps 非空 —— "一切皆插件" 从生产空集变真。
//    5. 新 adapter 无需改 registry 文件即被 route engine 识别。
const assert = require('assert');
const { AgentRegistry } = require('./agent-registry.js');
const { RouteEngine } = require('./route-engine.js');
const { PluginRuntime } = require('./plugin-runtime.js');
const { bootstrapAdapters } = require('./l2-bootstrap.js');

let n = 0;
const ok = (m, a) => { assert(a, m); n += 1; console.log(`PASS ${m}`); };

// ---- 1. bootstrap 3 个 adapter 进 PluginRuntime ----
const { runtime, report } = bootstrapAdapters({ logger: { log: () => {}, warn: () => {} } });
ok('register 3 adapters (aigc/h3web/l1-agent)', report.registered.length === 3);
ok('no adapter failed', report.failed.length === 0);
ok('runtime.count() === 3', runtime.count() === 3);
ok('adapter list aigc,h3web,l1-agent', runtime.list().join(',') === 'aigc,h3web,l1-agent');

// ---- 2. pluginCaps 非空（A3 #5 验收 4）+ 能力形状是对象（route-engine.js:100 期望 cap.capability）----
const caps = runtime.listCapabilities();
ok('pluginCaps non-empty (A3 #5 acceptance #4)', caps.length > 0);
ok('capability object form (cap.capability is string, not flat array)',
    caps.every((c) => typeof c.capability === 'string') &&
    caps.every((c) => typeof c.plugin === 'string'));
ok('aigc image capability present', caps.some((c) => c.plugin === 'aigc' && c.capability === 'image'));

// ---- 3. 新 adapter 无需改 registry 即被 route engine 识别（A3 #5 验收 5）----
// 用空 registry（不注册任何 profile），仅靠 pluginRuntime 的 capability 候选路由。
const emptyRegistry = new AgentRegistry();
const engine = new RouteEngine({ registry: emptyRegistry, pluginRuntime: runtime, shadowMode: true });
// 'matting' 仅 aigc adapter 声明（registry 里没有）→ 候选必须来自 plugin 面。
const decision = engine.route({ id: 'mat-1', type: 'matting', prompt: 'cut out bg' });
const aigcCand = decision.candidates.find((c) => c.adapterId === 'aigc');
ok('route matting → aigc identified via plugin (no registry entry)', !!aigcCand);
ok('aigc candidate source === plugin', aigcCand && aigcCand.source === 'plugin');
ok('chosen aigc without any registry change', decision.chosen && decision.chosen.adapterId === 'aigc');

// 'code' 由 l1-agent（仅经 plugin 注册）承接
const codeDecision = engine.route({ id: 'code-1', type: 'code', prompt: 'fix bug' });
ok('route code → l1-agent via plugin', codeDecision.chosen && codeDecision.chosen.adapterId === 'l1-agent');

// ---- 4. 缺省零回归：不 bootstrap 的 runtime，pluginCaps 恒空（旧行为不变）----
const emptyRuntime = new PluginRuntime({ logger: { log: () => {} } });
const emptyEngine = new RouteEngine({ registry: emptyRegistry, pluginRuntime: emptyRuntime, shadowMode: true });
ok('unbootstrapped runtime → pluginCaps empty (zero regression)', emptyEngine.pluginRuntime.listCapabilities().length === 0);

// ---- 5. 不触网：全程应在毫秒级完成（adapter 网络调用从不被本路径触发）----
const t0 = process.hrtime.bigint();
bootstrapAdapters({ runtime: new PluginRuntime({ logger: { log: () => {} } }), logger: { log: () => {} } });
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
ok(`no network touched (elapsed ${elapsedMs.toFixed(1)}ms < 100ms)`, elapsedMs < 100);

console.log(`\nDEMO: ALL PASS    (${n} checks)`);
