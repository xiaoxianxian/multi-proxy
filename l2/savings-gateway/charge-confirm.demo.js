// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 收费确认闸门 Demo — 证明执行层「强制确认」四条核心路径（全确定性、零依赖）
// 用法：node l2/savings-gateway/charge-confirm.demo.js

const { createChargeConfirmGate, DEFAULT_PAID_ADAPTERS } = require('./charge-confirm.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function demo() {
    console.log('=== Charge-Confirm Gate Demo（执行层强制确认 · MPT 契约落地）===\n');

    const gate = createChargeConfirmGate(); // 默认付费名单 deepseek/qwen
    console.log('[1] 默认配置');
    check('付费名单含 deepseek / qwen', gate.paidAdapters().includes('deepseek') && gate.paidAdapters().includes('qwen'), JSON.stringify(gate.paidAdapters()));
    check('agnes(small) 不在付费名单', !gate.paidAdapters().includes('agnes'));

    console.log('\n[2] 免费路由 → 直接放行（不拦）');
    // agnes(small) 免费档，无论确认与否都不拦
    const freeNo = gate.evaluate({ adapterId: 'agnes', estimatedCost: 0, confirmed: false, shadow: false });
    check('agnes + 未确认 → required=false（放行）', freeNo.required === false && freeNo.reason === 'free-route', JSON.stringify(freeNo));
    const freeYes = gate.evaluate({ adapterId: 'agnes', estimatedCost: 0, confirmed: true, shadow: false });
    check('agnes + 已确认 → required=false（放行）', freeYes.required === false);

    console.log('\n[3] shadow 模拟模式 → 不真花钱，不要求确认（与 MPT：模拟=免费一致）');
    const simPaid = gate.evaluate({ adapterId: 'deepseek', estimatedCost: 0.003, confirmed: false, shadow: true });
    check('deepseek + shadow + 未确认 → required=false（模拟不拦）', simPaid.required === false && simPaid.reason === 'shadow-sim-no-charge', JSON.stringify(simPaid));

    console.log('\n[4] 付费路由 + 真实执行(shadow=false) + 未确认 → 拦截(402)');
    const blocked = gate.evaluate({ adapterId: 'deepseek', estimatedCost: 0.003, confirmed: false, shadow: false });
    check('required=true', blocked.required === true);
    check('confirmed=false', blocked.confirmed === false);
    check('reason=charge-confirmation-required（网关据此抛 402）', blocked.reason === 'charge-confirmation-required', JSON.stringify(blocked));
    // large 档（simulated 基线价 32/128 >0）也拦
    const blockedLarge = gate.evaluate({ adapterId: 'qwen', estimatedCost: 0.096, confirmed: false, shadow: false });
    check('qwen(large) + 未确认 → required=true（基线价>0 也算付费）', blockedLarge.required === true);

    console.log('\n[5] 付费路由 + 真实执行 + 已确认 → 放行');
    const approved = gate.evaluate({ adapterId: 'deepseek', estimatedCost: 0.003, confirmed: true, shadow: false });
    check('required=true 但 confirmed=true → reason=approved（放行）', approved.required === true && approved.confirmed === true && approved.reason === 'approved', JSON.stringify(approved));

    console.log('\n[6] 单价 unknown（estimatedCost=null）但 adapter 在付费名单 → 仍拦（保守）');
    const unknown = gate.evaluate({ adapterId: 'qwen', estimatedCost: null, confirmed: false, shadow: false });
    check('qwen + unknown 价 + 未确认 → required=true（名单兜底拦截）', unknown.required === true, JSON.stringify(unknown));
    const unknownFree = gate.evaluate({ adapterId: 'agnes', estimatedCost: null, confirmed: false, shadow: false });
    check('agnes + unknown 价 → required=false（免费档不拦）', unknownFree.required === false);

    console.log('\n[7] 可配置付费名单（PROXY_SAVINGS_PAID_ADAPTERS 覆盖语义）');
    const custom = createChargeConfirmGate({ paidAdapters: ['minimax'] });
    check('自定义名单只含 minimax', JSON.stringify(custom.paidAdapters()) === JSON.stringify(['minimax']));
    // 默认 baseline=true：deepseek 基线价>0 仍被基线兜底拦（名单之外但价>0）
    check('自定义名单 + baseline 默认开 → deepseek(价>0) 仍拦（基线兜底）', custom.evaluate({ adapterId: 'deepseek', estimatedCost: 0.003, confirmed: false, shadow: false }).required === true);
    // 想让名单成「纯白名单」语义 → 显式关 baseline
    const customStrict = createChargeConfirmGate({ paidAdapters: ['minimax'], usePricingBaseline: false });
    check('minimax 在名单 → 拦', customStrict.evaluate({ adapterId: 'minimax', estimatedCost: 0, confirmed: false, shadow: false }).required === true);
    check('名单外 deepseek(价>0) + baseline 关 → 不拦（纯白名单）', customStrict.evaluate({ adapterId: 'deepseek', estimatedCost: 0.003, confirmed: false, shadow: false }).required === false);

    console.log('\n[8] usePricingBaseline=false → 只看名单、不看价表');
    const onlyList = createChargeConfirmGate({ usePricingBaseline: false });
    check('deepseek 在名单仍拦', onlyList.evaluate({ adapterId: 'deepseek', estimatedCost: 0, confirmed: false, shadow: false }).required === true);
    // 假设有个「价>0 但 operator 不想拦」的档：baseline 关掉后只认名单
    const onlyList2 = createChargeConfirmGate({ paidAdapters: ['qwen'], usePricingBaseline: false });
    check('不在名单的付费价档不拦（baseline 关）', onlyList2.evaluate({ adapterId: 'deepseek', estimatedCost: 999, confirmed: false, shadow: false }).required === false);

    console.log(`\n[Charge-Confirm demo] PASS ${pass} / ${pass + fail}`);
    process.exit(fail === 0 ? 0 : 1);
}

demo().catch((e) => { console.error('FATAL', e); process.exit(1); });
