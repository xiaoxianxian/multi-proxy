'use strict';

// G3 demo：per-agent 预算分桶 —— 单 agent 失控不能拖垮全局
// 用法：node l2/budget-buckets/budget-buckets.demo.js
const { createBudgetBuckets } = require('./budget-buckets.js');

const entry = (agentId, cost) => ({
    agentId,
    actualTier: 'large',
    actualCost: cost,
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    ts: Date.now(),
});

const bb = createBudgetBuckets({
    config: {
        default: { hardCap: 0 },                 // 兜底桶：不拦
        buckets: {
            claude: { hardCap: 0.2 },            // Claude 限 0.2
            codex:  { hardCap: 1.0 },            // Codex 限 1.0
        },
    },
});

console.log('--- 每笔 0.096，Claude 桶 hardCap=0.2，Codex 桶 hardCap=1.0 ---');
for (let i = 1; i <= 4; i++) {
    const r = bb.record(entry('claude', 0.096), { now: i * 1000 });
    console.log(`Claude #${i}: level=${r.level} block=${r.block} cum=${r.cumulative} bucket=${r.bucketId}`);
}
for (let i = 1; i <= 2; i++) {
    const r = bb.record(entry('codex', 0.096), { now: 1000 + i * 1000 });
    console.log(`Codex  #${i}: level=${r.level} block=${r.block} cum=${r.cumulative} bucket=${r.bucketId}`);
}
const st = bb.state({ now: 9999 });
console.log('--- 聚合 ---');
console.log('aggregate:', st.aggregate);
console.log('per-bucket level:', Object.fromEntries(Object.entries(st.per).map(([k, v]) => [k, v.level])));
console.log('shouldBlock(claude 已超限):', bb.shouldBlock(entry('claude', 0), { now: 9999 }));
console.log('shouldBlock(codex 未超限):', bb.shouldBlock(entry('codex', 0), { now: 9999 }));
console.log('unknown caller → default 桶不拦:', bb.shouldBlock(entry('unknown-agent', 0), { now: 9999 }));
