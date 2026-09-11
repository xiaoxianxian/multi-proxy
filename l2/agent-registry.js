'use strict';

// Agent Registry — L2 中台内核（P0 增量 2）
// 职责：Agent Profile 的 CRUD + 能力标签注册/查询。
//
// 设计原则（与蓝图 ①②④ 一致）：
//   - 存储可注入：默认内存；写中枢自己的 registry，绝不写 agent 自身文件（非侵入④）。
//     文件持久化写注入的 dir（绝不默认写 home），便于测试隔离 + 零副作用。
//   - 零依赖：内核只用 node 内置 + 轻量内置校验（不 require 全局 ajv——
//     ajv/schema 校验归 l2/specs/validate.mjs，内核保持可移植）。
//   - 能力查询是编排引擎"按能力路由"的基础（蓝图 5.1 的 L2 路由）。

const path = require('path');
const fs = require('fs');

const SPEC_VERSION = '1.0.0';
const AGENT_TYPES = new Set(['codex', 'hermes', 'cursor', 'custom']);
const REQUIRED = ['id', 'name', 'type', 'capabilityTags', 'specVersion'];

// 轻量校验（必填 + type enum + specVersion const + 基本类型）。返回错误数组或 null。
function validate(profile) {
    const errs = [];
    if (!profile || typeof profile !== 'object') return ['profile not object'];
    for (const k of REQUIRED) {
        if (!(k in profile)) errs.push(`missing ${k}`);
    }
    if (typeof profile.id !== 'string' || !profile.id) {
        errs.push('id must be non-empty string');
    }
    if (!AGENT_TYPES.has(profile.type)) {
        errs.push(`type must be one of ${[...AGENT_TYPES].join('/')} (got ${JSON.stringify(profile.type)})`);
    }
    if (!Array.isArray(profile.capabilityTags)) {
        errs.push('capabilityTags must be array');
    }
    if (profile.specVersion !== SPEC_VERSION) {
        errs.push(`specVersion must be ${SPEC_VERSION} (got ${JSON.stringify(profile.specVersion)})`);
    }
    return errs.length ? errs : null;
}

class AgentRegistry {
    constructor({ storage } = {}) {
        this.storage = storage || newMemoryStorage();
    }
    create(profile) {
        // 内核权威盖章 specVersion（调用者不必知道协议版本，便于向后兼容演进）。
        const stamped = { ...profile, specVersion: SPEC_VERSION };
        const errs = validate(stamped);
        if (errs) throw new Error(`invalid profile: ${errs.join('; ')}`);
        if (this.storage.get(profile.id)) {
            throw new Error(`agent id already exists: ${profile.id}`);
         }
        const now = new Date().toISOString();
        const full = {
            ...stamped,
            createdAt: profile.createdAt || now,
            updatedAt: now,
         };
        this.storage.set(full.id, full);
        return full;
     }
    get(id) {
        const p = this.storage.get(id);
        if (!p) throw new Error(`agent not found: ${id}`);
        return p;
    }
    update(id, patch) {
        const cur = this.get(id);
        if (patch.id && patch.id !== id) {
            throw new Error('cannot change an agent id via update (use create with new id)');
        }
        const merged = { ...cur, ...patch, id, specVersion: SPEC_VERSION };
        const errs = validate(merged);
        if (errs) throw new Error(`invalid update: ${errs.join('; ')}`);
        merged.updatedAt = new Date().toISOString();
        this.storage.set(id, merged);
        return merged;
    }
    remove(id) {
        if (!this.storage.get(id)) throw new Error(`agent not found: ${id}`);
        this.storage.delete(id);
        return true;
    }
    list() {
        return [...this.storage.values()];
    }
    // 能力标签查询：编排引擎"按能力路由"的基础。
    byCapability(tag) {
        return this.list().filter((p) => Array.isArray(p.capabilityTags) && p.capabilityTags.includes(tag));
    }
    // 能力注册：把新能力标签并入（不覆盖已有），是 Adapter 启动时向 Registry 声明能力的落点。
    registerCapabilities(id, tagsArray) {
        const cur = this.get(id);
        const set = new Set([...(cur.capabilityTags || []), ...tagsArray]);
        return this.update(id, { capabilityTags: [...set] });
    }
    count() {
        return this.storage.size();
    }
}

// 内存存储：默认，零副作用，测试/演示用。
function newMemoryStorage() {
    const m = new Map();
    return {
        get: (id) => m.get(id),
        set: (id, p) => { m.set(id, p); },
        delete: (id) => m.delete(id),
        values: () => [...m.values()],
        size: () => m.size,
    };
}

// 文件存储（可注入 dir；绝不默认写 home，遵守非侵入）。
// 持久化格式与 l2/specs/agent-profile.json 同构（{specVersion, entries:[]}）。
// 原子写：写 .tmp 再 rename（参考 managers providers.json 的 P1 原子写经验）。
function newFileStorage(dir) {
    const file = path.join(dir, 'agents.json');
    let cache = new Map();
    function load() {
        if (!fs.existsSync(file)) { cache = new Map(); return; }
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        const entries = Array.isArray(doc.entries) ? doc.entries : (Array.isArray(doc) ? doc : []);
        cache = new Map(entries.map((e) => [e.id, e]));
    }
    function persist() {
        const tmp = file + '.tmp';
        const doc = { specVersion: SPEC_VERSION, entries: [...cache.values()] };
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { flag: 'w', encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    load();
    return {
        get: (id) => cache.get(id),
        set: (id, p) => { cache.set(id, p); persist(); return p; },
        delete: (id) => {
            const ok = cache.delete(id);
            if (ok) persist();
            return ok;
        },
        values: () => [...cache.values()],
        size: () => cache.size,
    };
}

module.exports = {
    AgentRegistry,
    newMemoryStorage,
    newFileStorage,
    validate,
    AGENT_TYPES,
    REQUIRED,
    SPEC_VERSION,
};
