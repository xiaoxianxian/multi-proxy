'use strict';
// P1.1a 记忆服务内核（L2 蓝图 §4.4「记忆服务 公共+个性」+ §5.2「记忆注入链路 非侵入」的落地内核）
//
// 规范数据格式（agent-memory.json canonical ↔ yaml 视图 ↔ schema 校验）已在 specs/ 落地（validate.mjs
// 证明 round-trip + schema 全 PASS）。本模块只做规范格式之上的三件事，且**全默认零网络零文件、零 LLM**：
//   1. merge(shared, personal, opts) —— 公共 + 个性两层合并 + 冲突策略（默认个性覆盖公共）
//   2. envInject(merged, opts)       —— 把合并结果「投影」成环境变量映射（非侵入核心：只产映射，绝不写
//      process.env、绝不碰 ~/.codex、~/.hermes、~/.cursor；真正注环境是调用方在 agent 启动时拿映射去做）
//   3. adapters                      —— 方案适配器注册表（可热插拔）：把规范 memory doc 转各后端格式
//      （内置 json/yaml-text/view；yaml 适配器纯文本往返、零依赖、与 specs/ 解耦）
//
// 非侵入铁律（§5.2）：envInject 只**返回**一个 env 映射对象；agent 感知不到中枢，只看到自己的环境变量被设置，
// 配置文件一点没动。本模块永不 mutate process.env / 写盘 / 联网。
//
// 导出：merge / envInject / validateMemoryDoc / registerAdapter / getAdapters / builtinAdapters
//       DEFAULT_ENV_MAP / SPEC_VERSION

const SPEC_VERSION = '1.0.0';
const SHARED_SCOPE = 'shared';
const DEFAULT_STRATEGY = 'personal';           // 冲突时个性覆盖公共（§4.4 默认）
const ENV_CONTEXT_MAXLEN = 12000;              // AGENT_MEMORY_CONTEXT 截断上限（避免超长 env 撑爆某些 runtime）
// 记忆 type -> 投影目标环境变量（§5.2 示例：AGENT_SYSTEM_PROMPT / AGENT_TOOLS_ALLOWED / AGENT_MEMORY_CONTEXT）
const DEFAULT_ENV_MAP = {
    preference:    'AGENT_SYSTEM_PROMPT',
    'error-pattern':'AGENT_ERROR_PATTERNS',
    config:        'AGENT_CONFIG',
    template:      'AGENT_TOOLS_ALLOWED',
    note:          'AGENT_MEMORY_CONTEXT',
};

// ---- 规范格式校验（轻量版，零依赖；权威 schema 校验走 specs/validate.mjs）----
function entryValid(e) {
    return e && typeof e === 'object'
        && typeof e.id === 'string' && e.id.length > 0
        && typeof e.key === 'string'
        && Array.isArray(e.tags)
        && typeof e.value !== 'undefined'
        && e.specVersion === SPEC_VERSION;
}
function validateMemoryDoc(doc) {
    const errs = [];
    if (!doc || typeof doc !== 'object') { errs.push('doc not an object'); return { valid: false, errors: errs }; }
    if (doc.specVersion !== SPEC_VERSION) { errs.push(`specVersion must be ${SPEC_VERSION}`); }
    if (doc.entries === undefined) { errs.push('entries missing'); return { valid: false, errors: errs }; }
    if (!Array.isArray(doc.entries)) { errs.push('entries must be array'); return { valid: false, errors: errs }; }
    doc.entries.forEach((e, i) => {
        if (!entryValid(e)) errs.push(`entries[${i}] invalid`);
    });
    return { valid: errs.length === 0, errors: errs };
}
function asDoc(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    if (!Array.isArray(raw)) return raw;                    // 裸数组 = 直接当 entries
    const entries = Array.isArray(raw.entries) ? raw.entries : raw;
    const out = { specVersion: raw.specVersion || SPEC_VERSION, entries };
    out.source = raw.source;
    return out;
}

// ---- 1. merge —— 公共 + 个性合并 ----
function merge(shared, personal, opts = {}) {
    const strat = opts.strategy || DEFAULT_STRATEGY;
    const sharedDoc   = asDoc(shared);
    const personalDoc = asDoc(personal);
    const personalEntries = personalDoc && Array.isArray(personalDoc.entries) ? personalDoc.entries : [];
    const sharedEntries   = sharedDoc && Array.isArray(sharedDoc.entries) ? sharedDoc.entries : [];

    const byKey = new Map();
    const order = [];
    const conflicts = [];
    const put = (e, layer) => {
        if (!entryValid(e)) return;
        if (!byKey.has(e.key)) {
            byKey.set(e.key, { ...e, _layer: layer, _layers: [layer] });
            order.push(e.key);
            return;
         }
        const cur = byKey.get(e.key);
        cur._layers.push(layer);                         // 记录双方都出现（观测用）
        if (strat === 'error') {
            conflicts.push({ key: e.key, layers: [...cur._layers] });
         } else if (layer === strat) {                   // 胜出层（personal/shared）：用当前 e 的数据字段覆盖 cur
            for (const f of ['id', 'type', 'scope', 'key', 'value', 'tags', 'source', 'createdAt', 'updatedAt', 'specVersion']) {
                cur[f] = e[f];
             }
            cur._layer = layer;
         }
     };
    for (const e of sharedEntries)   put(e, 'shared');
    for (const e of personalEntries) put(e, 'personal');

    const result = {
        specVersion: SPEC_VERSION,
        entries: order.map(k => {
            const e = byKey.get(k);
            const { _layer, _layers, ...pub } = e;
            return pub;
        }),
        // 合并观测元数据（非规范字段，仅供本服务/测试消费；注入投影时忽略下划线键）
        meta: {
            total: order.length,
            shared: sharedEntries.length,
            personal: personalEntries.length,
            strategy: strat,
            conflicts,                                  // strategy='error' 时也在此记录，供调用方判定
        },
    };
    return result;
}

