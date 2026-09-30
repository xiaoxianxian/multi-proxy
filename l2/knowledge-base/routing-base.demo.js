'use strict';

// 共享底座 routing-base · 正向 + 反向用例（质量工程 §三，落点 2）
// 真跑：node l2/knowledge-base/routing-base.demo.js
//
// 覆盖：
//   单一事实源：decomposer 消费的模板 === routing-base 当前模板（同一引用）
//   mapTier：low→small / high→large / medium与未知→medium（与原 _mapTier 硬编码一致）
//   adapterDefaults：claude / l1-agent 声明与原硬编码一致；未知 id → null
//   版本快照：update → version+1 且模板实时生效（decomposer 拆解走新模板）
//   回滚：rollback → 回到上一版，拆解行为恢复；空历史 rollback → null

const assert = require('assert');
const { ROUTING_BASE, mapTier, adapterDefaults, update, rollback, history } = require('./routing-base.js');
const { templateDecompose, BUILTIN_TEMPLATES, FALLBACK_TEMPLATE } = require('../decomposer.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('单一事实源：');
ok('decomposer.BUILTIN_TEMPLATES === ROUTING_BASE.templates（同一引用，非拷贝）',
    BUILTIN_TEMPLATES === ROUTING_BASE.templates);
ok('decomposer.FALLBACK_TEMPLATE === ROUTING_BASE.fallback',
    FALLBACK_TEMPLATE === ROUTING_BASE.fallback);
ok('初始版本 v1、含两个内置模板',
    ROUTING_BASE.version === 1 && ROUTING_BASE.templates.length === 2 &&
    ROUTING_BASE.templates.map((t) => t.name).join(',') === 'fastapi-jwt,video-workflow');

console.log('mapTier（与原 route-engine._mapTier 硬编码逐字一致）：');
ok("low → 'small'", mapTier('low') === 'small');
ok("high → 'large'", mapTier('high') === 'large');
ok("medium → 'medium'", mapTier('medium') === 'medium');
ok("未知 complexity → 'medium'（保守默认）", mapTier('unknown') === 'medium' && mapTier(undefined) === 'medium');

console.log('adapterDefaults（与原 adapter 硬编码逐字一致）：');
const cd = adapterDefaults('claude');
ok("claude.capabilities === ['code','writing']", cd && cd.capabilities.length === 2 &&
    cd.capabilities[0] === 'code' && cd.capabilities[1] === 'writing');
ok("claude.defaultModel === 'claude-3-5-sonnet-latest'", cd && cd.defaultModel === 'claude-3-5-sonnet-latest');
const ld = adapterDefaults('l1-agent');
ok("l1-agent.defaultModel === 'default'", ld && ld.defaultModel === 'default');
ok('未知 adapterId → null（不臆造）', adapterDefaults('nonexistent') === null);

console.log('版本快照 + 实时生效 + 回滚：');
// ① update：加一个 sum 模板 → version+1、历史留痕、decomposer 实时走新模板
const v2 = update({
    templates: [...ROUTING_BASE.templates, {
        name: 'sum',
        match: (input) => /求和|sum/i.test(input),
        build: (input) => [{ id: 'calc', type: 'code', complexity: 'low', prompt: `计算 ${String(input).slice(0, 20)}`, deps: [] }],
    }],
}, 'demo：新增 sum 模板');
ok('update 返回 version 2 且当前 version 同步', v2 === 2 && ROUTING_BASE.version === 2);
ok('历史留痕 v1', history().length === 1 && history()[0].version === 1);
const dagSum = templateDecompose('帮我做个 sum 汇总');
ok('decomposer 实时走新模板（sum 命中 calc 节点）',
    dagSum.template === 'sum' && dagSum.subtasks.length === 1 && dagSum.subtasks[0].id === 'calc');

// ② rollback：回 v1 → sum 模板消失、拆解恢复原行为
const vBack = rollback();
ok('rollback 返回 v1', vBack === 1 && ROUTING_BASE.version === 1);
const dagSumAfter = templateDecompose('帮我做个 sum 汇总');
ok('回滚后 sum 不再命中（走兜底 single）', dagSumAfter.template === 'single');
const dagJwt = templateDecompose('做一个 jwt 认证');
ok('回滚后原模板行为不变（jwt 仍命中 fastapi-jwt）',
    dagJwt.template === 'fastapi-jwt' && dagJwt.subtasks.length === 4);

// ③ rollback 原子性：一次 rollback 只回一版；空历史 rollback → null
ok('空历史 rollback → null', rollback() === null);

// ④ adapterDefaults 可经 update 换挡（一处改多端生效），再回滚
update({ adapterDefaults: { claude: { capabilities: ['code', 'writing', 'vision'], defaultModel: 'claude-opus-4-6' } } }, 'demo：claude 换挡');
ok('update 后 adapterDefaults 新值生效', adapterDefaults('claude').defaultModel === 'claude-opus-4-6');
rollback();
ok('回滚后 claude 默认模型恢复', adapterDefaults('claude').defaultModel === 'claude-3-5-sonnet-latest');

// ⑤ 反向：update 无参 / 非对象 → 拒绝
let threw = false;
try { update(null); } catch { threw = true; }
ok('update(null) 拒绝', threw);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
