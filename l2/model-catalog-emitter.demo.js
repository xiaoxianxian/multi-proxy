// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// model-catalog-emitter demo — 验证 L2 emitter 能正确生成 cc-switch schema 的 catalog
// 冒烟对象：cc-switch 真写的 ~/.codex/cc-switch-model-catalog.json（agnes-3.0-flash 一条，31 字段）
// emitter 产出 31 字段 catalog → 比较字段集 → 验证同构
//
// 不写 ~/.codex/（§3 非侵入），仅生成 + 内存断言
// 门控：CURATOR_CATALOG_EMIT 默认不设 = 本 demo 只生成不写，零文件 IO

const path = require('path');
const fs = require('fs');
const { emitCatalog, emitModel, REASONING_LEVELS } = require('./model-catalog-emitter.js');

let failed = 0;
const check = (cond, msg) => {
    if (cond) {
        console.log('✓ ' + msg);
    } else {
        console.error('✗ ' + msg);
        failed++;
    }
};

console.log('[model-catalog-emitter demo] 对拍 cc-switch 真实 catalog\n');

// ---- 1. 取 cc-switch 真实 catalog 作为对拍基准 ----
const CC_SWITCH_CATALOG_PATH = path.join(process.env.HOME || '/Users/xiaota', '.codex', 'cc-switch-model-catalog.json');
let reference = null;
if (fs.existsSync(CC_SWITCH_CATALOG_PATH)) {
    reference = JSON.parse(fs.readFileSync(CC_SWITCH_CATALOG_PATH, 'utf8'));
    console.log(`  cc-switch catalog: ${CC_SWITCH_CATALOG_PATH}`);
    console.log(`  基准模型数: ${reference.models.length}, 第一条 slug: ${reference.models[0].slug}\n`);
} else {
    console.log('  未找到 cc-switch catalog（可能未装 cc-switch），仅跑 emitter 自校验\n');
}

// ---- 2. 对 cc-switch 的每条模型，喂 emitter 生成同 slug 条目 ----
if (reference && reference.models.length > 0) {
    // cc-switch 字段集
    const refModel = reference.models[0];
    const refKeys = new Set(Object.keys(refModel));

    console.log(`  基准字段集 (${refKeys.size} 个): ${[...refKeys].sort().join(', ')}\n`);

    // 用一条 OpenAI /v1/models 样本 → emitter 补全到 cc-switch 同结构
    const sample = { id: refModel.slug, owned_by: 'Agnes' };
    const emitted = emitModel(sample);
    const emitKeys = new Set(Object.keys(emitted).filter((k) => emitted[k] !== undefined));

    // 字段差异分析
    const onlyInRef = [...refKeys].filter((k) => !emitKeys.has(k));
    const onlyInEmit = [...emitKeys].filter((k) => !refKeys.has(k));

    console.log(`  基准字段: ${refKeys.size} 个`);
    console.log(`  emitter 覆盖: ${[...emitKeys].sort().length} 个（排除 undefined）`);
    console.log(`  基准独有 (${onlyInRef.length}): ${onlyInRef.join(', ') || '(无)'}`);
    console.log(`  emitter 独有 (${onlyInEmit.length}): ${onlyInEmit.join(', ') || '(无)'}`);
    console.log('');

    // 逐字段比对（忽略大文本 / 模型专属字段）
    const IGNORED = new Set(['base_instructions', 'model_messages']);
    const mismatch = [];
    for (const k of refKeys) {
        if (IGNORED.has(k)) continue;
        if (emitted[k] === undefined) continue;
        if (JSON.stringify(emitted[k]) !== JSON.stringify(refModel[k])) {
            mismatch.push(`${k}: emit=${JSON.stringify(emitted[k])} vs ref=${JSON.stringify(refModel[k])}`);
        }
    }

    if (mismatch.length === 0) {
        check(true, `所有非忽略字段值匹配 cc-switch（排除 ${IGNORED.size} 个大文本/专属字段）`);
    } else {
        check(false, `字段值不匹配 ${mismatch.length} 处`);
        mismatch.forEach((x) => console.error('   ' + x));
    }

    check(onlyInRef.length <= 3, `cc-switch 独有字段 ≤3（允许少量版本差异）: ${onlyInRef.join(', ') || '(无)'}`);
}

// ---- 3. 多模型 catalog 生成 ----
const multi = emitCatalog({
    object: 'list',
    data: [
        { id: 'deepseek-v4-flash', owned_by: 'DeepSeek' },
        { id: 'kimi-k2.7-code', owned_by: 'Kimi' },
        { id: 'agnes-3.0-flash', owned_by: 'Agnes' },
        { id: 'moonshot-v1-128k-vision-preview', owned_by: 'Kimi' },
    ],
});
check(multi.models.length === 4, `4 个 /v1/models → 4 条 catalog`);
check(multi.models[0].slug === 'deepseek-v4-flash' && multi.models[3].slug === 'moonshot-v1-128k-vision-preview',
    `按 priority 降序（默认全 1000，按数组序保持）`);
console.log('  生成 model slug: ' + multi.models.map((m) => m.slug).join(', '));

// ---- 4. model_messages 不伪造 ----
check(multi.models[0].model_messages === undefined, `model_messages 不注入 → undefined（不伪造官方指令）`);

// ---- 5. 门控：CURATOR_CATALOG_EMIT 默认不设，demo 不写任何文件 ----
const envGate = process.env.CURATOR_CATALOG_EMIT;
check(envGate === undefined || envGate === '0' || envGate === 'false',
    `CURATOR_CATALOG_EMIT 默认未设 → demo 零文件 IO（门控关）：${JSON.stringify(envGate)}`);
if (failed === 0) {
    console.log('\nALL DEMO CHECKS PASS');
    process.exit(0);
} else {
    console.log(failed + ' CHECK(S) FAILED');
    process.exit(1);
}
