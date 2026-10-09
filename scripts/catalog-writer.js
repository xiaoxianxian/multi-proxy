#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// Catalog Writer — L2 中台接线（70 号 §〇「走 2」落点：catalog 可见/可选，隔离 home）
//
// 做什么：把 18795 /v1/models 的 17 个模型经 l2/model-catalog-emitter 补成 cc-switch 31 字段
//   catalog，连同一份「隔离 CODEX_HOME」的 config.toml 一起写进
//    ~/.multi-proxy-manager/profiles/codex-curator/ —— agent 用
//    `CODEX_HOME=<隔离 home> codex` 启动就能选到这些模型，全程不碰真 ~/.codex。
//
// 设计原则（与 project 铁律对齐）：
//    §3 非侵入：写的是我们自己的隔离 home（~/.multi-proxy-manager/），不是 agent 家目录
//    （~/.codex / ~/.claude / ~/.cursor）。agent 不主动读隔离 home，除非它自己用 CODEX_HOME 指过来。
//    单一所有者（agent-proxy-switch 铁律）：隔离 home 的 config.toml 是「真 config 的完整副本」，
//    只把 model_catalog_json 指向我们生成的 catalog.json；其它 section（base_url / mcp / plugins）
//    全部照搬真 config —— 不抢 base_url 所有权，不擅自改指向 18795（那是 curator 省钱开关的活）。
//    门控默认 dry-run：默认只生成 catalog + config 到内存 + 打印摘要，零文件 IO。
//     --apply 才真写隔离 home。写盘原子（temp + rename），失败不留半截。
//    零依赖：只用 node 内置 http/fs/path。
//    数据源：默认 18795（本地 token-policy-bridge，零外部网络）；可用 --source file:<path> 走离线。
//
// 用法：
//   node scripts/catalog-writer.js                  # dry-run 默认：生成+打印摘要，不写盘
//   node scripts/catalog-writer.js --apply          # 写隔离 home（只写 ~/.multi-proxy-manager/profiles/codex-curator/）
//   node scripts/catalog-writer.js --apply --home <dir>     # 指定隔离 home 目录
//   CATALOG_SOURCE=18790 node scripts/catalog-writer.js --apply    # 改数据源端口
//   node scripts/catalog-writer.js --source file:/path/to/models.json   # 离线源（不联网）

const fs = require('fs');
const path = require('path');
const http = require('http');
const { emitCatalog } = require('../l2/model-catalog-emitter.js');

// 默认配置
const DEFAULT_HOME = path.join(process.env.HOME || '', '.multi-proxy-manager', 'profiles', 'codex-curator');
const DEFAULT_BASE_CONFIG = path.join(process.env.HOME || '', '.codex', 'config.toml');
const DEFAULT_CATALOG_FILE = 'catalog.json'; // 隔离 home 内我们生成的 catalog 文件名

