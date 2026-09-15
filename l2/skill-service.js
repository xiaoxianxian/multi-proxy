'use strict';

// 技能服务内核（P1 · 蓝图 4.5「技能服务」+ L2-BLUEPRINT P1 行 349 的 3 个验收项）
// 职责：Skill CRUD + 版本管理 + 规范格式适配器（市场/可热插拔）——全内存、非侵入、零网络零文件。
//
// 设计原则（与 agent-registry.js / memory-merge.js 同构，与蓝图 ①②④ 一致）：
//    - 非侵入④：默认纯内存 store；写中枢自己的 registry，绝不写 agent 自身文件
//      （~/.codex / ~/.hermes / ~/.cursor）。文件持久化 = 调用方注入 dir，内核绝不默认写 home。
//    - 规范格式：条目 = {id,name,trigger,description,content,version,tags,enabled,source,specVersion}
//      （spec 见 l2/specs/skill.json + schema.json，权威校验走 l2/specs/validate.mjs）。
//      内核自带轻量 validate（必填 + 基本类型），不 require 全局 ajv（保持可移植）。
//    - 可热插拔：registerAdapter/getAdapters，内置 json(canonical) / yaml-text(纯文本) / view(摘要)
//      三方案，方案互换时在规范格式上做无损往返（§4.8「方案适配器可热插拔」）。
//
// 版本管理语义：create 入 1.0.0；bump(name|id, {version?}) 新建一条（缺省 semver patch 递增）
//   并保留旧版本于 versions[]；rollback(name|id, targetVersion) 把 enabled 翻到旧版本。
// 市场：source 字段（builtin/custom）= 来源；enabled=true/false = 启用开关；upload/registerBuiltin
//   只是带 source 标签的 create（YAGNI，不另起一套）。

const SPEC_VERSION = '1.0.0';
const REQUIRED = ['name', 'trigger', 'description', 'content'];
const DEFAULT_SOURCE = 'custom';

// 轻量校验：必填 + 基本类型 + version 形如 X.Y.Z。返回错误数组或 null。
function validateSkill(s) {
    const errs = [];
    if (!s || typeof s !== 'object') { return ['skill not object']; }
    for (const k of REQUIRED) {
        if (!(k in s)) { errs.push(`missing ${k}`); }
        else if (typeof s[k] !== 'string' || !s[k]) { errs.push(`${k} must be non-empty string`); }
      }
    // version：必填、形如 X.Y.Z（简单正则，不引入 semver 依赖）
    if (!('version' in s) || !/^\d+\.\d+\.\d+$/.test(s.version)) {
        errs.push(`version must be X.Y.Z (got ${JSON.stringify(s.version)})`);
     }
    // tags array of string、enabled boolean、source string
    if (s.tags !== undefined && (!Array.isArray(s.tags) || s.tags.some((t) => typeof t !== 'string'))) {
        errs.push('tags must be array of string');
       }
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
        errs.push('enabled must be boolean');
       }
    if (s.source !== undefined && typeof s.source !== 'string') {
        errs.push('source must be string');
       }
    return errs.length ? errs : null;
}

