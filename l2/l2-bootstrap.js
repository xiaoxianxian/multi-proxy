'use strict';

// L2 Step 5（A3 #5）·「一切皆插件」bootstrap：把 l2/adapters/*.js 注册进 PluginRuntime。
//
// 现状（架构师 9/23 评审核实，见 docs/10-initiatives/02-L2热路径改造计划.md §一.4）：
//   PluginRuntime 在生产仅被 `new`，全仓无一处 `register(...)` → route-engine.js:66 的
//   pluginCaps 恒 [] →「一切皆插件」候选来源在生产是永久空集。Step 5 把 3 个 L2 adapter
//   接进 PluginRuntime，让 route engine 的 plugin 候选面真正非空。
//
// 形态桥接（关键）：adapter 是「class 导出 + capabilitiesDeclaration()」（见 adapter-protocol.md），
//   而 PluginRuntime 插件契约是普通对象 { name, version, init, start, stop, capabilities }
//   （见 plugin-runtime.js）。本模块把二者桥接——不改 adapter、不改编器文件、不写 agent 文件
//   （非侵入①）；bridge 只实例化 + 读其 capabilitiesDeclaration()，绝不触网（adapter 的网络调用
//   只在 submit/health/result 里，本模块一行都不调）。
//
// 能力形状映射：adapter.capabilitiesDeclaration().capabilities 是扁平字符串数组
//   （如 ['video','image','matting']），而 route-engine.js:100 的 plugin 候选分支期望
//   cap.capability（对象形态）。本模块把字符串映射为 { capability, desc } 对象，使 route engine
//   的 plugin 候选分支能正确取 capability 字串——registry 候选（adapterId 键）不受影响。
//
// 非侵入/可逆/门控：
//   - 纯内存注册；不写任何文件、不碰 agent 文件、不改 adapter 行为。
//   - 单 adapter 注册失败 → 跳过该 adapter 并记录，不阻断其余 adapter 与启动。
//   - 生产接线（routes/mcp.js）只在 PROXY_L2_MCP 门控开时才调用本函数；关 → 不注册，零回归。

const { PluginRuntime } = require('./plugin-runtime.js');
const { AigcAdapter } = require('./adapters/aigc-adapter.js');
const { H3webAdapter } = require('./adapters/h3web-adapter.js');
const { L1AgentAdapter } = require('./adapters/l1-agent-adapter.js');

// 把 adapter 实例包装成一个合规的 PluginRuntime 插件对象。
// 生命周期钩子全部为 no-op async：adapter 是纯能力声明型（无 init/start/stop 语义），
// 不触网、不写盘；unload 时 stop 即 no-op，安全可逆。
function wrapAdapterInstance(adapter, opts = {}) {
  const decl = adapter.capabilitiesDeclaration();
  const rawCaps = Array.isArray(decl.capabilities) ? decl.capabilities : [];
  return {
    name: opts.name || decl.adapter || adapter.id,
    version: typeof decl.version === 'string' ? decl.version : '1.0.0',
    // 能力映射到 { capability, desc } 对象，对齐 route-engine.js 的 plugin 候选分支（cap.capability）。
    capabilities: rawCaps.map((cap, i) => ({
      capability: cap,
      desc: `${adapter.name || adapter.id} adapter 能力 #${i + 1}`,
    })),
    // no-op 生命周期钩子——adapter 无生命周期语义，start/stop 不触网、不写盘。
    init: async () => { /* no-op：adapter 无 init 语义 */ },
    start: async () => { /* no-op：adapter 无 start 语义 */ },
    stop: async () => { /* no-op：adapter 无 stop 语义 */ },
    // 把原 adapter 实例挂上插件对象，供后续真执行/能力查询按需取用（当前 plugin 候选面只读 capability）。
    adapter,
    adapterId: decl.adapter || adapter.id,
    source: 'l2-bootstrap',
    isL2Adapter: true,
  };
}

// 默认 3 个 L2 adapter（与 l2/adapters/ 同构）。
const DEFAULT_ADAPTERS = [
  { name: 'aigc', Adapter: AigcAdapter },
  { name: 'h3web', Adapter: H3webAdapter },
  { name: 'l1-agent', Adapter: L1AgentAdapter },
];

// 把 3 个 adapter 注册进 PluginRuntime（默认 enable + start，使 listCapabilities() 非空）。
// opts.runtime：传入则复用（生产 routes/mcp.js 把建好的 runtime 传进来，避免再 new），
//   缺省则内部 new 一个。返回 { runtime, report }：report = { registered: [], failed: [] }。
//
// 非侵入保证：
//   - 每个 adapter 单独 try/catch：单 adapter 注册失败不阻断其余，也不抛给调用方。
//   - 重名（同名已注册）跳过并记录到 failed，不覆盖已注册的插件。
//   - 不写任何文件、不改 adapter、不触网。
function bootstrapAdapters(opts = {}) {
  const { adapters = DEFAULT_ADAPTERS, logger = console } = opts;
  const runtime = opts.runtime || new PluginRuntime({ logger: { log: () => {} } });
  const report = { registered: [], failed: [] };

  for (const { name, Adapter } of adapters) {
    try {
      // 幂等：同名已注册则跳过（不覆盖、不报错）。
      if (runtime.plugins.has(name)) {
        report.failed.push({ name, reason: 'already-registered' });
        continue;
      }
      const adapter = new Adapter({}); // 空 opts → 默认端口候选（探测惰性，不触网）
      const plugin = wrapAdapterInstance(adapter, { name });
      runtime.register(plugin);
      // 注意：只 register（同步），不主动 enable/start——
      // listCapabilities() 只读 plugin.capabilities（看是否注册到 Map，不看 state），
      // register 即足以让 route-engine.js:66 的 pluginCaps 非空。
      // 不主动 enable/start 避免异步钩子泄漏 open handle；真实启停由调用方按生命周期决定。
      report.registered.push(name);
    } catch (e) {
      report.failed.push({ name, reason: (e && e.message) || String(e) });
      if (logger.warn) logger.warn(`[l2-bootstrap] adapter ${name} bootstrap failed: ${(e && e.message) || e}`);
      else if (logger.log) logger.log(`[l2-bootstrap] adapter ${name} bootstrap failed: ${(e && e.message) || e}`);
    }
  }

  return { runtime, report };
}

module.exports = {
  wrapAdapterInstance,
  bootstrapAdapters,
  DEFAULT_ADAPTERS,
};