// 取 /v1/models 数据源：file:<path>（离线）或 裸端口号/URL（本地 http，零外部网络）
async function fetchModels(source) {
    const port = process.env.CATALOG_SOURCE || '18795';
    if (source && source.startsWith('file:')) {
        const p = source.slice(5);
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return j.data ? j : { data: j };
    }
    const url = source ? source : `http://127.0.0.1:${port}/v1/models`;
    return await new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 3000 }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                try {
                    const j = JSON.parse(body);
                    resolve(j.data ? j : { data: j });
                } catch (e) {
                    reject(new Error(`解析 ${url} 失败: ${e.message}`));
                }
            });
        });
        req.on('error', (e) => reject(new Error(`连接 ${url} 失败: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error(`连接 ${url} 超时`)); });
    });
}

// 真 config.toml → 隔离 home config.toml：仅把 model_catalog_json 指向我们生成的 catalog，
// 其它字节原样保留（不做 toml round-trip，避免破坏 mcp / plugins / marketplaces 等 section）。
// cc-switch 写的指针是 "cc-switch-model-catalog.json"；换成我们的 DEFAULT_CATALOG_FILE。
// 真 config 没有该指针（没用 cc-switch）→ 不强行注入，原样返回 + injected:false（§3 不改变现有行为）。
function rewriteCatalogPointer(baseConfigText, newFileName) {
    const re = /(model_catalog_json\s*=\s*)"([^"]+)"/;
    const m = baseConfigText.match(re);
    if (!m) return { text: baseConfigText, injected: false };
    const text = baseConfigText.replace(re, `$1"${newFileName}"`);
    return { text, injected: true, from: m[2] };
}

// 一次产出完整 plan（catalog JSON 文本 + config 文本 + 写盘动作清单）
async function buildPlan(opts = {}) {
    const homeDir = opts.home || DEFAULT_HOME;
    const baseConfigPath = opts.baseConfig || DEFAULT_BASE_CONFIG;
    const source = opts.source; // 'file:...' | 端口 | undefined

    // 1. 取模型列表（默认 18795 本地桥）
    const models = await fetchModels(source);
    const count = (models.data || []).length;
    if (count === 0) throw new Error('数据源无模型（18795 没起？或离线源为空）');

    // 2. emitter 补全成 31 字段 catalog（纯函数，§3 不写 agent 家目录）
    const catalog = emitCatalog(models, { model: {} });
    const catalogJson = JSON.stringify(catalog, null, 2);
    const catalogFile = path.join(homeDir, DEFAULT_CATALOG_FILE);

    // 3. 真 config → 隔离 config（指针换指，其它照搬）
    let hasBaseConfig = false;
    let configText = null;
    let pointerNote = '';
    if (fs.existsSync(baseConfigPath)) {
        hasBaseConfig = true;
        const orig = fs.readFileSync(baseConfigPath, 'utf8');
        const rewritten = rewriteCatalogPointer(orig, DEFAULT_CATALOG_FILE);
        configText = rewritten.text;
        pointerNote = rewritten.injected
            ? `model_catalog_json: "${rewritten.from}" → "${DEFAULT_CATALOG_FILE}"；其它 section 照搬（单一所有者铁律：不抢 base_url）`
            : '无 model_catalog_json 指针（未用 cc-switch），完整副本原样保留';
    }
    const configFile = path.join(homeDir, 'config.toml');

    // 4. 写盘动作清单（dry-run 打印用）
    const actions = [
        { op: 'mkdir', path: homeDir, kind: 'dir', note: '只创建隔离 home，不碰 agent 家目录' },
        { op: 'write', path: catalogFile, kind: 'json', note: `${count} 模型 → 31 字段/条（emitter 补全）` },
        hasBaseConfig
            ? { op: 'write', path: configFile, kind: 'toml', note: pointerNote }
            : { op: 'skip', path: configFile, kind: 'toml', note: `真 config 不存在 (${baseConfigPath})，跳过` },
    ];

    return {
        homeDir, catalogFile, configFile, hasBaseConfig,
        modelCount: count,
        catalog,
        catalogJson,
        configText,
        actions,
    };
}

// 执行写盘（仅 --apply 调用）—— 原子（temp + rename，失败不留半截）
function applyPlan(plan) {
    const { homeDir, catalogFile, configFile, hasBaseConfig, configText } = plan;
    const results = [];

    fs.mkdirSync(homeDir, { recursive: true });
    results.push(`mkdir ${homeDir}`);

    const ctmp = catalogFile + '.tmp-' + process.pid;
    fs.writeFileSync(ctmp, plan.catalogJson);
    fs.renameSync(ctmp, catalogFile);
    results.push(`write ${catalogFile} (${plan.modelCount} 模型, 31 字段/条)`);

    if (hasBaseConfig && configText) {
        const ttmp = configFile + '.tmp-' + process.pid;
        fs.writeFileSync(ttmp, configText);
        fs.renameSync(ttmp, configFile);
        results.push(`write ${configFile}`);
    }

    // 安全闸：确认隔离 home 不是 agent 真家目录（绝不把 catalog 写进 ~/.codex 等）
    const agentHomes = [
        path.join(process.env.HOME || '', '.codex'),
        path.join(process.env.HOME || '', '.claude'),
        path.join(process.env.HOME || '', '.cursor'),
    ].map((p) => path.resolve(p));
    const resolvedHome = path.resolve(homeDir);
    const collided = agentHomes.find((h) => resolvedHome === h);
    if (collided === undefined) {
        results.push(`安全闸通过：隔离 home ≠ 任何 agent 家目录（${agentHomes.join(' / ')} 未命中）`);
    } else {
        throw new Error(`✗ 安全闸拒绝：--home 指向 agent 家目录 ${collided}，catalog-writer 绝不写 agent 家目录`);
    }

    return results;
}

// main
async function main() {
    const argv = process.argv.slice(2);
    const apply = argv.includes('--apply');
    const homeIdx = argv.indexOf('--home');
    const home = homeIdx >= 0 ? argv[homeIdx + 1] : undefined;
    const sourceIdx = argv.indexOf('--source');
    const source = sourceIdx >= 0 ? argv[sourceIdx + 1] : process.env.CATALOG_SOURCE;
    const dryRun = !apply;

    console.log(`[catalog-writer] ${apply ? 'APPLY（写隔离 home）' : 'DRY-RUN（不写盘）'} · 数据源=${source || '18795(本地桥)'}`);

    const plan = await buildPlan({ apply, home, source });

    console.log(`  隔离 home: ${plan.homeDir}`);
    console.log(`  模型数:   ${plan.modelCount}`);
    for (const a of plan.actions) {
        console.log(`   [${a.op} ${a.kind.padEnd(4)}] ${a.path}`);
        if (a.note) console.log(`             ↳ ${a.note}`);
    }

    if (dryRun) {
        console.log(`\n[DRY-RUN] 未写盘。加 --apply 写隔离 home（只写 ${plan.homeDir}，不碰真 ~/.codex）。`);
        console.log(`[DRY-RUN] 写完后：CODEX_HOME=${plan.homeDir} codex   →   即可在 agent 内选到 ${plan.modelCount} 个模型。`);
        process.exit(0);
    }

    const results = applyPlan(plan);
    console.log(`\n[APPLY] 已写：`);
    results.forEach((r) => console.log('   ' + (r.startsWith('✗') ? '' : '✓ ') + r));
    console.log(`\n  启动：CODEX_HOME=${plan.homeDir} codex`);
    process.exit(0);
}

if (require.main === module) {
    main().catch((e) => {
        console.error('✗ ' + e.message);
        process.exit(1);
    });
}

module.exports = { buildPlan, applyPlan, rewriteCatalogPointer, fetchModels };