// 内核权威盖章 specVersion + id（调用者不必知道协议版本 / id 规则，向后兼容演进）
function toEntry(raw, now) {
    const e = { ...raw, specVersion: SPEC_VERSION };
    // id 缺省 = skill-<name slug>；已给则尊重
    if (!e.id) {
        e.id = 'skill-' + String(e.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        }
    e.tags = e.tags || [];
    e.enabled = e.enabled !== false;                        // 默认启用
    e.source = e.source || DEFAULT_SOURCE;
    e.version = e.version || '1.0.0';                       // 缺省 1.0.0（与 l2/specs/skill.json 同构）
    e.createdAt = e.createdAt || now;
    e.updatedAt = now;
    return e;
}

function createSkillService(opts = {}) {
    const now = () => (opts.clock ? opts.clock() : new Date().toISOString());
    const store = { entries: [] };
// key 可为 id 或 name；返回该 name 下 version 最高的条目（semver 倒序），无则 null
    const find = (key) => {
        const matches = store.entries.filter((e) => e.id === key || e.name === key);
        if (!matches.length) { return null; }
        return matches.slice().sort((a, b) => semverCmp(b.version, a.version))[0];
      };

    return {
        create(raw, opts = {}) {
            const merged = { ...raw, ...opts };
            const stamped = toEntry(merged, now());
            const errs = validateSkill(stamped);
            if (errs) { throw new Error(`invalid skill: ${errs.join('; ')}`); }
            // 同一 name 视为同一条技能的不同版本 → 多 version 共名是允许的
            store.entries.push(stamped);
            return stamped;
        },
        // 市场：registerBuiltin / upload 只是带 source 标签的 create（YAGNI：不另起一套状态）
        registerBuiltin(s) { return this.create(s, { source: 'builtin' }); },
        upload(s) { return this.create(s, { source: 'custom' }); },
        get(key) {
            const e = find(key);
            if (!e) { throw new Error(`skill not found: ${key}`); }
       return e;
    },
        update(key, patch, opts5 = {}) {
            const e = this.get(key);
            const next = { ...e, ...patch, id: e.id, version: opts5.version || bumpSemver(e.version),
                updatedAt: now() };
            if (validateSkill(next)) { throw new Error(`invalid skill update: ${validateSkill(next).join('; ')}`); }
            const i = store.entries.indexOf(e);
            store.entries[i] = next;
            return next;
         },
        bump(key, opts4 = {}) {
             const e = this.get(key);
            const v = opts4.version || bumpSemver(e.version);
            const next = toEntry({ ...e, version: v, source: e.source }, now());
            // 保留旧版本：旧条目 enabled 置 false（当前生效的只有最新版本）
            const old = store.entries.find((x) => x.id === e.id && x.version === e.version);
            if (old) { old.enabled = false; }
            next.enabled = true;
            store.entries.push(next);
            return next;
        },
        rollback(key, targetVersion) {
             const e = find(key);
            if (!e) { throw new Error(`skill not found: ${key}`); }
            const target = store.entries.find((x) => x.id === e.id && x.version === targetVersion);
            if (!target) { throw new Error(`version not found: ${targetVersion} of ${key}`); }
            // 当前最新启用项关闭，把启用权翻到目标版本（仍保留在 store，可再次前进）
            for (const x of store.entries) {
                if (x.id === e.id && x.enabled) { x.enabled = false; }
            }
            target.enabled = true;
            target.updatedAt = now();
            return target;
        },
        remove(key) {
            const e = find(key);
            if (!e) { return false; }
            const i = store.entries.indexOf(e);
            if (i >= 0) { store.entries.splice(i, 1); }
            return true;
        },
        list(filter = {}) {
            let out = store.entries.slice();
            if (filter.name) { out = out.filter((e) => e.name === filter.name || e.id === filter.name); }
            if (filter.source) { out = out.filter((e) => e.source === filter.source); }
            if (filter.tags && filter.tags.length) {
                out = out.filter((e) => e.tags.some((t) => filter.tags.includes(t)));
             }
            if (filter.enabled === true || filter.enabled === false) {
                out = out.filter((e) => e.enabled === filter.enabled);
            }
            // 同 name 多版本 → 默认只暴露每个 name 的最新 enabled 版本（市场"在架"视图）
            if (filter.latest !== false && !filter.includeDisabled) {
                const seen = new Map();
                for (const e of out.sort((a, b) => semverCmp(b.version, a.version))) {
                    if (!seen.has(e.name)) { seen.set(e.name, e); }
                 }
                out = [...seen.values()];
            }
            return out;
        },
        // 关键词搜索：name / trigger / description / content 子串匹配（小写，零依赖）
        search(q) {
            const t = String(q).toLowerCase();
            return store.entries.filter((e) =>
                `${e.name} ${e.trigger} ${e.description} ${e.content}`.toLowerCase().includes(t));
        },
        versions(key) {
            const e = find(key);
            if (!e) { return []; }
            return store.entries.filter((x) => x.id === e.id)
                .slice().sort((a, b) => semverCmp(b.version, a.version));
        },
        // 注入/投影：把技能列表投影成"能力声明"摘要（编排引擎/Registry 消费）——只产数据，不写盘
        toCapabilities() {
            // 每个 name 取最新 enabled 版本，输出 { name, trigger, tags, version }
            const latest = {};
            for (const e of store.entries.slice().sort((a, b) => semverCmp(b.version, a.version))) {
                if (e.enabled && !latest[e.name]) {
                    latest[e.name] = { name: e.name, trigger: e.trigger, description: e.description,
                         tags: e.tags, version: e.version, source: e.source };
                 }
            }
            return Object.values(latest);
        },
     _store: store,                 // 测试/观测用，生产调用者不应直接读写
    };
}

// ---- semver 轻量比较（X.Y.Z，零依赖） ----
function semverCmp(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
         const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) { return d; }
     }
    return 0;
}
function bumpSemver(v) {
  const p = String(v).split('.').map(Number);
    p[2] = (p[2] || 0) + 1;
    return p.join('.');
}

