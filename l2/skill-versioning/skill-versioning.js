// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 技能版本管理 + eval + 回滚（G4，映射 Paperclip Skill Studio）
//
// 非侵入铁律（与 l2/ 其它内核同构）：
//   - 通用登记框架：治理能力 / adapter 自愿 register 进来，框架不主动 require 任何热路径模块。
//   - 门控 PROXY_SKILL_VERSIONING 默认关 = 仅内存登记 / 只读 list；开(=1/true/on) = 可 best-effort 落盘 registry.json。
//   - 不往 process.env 注入任何键；零第三方依赖（node 内置 path/os/fs）。
//   - 本模块不被任何热路径 require，因此「存在即零行为变更」；门控只决定落盘与否。
//
// 语义对齐 Paperclip Skill Studio：
//   register  = 技能登记 + 打版本号
//   eval      = 跑该技能的回归用例（接入方注册时注入 eval 函数，框架负责调用并记录 pass/total/failed）
//   rollback  = 切回某版本（并调用该版本注册的 rollback 副作用钩子，如禁用某 guard）

const path = require('path');
const os = require('os');
const fs = require('fs');

const GATE_ENV = 'PROXY_SKILL_VERSIONING';
const DEFAULT_REGISTRY_FILE = path.join(os.homedir(), '.multi-proxy-manager', 'skill-registry.json');

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

function persistRegistry(file, data) {
    try {
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return true;
    } catch { return false; }
}

function createSkillVersioning(opts = {}) {
    const registry = new Map(); // id -> { versions:[{version,registeredAt,eval,rollback,meta}], current, meta }
    const activeFile = typeof opts.registryFile === 'string' ? opts.registryFile : DEFAULT_REGISTRY_FILE;

    // 登记一个技能版本（同 id + 同 version 去重，重复抛错）
    function register(id, { version = '1.0.0', evalFn = null, rollback = null, meta = {} } = {}) {
        if (!registry.has(id)) registry.set(id, { versions: [], current: null, meta: {} });
        const entry = registry.get(id);
        if (entry.versions.some((v) => v.version === version)) {
            throw new Error(`skill ${id} version ${version} already registered`);
        }
        entry.versions.push({ version, registeredAt: Date.now(), evalFn, rollback, meta });
        if (entry.current == null) entry.current = version;
        return entry;
    }

    // 把 current 切到指定版本（不调用 rollback 副作用，纯标记）
    function tagVersion(id, version) {
        const entry = registry.get(id);
        if (!entry) throw new Error(`skill ${id} not registered`);
        if (!entry.versions.some((v) => v.version === version)) throw new Error(`version ${version} not found for ${id}`);
        entry.current = version;
        return entry;
    }

    // 跑当前版本的 eval（sync/async 均支持），返回 {pass,total,failed}
    async function evalSkill(id) {
        const entry = registry.get(id);
        if (!entry) return { id, registered: false, pass: 0, total: 0, failed: [] };
        const cur = entry.versions.find((v) => v.version === entry.current);
        if (!cur || typeof cur.evalFn !== 'function') {
            return { id, version: entry.current, evaluated: false, pass: 0, total: 0, failed: [], reason: 'no eval fn' };
        }
        let res;
        try {
            res = await cur.evalFn();
        } catch (e) {
            return { id, version: entry.current, evaluated: true, pass: 0, total: 1, failed: [String((e && e.message) || e)], error: true };
        }
        if (typeof res === 'boolean') res = { pass: res ? 1 : 0, total: 1, failed: res ? [] : ['eval returned false'] };
        return { id, version: entry.current, evaluated: true, pass: res.pass || 0, total: res.total || 0, failed: res.failed || [] };
    }

    // 回滚到某版本（默认最早登记版本），并调用该版本注册的 rollback 钩子
    function rollback(id, toVersion) {
        const entry = registry.get(id);
        if (!entry) throw new Error(`skill ${id} not registered`);
        const target = toVersion || (entry.versions[0] && entry.versions[0].version);
        if (!entry.versions.some((v) => v.version === target)) throw new Error(`rollback target ${target} not found`);
        entry.current = target;
        const ver = entry.versions.find((v) => v.version === target);
        if (typeof ver.rollback === 'function') {
            try { ver.rollback(); } catch { /* non-fatal */ }
        }
        return entry;
    }

    function list() {
        return [...registry.entries()].map(([id, e]) => ({
            id,
            current: e.current,
            versions: e.versions.map((v) => ({
                version: v.version,
                registeredAt: v.registeredAt,
                hasEval: typeof v.evalFn === 'function',
                hasRollback: typeof v.rollback === 'function',
            })),
        }));
    }

    function snapshot() {
        const data = { gateOpen: gateOpen(), skills: list() };
        if (gateOpen()) persistRegistry(activeFile, data);
        return data;
    }

    return { register, tagVersion, evalSkill, rollback, list, snapshot, gateOpen };
}

const _sv = createSkillVersioning();
module.exports = {
    GATE_ENV,
    DEFAULT_REGISTRY_FILE,
    createSkillVersioning,
    gateOpen,
    // 单例转发（与其它 l2 内核同构）
    register: _sv.register,
    list: _sv.list,
    snapshot: _sv.snapshot,
};
