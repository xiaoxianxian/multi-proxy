'use strict';
// Curator pack · engine（M3 · 零改核心，按 07-curator-pack-TASKS.md M3 实测版）
//
// 三条实测结论（07 §0）：
//   修正 1：不重新 applyPack（抛 policy already registered，token-policy.js:95-97）；
//           保存 applyPack 返回的 policy 引用数组，翻转 p.enabled 开关/回滚。
//   修正 2：自建实例 createTokenPolicy()，不用模块单例（module.exports 没导 _policies/_runHistory）。
//   确认 3：gate 不阻塞 apply，开关只看 p.enabled，不需设 PROXY_TOKEN_POLICY 环境变量。
//   修正 4：apply 必须传 ctx.agentType，否则 appliesTo 不命中被静默跳过。
//
// 非侵入铁律④：pack 默认 enabled:false，未 enable 时 0 行为变更、不触 net、不写 agent 文件。

const { createTokenPolicy } = require('../../l2/token-policy');
const { createContextFold } = require('../../l2/context-fold.js');

// C4 用的秤（与 policies/*.js 的 ledger 同一把，口径一致）
const _fold = createContextFold();

// 5 个 passthrough handler（M2）。映射 06 §3：
//   Memory→onHistory, Planning→onRoute, Capability→onToolOutput, Action→onResponse, Prompt→onRequestAssemble
const POLICY_FILES = [
     { hook: 'onHistory',        file: 'memory-history' },
     { hook: 'onRoute',          file: 'planning-route' },
     { hook: 'onToolOutput',     file: 'capability-tool' },
     { hook: 'onResponse',       file: 'action-response' },
     { hook: 'onRequestAssemble',file: 'prompt-assemble' },
   ];

// M1 manifest（pack.yaml 的 JS 等价；引擎读 JS 不读 yaml，见 M1 验收注）
function defaultManifest(opts = {}) {
  const appliesTo = opts.appliesTo || ['coding', 'aigc', 'research']; // AGENT_TYPES 子集（token-policy.js:52）
  return {
    name: 'curator',
    enabled: false,             // 默认关（铁律④）
    appliesTo,
    // 默认挂上 5 个 passthrough handler；opts.hooks 可覆盖/追加
    hooks: opts.hooks || buildPassthroughHooks(),
  };
}

// 从 policies/ 加载 5 个 passthrough handler，组装成 pack 的 hooks
function buildPassthroughHooks() {
  const hooks = {};
  for (const { hook, file } of POLICY_FILES) {
    const mod = require(`./policies/${file}.js`);
    const fn = mod.handler || mod;
    if (typeof fn !== 'function') throw new Error(`policy ${file} 无 handler 函数`);
    if (!hooks[hook]) hooks[hook] = [];
   hooks[hook].push({ name: file, handler: fn });
  }
  return hooks;
}

// 候选变更集的机械校验（M6：受限、可读、可 assert；不改核心结构）
// 仅允许改 policies/*.js 暴露的 params 数值（如 keepLastN），不放宽。
const CHANGE_VALIDATORS = {
  keepLastN: (n) => Number.isInteger(n) && n > 0 && n <= 20, // 0 < keepLastN <= 20（07 M6 例）
  maxOutputChars: (n) => Number.isInteger(n) && n > 0 && n <= 20000,
  perPolicyMaxRatio: (r) => Number.isFinite(r) && r > 0 && r <= 1,
  // C4：scenePrefix 是 pack 唯一的注入口，必须走受限变更通道（有校验 + 有快照），
  // 不容许绕过 applyChange 直接改 params 后无人知晓——那样第七类就称不到它。
  scenePrefix: (s) => typeof s === 'string' && s.length <= 4000,

  // ---- 真改写类变更（本轮新增）：只放开数值/枚举，不放开结构 ----
  maxMsgChars: (n) => Number.isInteger(n) && n > 0 && n <= 20000,
  foldToolOutput: (b) => typeof b === 'boolean',
  headChars: (n) => Number.isInteger(n) && n > 0 && n <= 20000,
  tailChars: (n) => Number.isInteger(n) && n > 0 && n <= 20000,
  // 只认两种枚举值：更激进的精简会改变用户看到的内容，不给开口子
  simplify: (s) => s === 'pass' || s === 'whitespace',
};

