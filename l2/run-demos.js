// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// run-demos — L2 demo 跑批脚本（质量工程 §四 落点 3）。
//
// 用法：
//   node run-demos.js                        # 全量回归（所有 *.demo.js）
//   node run-demos.js --impact adapter:claude    # 只跑受 adapter "claude" 改动影响的用例
//   node run-demos.js --impact template:fastapi-jwt
//   node run-demos.js --impact tier
//   node run-demos.js --impact core          # fail-closed：全量
//
// 影响半径判定可解释：输出「本次改动影响 N 个用例文件: [...]」+ 原因，不是黑盒。
// 覆盖完整保证：未登记 tag 的 demo 文件 → fail-closed 必跑并告警（不漏测）。

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROUTING_BASE } = require('./knowledge-base/routing-base.js');

const L2_DIR = __dirname;
// tools/ 下的 demo（桥、dry-run、归一化等）也要进全量回归。
// 之前只 walk l2/，它们长期游离在 CI 之外——加了 demo 也不会被发现，
// 表现就是「demo 本地跑得绿、run-demos 从来没跑过它」。
const TOOLS_DIR = path.join(__dirname, '..', 'tools');
const REPO_ROOT = path.join(__dirname, '..');

// ---- 改动描述 → 影响标签 ----
// 返回 { tags: Set<string>, reason: string }；tags 为空集表示全量（fail-closed）。
function changeTags(change) {
    if (!change || change === 'all') return { tags: null, reason: '全量回归' };
    const [kind, arg] = String(change).split(':');
    switch (kind) {
        case 'adapter': {
            if (!ROUTING_BASE.adapterDefaults[arg]) {
                return { tags: null, reason: `adapter "${arg}" 不在 routing-base.adapterDefaults → fail-closed 全量` };
            }
            return { tags: new Set(['adapter', `adapter:${arg}`, 'routing']), reason: `adapter "${arg}" 能力/模型变更（含共享底座 routing-base 联动）` };
        }
        case 'template': {
            const known = ROUTING_BASE.templates.some((t) => t.name === arg) || ROUTING_BASE.fallback.name === arg;
            if (!known) {
                return { tags: null, reason: `template "${arg}" 不在 routing-base.templates → fail-closed 全量` };
            }
            return { tags: new Set(['template', 'routing', 'decomposer']), reason: `拆解模板 "${arg}" 变更（影响拆解行为与共享底座）` };
        }
        case 'tier':
            return { tags: new Set(['tier', 'route', 'routing']), reason: 'complexity→tier 映射变更（影响路由决策与共享底座）' };
        case 'core':
            return { tags: null, reason: '编排内核 / 共享机制变更 → fail-closed 全量' };
        default:
            return { tags: null, reason: `未知改动 "${change}" → fail-closed 全量` };
    }
}

