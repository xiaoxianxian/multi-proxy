// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 收费确认闸门（charge-confirm）— savings-gateway 执行层「强制确认」
//
// 把 MoneyPrinterTurbo SKILL.md 的「*_CHARGE_CONFIRMATION_REQUIRED 协议」落成开源网关的硬约束：
//   agent 绝不能静默加 confirm 旗标；只有用户显式批准后（请求里带 X-Charge-Confirm）才放行付费路由。
//
// 与 savings-gateway 现有「统计层省账」互补：
//   - 统计层（gateway.js 的 x_savings.saved）只记账「省了多少」；
//   - 本闸门在执行层「拦截」——未确认就真打付费上游前直接 402 挡下。
//
// 非侵入铁律（与 gateway.js / server.js / alert.js / cost.js 同构）：
//   - 独立 kernel，零依赖（仅 node 内置）；
//   - 默认不接入 = 网关零行为变更（server 仅在 PROXY_SAVINGS_CHARGE_CONFIRM=1 时构造并注入）；
//   - shadow 模拟模式不真花钱 → 永远不要求确认（与「模拟=免费」一致）；
//   - 只产判定结果，不落盘、不写 env、不触上游。

// 默认付费适配器（medium=deepseek / large=qwen 的模拟基线价 >0）。
// agnes(small) 免费档不在此列 → 永远不需要确认。
const DEFAULT_PAID_ADAPTERS = ['deepseek', 'qwen'];

/**
 * 构造收费确认闸门。
 * @param {object} [opts]
 * @param {string[]} [opts.paidAdapters] 显式付费适配器名单（覆盖默认）。
 * @param {boolean}  [opts.usePricingBaseline=true] 是否把「模拟基线价 > 0」也算付费。
 * @returns {{ evaluate: Function, isPaidRoute: Function, paidAdapters: Function }}
 */
function createChargeConfirmGate(opts = {}) {
    const paid = new Set(
        (Array.isArray(opts.paidAdapters) && opts.paidAdapters.length)
            ? opts.paidAdapters
            : DEFAULT_PAID_ADAPTERS
    );
    // 默认 true：模拟基线价 >0 的路由也视为付费（与 DEFAULT_PRICING 一致）。
    // 设 false 则只看 paidAdapters 名单，不看价表（适合「价表是估算、名单才是真相」的部署）。
    const useBaseline = opts.usePricingBaseline !== false;

    // 是否为付费路由（只看路由结果，不关心是否已确认）。
    // estimatedCost 可能是 null（单价 unknown）——null 不是 >0，不靠基线触发，
    // 但 adapterId 若在付费名单里仍触发（operator 对 unknown 价保守处理：列进名单即可拦）。
    function isPaidRoute({ adapterId, estimatedCost }) {
        if (paid.has(adapterId)) return true;
        if (useBaseline && Number.isFinite(estimatedCost) && estimatedCost > 0) return true;
        return false;
    }

    // 核心判定：返回结构化结论，供 gateway 抛 402 或放行。
    //   { required, confirmed, adapterId, estimatedCost, reason }
    // - required=false：免费 / 模拟 → 直接放行（不拦）
    // - required=true && confirmed=true：用户已批准 → 放行
    // - required=true && confirmed=false：拦截，要求客户端带确认旗标（gateway 抛 402）
    function evaluate({ adapterId, estimatedCost, confirmed, shadow }) {
        // shadow 模拟模式不真打上游、不花钱 → 不要求确认（与 MPT：模拟=免费一致）
        if (shadow) {
            return { required: false, confirmed: false, adapterId, estimatedCost: null, reason: 'shadow-sim-no-charge' };
        }
        const paidRoute = isPaidRoute({ adapterId, estimatedCost });
        if (!paidRoute) {
            return { required: false, confirmed: false, adapterId, estimatedCost, reason: 'free-route' };
        }
        const ok = confirmed === true;
        return {
            required: true,
            confirmed: ok,
            adapterId,
            estimatedCost,
            reason: ok ? 'approved' : 'charge-confirmation-required',
        };
    }

    return {
        evaluate,
        isPaidRoute,
        paidAdapters: () => [...paid],
    };
}

module.exports = { createChargeConfirmGate, DEFAULT_PAID_ADAPTERS };