// C4：收集本 pack 各 policy 声明的注入，喂进 context-fold 的第七类。
// 约定：policy 模块可选导出 injections() → [{ sink:'skill'|'inject', text }]；
// 没导出就是不注入。新增 policy 想入账只需自己实现这个函数，不动本文件。
function collectInjections() {
  const out = [];
  for (const { file } of POLICY_FILES) {
    const mod = require(`./policies/${file}.js`);
    if (typeof mod.injections !== 'function') { continue; }
    for (const inj of mod.injections() || []) {
      out.push({
        sink: inj.sink === 'inject' ? 'inject' : 'skill',
        source: 'curator-pack',
        text: inj.text,
        tokens: inj.tokens,
      });
    }
  }
  return out;
}

function createCurator(opts = {}) {
  const tp = createTokenPolicy({ gate: false });       // 工厂实例（修正 2），不需 env（确认 3）
  const manifest = defaultManifest(opts);
  // ⚠️ 关键：保存 applyPack 返回的 policy 引用数组（修正 1：靠它开关/回滚）
  const refs = tp.applyPack(manifest);
   const snapshots = [];                                // M4 快照栈

  function snapshot() {
    const s = {
      ts: Date.now(),
      policies: refs.map((p) => ({ hook: p.hook, name: p.name, enabled: p.enabled })),
     };
    snapshots.push(s);
    return s;
  }
  function restore(snap) {
    if (!snap) return 0;
    let n = 0;
    for (const p of refs) {
      const rec = snap.policies.find((x) => x.name === p.name);
      if (rec) { p.enabled = rec.enabled; n += 1; }
    }
    return n;
  }

  // M6 受限变更：校验通过才改 params 并 enable 目标 policy
  function applyChange(hookName, changeName, value) {
   const policyInfo = POLICY_FILES.find((x) => x.hook === hookName);
    if (!policyInfo) return { installed: false, reason: 'no-policy' };
    const validator = CHANGE_VALIDATORS[changeName];
    if (!validator) return { installed: false, reason: 'unknown-change' };
    if (!validator(value)) return { installed: false, reason: 'rejected-by-assert' };
    snapshot();                                          // 安装前快照
    // 改 params 在模块对象上(require cache 返回同一模块 → handler 闭包立即响应)
    const mod = require(`./policies/${policyInfo.file}.js`);
    mod.params[changeName] = value;
    const target = refs.find((p) => p.hook === hookName);
    if (target) target.enabled = true;                    // 改完 params 才 enable
    return { installed: true, change: changeName, value, hook: hookName };
  }

  return {
    instance: tp,
    refs,
    snapshot,
    restore,
    applyChange,
    enable() { refs.forEach((p) => { p.enabled = true; }); return refs.length; },
    disable() { refs.forEach((p) => { p.enabled = false; }); return refs.length; },
    state: () => refs.map((p) => ({ hook: p.hook, name: p.name, enabled: p.enabled })),
    policies: () => tp.listPolicies({}),
    observe: () => tp.report(opts.windowMs),
    apply: (hook, ctx) => tp.apply(hook, ctx),
    // C4：把本 pack 的注入接进七类坐标系。pack 全关 → 不注入 → 第七类归零。
    // 这样「pack 开/关两态第七类之差」就是注入净增量，可直接 assert。
    fold: (request = {}, o = {}) => _fold.fold(request, Object.assign({}, o, {
      injections: refs.some((p) => p.enabled) ? collectInjections() : [],
    })),
    injections: collectInjections,
    manifest,
  };
}

module.exports = { createCurator, defaultManifest, CHANGE_VALIDATORS, POLICY_FILES };