// ---- 2. envInject —— 非侵入投影（只产映射，不写 process.env / 不碰 agent 文件）----
// 把合并记忆投影成「agent 启动时应设置的环境变量映射」。同一 type 多条按 updatedAt 倒序拼，单条 value 走 stringify。
function envInject(merged, opts = {}) {
    const env = typeof opts.env === 'object' && opts.env ? opts.env : {};
    const map = opts.envMap || DEFAULT_ENV_MAP;
    const maxlen = opts.contextMaxLen != null ? opts.contextMaxLen : ENV_CONTEXT_MAXLEN;
    const groups = {};
    for (const e of (merged && Array.isArray(merged.entries) ? merged.entries : [])) {
        const type = e.type;
        const target = map[type];
        if (target === undefined) continue;            // 未在投影映射里的 type 不注（默认零副作用）
        (groups[target] = groups[target] || { parts: [], values: [] }).values.push(e);
    }
    for (const [target, grp] of Object.entries(groups)) {
        const sorted = [...grp.values].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        let val;
        if (sorted.length === 1) {
            val = toStr(sorted[0].value);
        } else {
            val = toStr({ entries: sorted.map(e => ({ id: e.id, key: e.key, type: e.type, value: e.value })) });
        }
        // 截断超长上下文（保护 runtime 环境大小），截断时打标记
        val = typeof val === 'string' && val.length > maxlen
            ? val.slice(0, maxlen) + '…[truncated]'
            : val;
        env[target] = val;
    }
    return env;
}
function toStr(v) {
    return typeof v === 'string' ? v : JSON.stringify(v);
}

// ---- 3. adapters —— 可热插拔方案适配器（§4.8「方案适配器可热插拔」）----
const builtinAdapters = {
    // 规范 doc <-> JSON（规范 canonical 格式本身，零转换）
    json: {
        name: 'json',
        toDoc(raw) { return asDoc(raw); },
        fromDoc(doc) { return JSON.parse(JSON.stringify(doc)); },
    },
    // 规范 doc <-> 人类可读文本视图（纯文本往返、零依赖、与 specs/agent-memory.yaml 解耦，可热插拔替换）
    yaml: {
        name: 'yaml',
        toDoc(raw) {
            const lines = ['# agent-memory (human view, round-trippable)'];
            lines.push(`specVersion: ${raw.specVersion || SPEC_VERSION}`);
            for (const e of (Array.isArray(raw) ? raw : raw.entries || [])) {
                lines.push(`- id: ${e.id}`);
                lines.push(`  type: ${e.type}`);
                lines.push(`  scope: ${e.scope}`);
                lines.push(`  key: ${e.key}`);
                lines.push(`  value: ${toStr(e.value)}`);
                lines.push(`  tags: ${JSON.stringify(e.tags || [])}`);
                lines.push(`  source: ${e.source || ''}`);
                lines.push(`  updatedAt: ${e.updatedAt || ''}`);
            }
            return lines.join('\n');
        },
        fromDoc(text) {
            const obj = { specVersion: SPEC_VERSION, entries: [] };
            const blocks = String(text).split(/\n(?=- )/);
            for (let b of blocks) {
                b = b.trim();
                if (!b || !b.startsWith('-')) continue;
                const e = {};
                for (const line of b.split('\n').slice(1)) {
                    const m = line.trim().match(/^(\w+):\s+([\s\S]*)$/);
                    if (!m) continue;
                    e[m[1]] = m[2].trim();
                }
                try { e.tags = e.tags ? JSON.parse(e.tags) : []; } catch (_) { e.tags = []; }
                obj.entries.push(e);
            }
            return obj;
        },
    },
    // 规范 doc <-> view（只留 id/key/type/updatedValue 摘要，用于记忆管理界面展示）
    view: {
        name: 'view',
        toDoc(raw) {
            const doc = asDoc(raw);
            return {
                specVersion: doc.specVersion || SPEC_VERSION,
                entries: (doc.entries || []).map(e => ({ id: e.id, key: e.key, type: e.type, updatedAt: e.updatedAt })),
            };
        },
        fromDoc(doc) { return doc; },
    },
};
const _adapterStore = { ...builtinAdapters };
function registerAdapter(name, adapter) {
    if (typeof name !== 'string' || !adapter || typeof adapter.toDoc !== 'function' || typeof adapter.fromDoc !== 'function') {
        throw new Error('registerAdapter: name + {toDoc, fromDoc} required');
    }
    _adapterStore[name] = adapter;
    return name;
}
function getAdapters() { return { ..._adapterStore }; }

module.exports = {
    SPEC_VERSION, SHARED_SCOPE, DEFAULT_STRATEGY, DEFAULT_ENV_MAP,
    merge, envInject, validateMemoryDoc,
    registerAdapter, getAdapters, builtinAdapters,
};