// ---- 可热插拔 scheme 适配器（§4.8；规范 json <-> 各方案纯文本往返） ----
const builtinSkillAdapters = {
     // 规范 doc <-> JSON（canonical 本身，零转换）
    json: {
        name: 'json',
        toDoc: (raw) => JSON.parse(JSON.stringify(raw)),
        fromDoc: (doc) => (Array.isArray(doc) ? { specVersion: SPEC_VERSION, entries: doc } : doc),
     },
     // 规范 doc <-> 纯文本（零依赖，与 l2/specs/validate.mjs 解耦）
     'yaml-text': {
        name: 'yaml-text',
        toDoc: (raw) => {
            const docs = Array.isArray(raw) ? { entries: raw } : raw;
            const list = docs.entries || (Array.isArray(docs) ? docs : []);
            const lines = ['# skill (human view, round-trippable)'];
            for (const e of list) {
                lines.push(`- id: ${e.id || e.name}`);
                lines.push(`  name: ${e.name}`);
                lines.push(`  trigger: ${e.trigger || ''}`);
                lines.push(`  description: ${e.description || ''}`);
                lines.push(`  content: ${(e.content || '').replace(/\n/g, '\\n')}`);
                lines.push(`  version: ${e.version || '1.0.0'}`);
                lines.push(`  tags: ${JSON.stringify(e.tags || [])}`);
                lines.push(`  enabled: ${e.enabled !== false}`);
                lines.push(`  source: ${e.source || ''}`);
             }
            return lines.join('\n');
         },
        fromDoc: (text) => {
            const obj = { specVersion: SPEC_VERSION, entries: [] };
            for (const block of String(text).split(/\n(?=- )/)) {
                const lines = block.split('\n').slice(1);
                if (!lines.length || !/^\s*-/.test(block)) { continue; }
                const e = {};
                for (const line of lines) {
                    const m = line.trim().match(/^(\w+):\s?([\s\S]*)$/);
                    if (!m) { continue; }
                    e[m[1]] = m[2].trim().replace(/\\n/g, '\n');
                 }
                e.tags = e.tags ? JSON.parse(e.tags) : [];
                e.enabled = e.enabled === 'true';
                e.specVersion = SPEC_VERSION;
                obj.entries.push(e);
             }
            return obj;
         },
     },
     // 规范 doc <-> view（只留摘要，用于 GUI 市场卡片展示）
    view: {
        name: 'view',
        toDoc: (raw) => {
            const docs = Array.isArray(raw) ? { entries: raw } : raw;
            return {
                specVersion: SPEC_VERSION,
                entries: (docs.entries || []).map((e) => ({ name: e.name, description: e.description,
                     version: e.version, enabled: e.enabled, source: e.source, tags: e.tags })),
             };
         },
        fromDoc: (doc) => doc,
     },
};
const _adapterStore = { ...builtinSkillAdapters };
function registerAdapter(name, adapter) {
    if (typeof name !== 'string' || !adapter || typeof adapter.toDoc !== 'function' || typeof adapter.fromDoc !== 'function') {
        throw new Error('registerAdapter: name + {toDoc, fromDoc} required');
     }
 _adapterStore[name] = adapter;
    return name;
}
function getAdapters() { return { ..._adapterStore }; }

module.exports = {
    SPEC_VERSION,
    createSkillService, validateSkill,
    registerAdapter, getAdapters, builtinSkillAdapters,
    bumpSemver, semverCmp,
 };