// ---- demo 文件 → 影响标签（未登记 → unknown，必跑）----
const DEMO_TAGS = {
    'contract.demo.js': ['contract', 'orchestrator'],
    'semantic-review.demo.js': ['semantic', 'route', 'orchestrator'],
    'quality-fidelity.demo.js': ['fidelity', 'orchestrator'],
    'impact.demo.js': ['impact'],
    'orchestrator.demo.js': ['orchestrator'],
    'route-engine-orchestrator.demo.js': ['orchestrator', 'route'],
    'decomposer.demo.js': ['decomposer', 'template', 'routing'],
    'route-engine.demo.js': ['route', 'tier'],
    'no-candidate-policy.demo.js': ['route', 'policy', 'orchestrator'],
    'pilot-hot-path.demo.js': ['pilot', 'hot-path', 'orchestrator', 'adapter'],
    'llm-decomposer.demo.js': ['decomposer', 'llm'],
    'agent-registry.demo.js': ['registry', 'tier'],
    'alert.demo.js': ['governance'],
    'circuit-breaker.demo.js': ['governance', 'resilience'],
    'cost.demo.js': ['governance', 'cost'],
    'health-monitor.demo.js': ['governance'],
    'health-store.demo.js': ['governance', 'resilience'],
    'l2-bootstrap.demo.js': ['bootstrap', 'orchestrator', 'route', 'registry'],
    'mcp-orchestrate-llm.demo.js': ['mcp'],
    'mcp-orchestrate-real.demo.js': ['mcp'],
    'mcp-server.demo.js': ['mcp'],
    'memory-merge.demo.js': ['memory'],
    'memory-align.demo.js': ['memory', 'align'],
    'plugin-runtime.demo.js': ['plugin', 'registry'],
    'prompt-cache.demo.js': ['cache'],
    'rate-limiter.demo.js': ['governance'],
    'skill-service.demo.js': ['plugin', 'skill'],
    'skill-hosts.demo.js': ['plugin', 'skill', 'host'],
    'skill-policy.demo.js': ['plugin', 'skill', 'policy'],
    'token-policy.demo.js': ['governance'],
    'knowledge-base.demo.js': ['knowledge', 'routing'],
    'routing-base.demo.js': ['routing', 'template', 'tier', 'adapter'],
    'pilot-hot-path.demo.js': ['pilot', 'e2e', 'adapter', 'orchestrator'],
    'agent-live-e2e.demo.js': ['e2e', 'adapter', 'orchestrator'],
    'claude-adapter.demo.js': ['adapter', 'adapter:claude'],
    'l1-agent-adapter.demo.js': ['adapter', 'adapter:l1-agent'],
    'aigc-adapter.demo.js': ['adapter', 'adapter:aigc'],
    'h3web-adapter.demo.js': ['adapter', 'adapter:h3web'],
    'h3web-port-discovery.demo.js': ['adapter', 'adapter:h3web'],
    'cost-watchdog.demo.js': ['governance', 'cost'],
    'savings-gateway.demo.js': ['gateway', 'cost', 'routing'],
    'model-catalog-emitter.demo.js': ['catalog', 'adapter'],
};

// 收集所有 demo 文件（相对 l2/ 的路径）
function collectDemos() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.demo.js')) out.push(path.relative(REPO_ROOT, p));
        }
    };
    walk(L2_DIR);
    walk(TOOLS_DIR);
    return out.sort();
}

function selectDemos(change) {
    const { tags, reason } = changeTags(change);
    const files = collectDemos();
    if (!tags) return { selected: files, skipped: [], reason, warned: [] };

    const selected = [];
    const skipped = [];
    const warned = [];
    for (const f of files) {
        const base = path.basename(f);
        const fileTags = DEMO_TAGS[base];
        if (!fileTags) {
            selected.push(f); // 未登记 tag → fail-closed 必跑
            warned.push(f);
            continue;
        }
        (fileTags.some((t) => tags.has(t)) ? selected : skipped).push(f);
    }
    return { selected, skipped, reason, warned };
}

function main() {
    const impactIdx = process.argv.indexOf('--impact');
    const change = impactIdx !== -1 ? (process.argv[impactIdx + 1] || 'all') : 'all';
    const { selected, skipped, reason, warned } = selectDemos(change);
    const node = process.execPath;

    console.log(`[run-demos] 改动: ${change}`);
    console.log(`[run-demos] 影响判定: ${reason}`);
    console.log(`[run-demos] 本次改动影响 ${selected.length} 个用例文件: ${selected.join(', ') || '(无)'}`);
    if (skipped.length) console.log(`[run-demos] 跳过 ${skipped.length} 个无关用例: ${skipped.join(', ')}`);
    if (warned.length) console.log(`[run-demos] ⚠ 未登记 tag（fail-closed 必跑）: ${warned.join(', ')}`);
    console.log('');

    let failed = 0;
    for (const f of selected) {
        const abs = path.join(REPO_ROOT, f);
        const r = spawnSync(node, [abs], { cwd: path.dirname(abs), encoding: 'utf8', timeout: 120000 });
        if (r.status !== 0) {
            failed++;
            console.log(`✗ ${f} (exit ${r.status})`);
            if (r.stdout) console.log(r.stdout.split('\n').slice(-5).join('\n'));
            if (r.stderr) console.log(r.stderr.split('\n').slice(-5).join('\n'));
        } else {
            console.log(`✓ ${f}`);
        }
    }
    console.log('---');
    console.log(failed === 0
        ? `ALL ${selected.length} SELECTED DEMOS GREEN`
        : `${failed}/${selected.length} FAILED — REGRESSION DETECTED`);
    process.exit(failed === 0 ? 0 : 1);
}

main();
