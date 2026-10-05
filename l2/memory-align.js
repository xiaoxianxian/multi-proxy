'use strict';

// L2 memory-align 内核（D1「记忆对齐接内核」方案 A 的心脏）。
// 职责：把 reader/target 两侧的 MEMORY 水位做增量对齐（pull 吸收 target 侧、push 登记 reader 侧 pending），
//   产出对齐水位 entry 交给 AgentRegistry.registerAlignment 登记（第 5 注册面）。
//
// 复用 l2/memory-merge.js 的 asDoc / validateMemoryDoc 做 doc 规范化与校验，不重写 merge 语义。
//
// 非侵入铁律（AGENTS §3）：
//   ① 不写 agent 私有文件——落盘只走注入的 storage / dir，绝不默认写 ~/.workbuddy/ 或 ~/.hermes/。
//   ③ 门控默认关、shadow 默认开——mode 默认 'shadow'：只算不写盘，落盘需显式 'on'。
//   可回滚：纯内存 backing + 独立 storage，删本文件即回滚，不碰现有 adapter / profile / 热路径 4 文件。
//
// 形态：纯函数工厂 createMemoryAlign({reader,target,storage,logger,mode,...}) → {pull,push,status,readWatermark}。
//   可注入 storage（默认内存 createMemoryBacking），可注入 mock reader/target doc 与 mtime，demo/测试零副作用可跑。

const { asDoc, validateMemoryDoc } = require('./memory-merge.js');

// 对齐可纳入的 entry 类型（与 memory-merge.js 的 entry type 词表同源）。
const ALIGNED_ENTRY_TYPES = new Set(['preference', 'error-pattern', 'lesson', 'template', 'trigger']);

// 默认锚点：待办触发器 + 经验教训标记（与 WB MEMORY「⏳待办提醒」节、经验库落库 同源语义）。
const DEFAULT_TRIGGER_MARKERS = ['⏳', 'TODO', '待办', '待办提醒'];
const DEFAULT_LESSON_MARKERS = ['🔴', 'lesson', '教训', '根因'];

// 内存 backing（默认，零副作用，绝不写 home——非侵入）。
function createMemoryBacking() {
    const m = new Map(); // key = `${reader}->${target}` -> watermark entry
    return {
        get: (k) => m.get(k),
        set: (k, v) => { m.set(k, v); return v; },
        has: (k) => m.has(k),
        keys: () => [...m.keys()],
        size: () => m.size,
    };
}

function watermarkKey(reader, target) {
    return `${reader}->${target}`;
}

// 扫一行集合里命中的 marker（去重，保序）。
function scanMarkers(text, markers) {
    const found = new Set();
    const lines = String(text || '').split('\n');
    for (const line of lines) {
        for (const mk of markers) {
            if (line.includes(mk)) found.add(mk);
        }
    }
    return [...found];
}

function createMemoryAlign(opts = {}) {
    const {
        reader = 'hermes',
        target = 'workbuddy',
        storage = null,                                   // 注入 backing；默认内存，绝不默认写 home
        logger = { log() {} },
        mode = process.env.PROXY_MEMORY_ALIGN || 'shadow', // 'shadow'(默认,只算不写) / 'off'(跳过) / 'on'(落盘)
        now = () => new Date().toISOString(),
        scanMarkersFn = scanMarkers,
        TRIGGER_MARKERS = DEFAULT_TRIGGER_MARKERS,
        LESSON_MARKERS = DEFAULT_LESSON_MARKERS,
    } = opts;

    const backing = storage || createMemoryBacking();
    const key = watermarkKey(reader, target);

    // 规范化一个侧的 doc：复用 memory-merge.js 的 asDoc + validateMemoryDoc。
    function readSideDoc(raw) {
        const doc = asDoc(raw);
        const res = validateMemoryDoc(doc);
        if (res && res.valid === false) {
            throw new Error(`align: invalid ${raw === undefined ? 'raw' : 'side'} doc: ${(res.errors || []).join('; ')}`);
        }
        return doc;
    }

    // 读当前水位（不存在则给空水位）。
    function readWatermark() {
        const cur = backing.get(key);
        if (cur) return cur;
        return { specVersion: '1.0.0', reader, target, last_sync: null, absorbed: [], pending: [], _mtimeSeen: null, mode };
    }

    // pull：读 target 侧增量；mtime 前进才产出 absorbed（经对齐标记），登记进水位。
    // shadow/off 只算不落盘（backing 不写）；on 才写。
    function pull(targetRaw, targetMtime) {
        if (mode === 'off') return { skipped: true, reason: 'mode=off', watermark: readWatermark() };
        const doc = readSideDoc(targetRaw);
        const wm = readWatermark();
        const mtimeAdvanced = targetMtime != null && (wm._mtimeSeen == null || targetMtime > wm._mtimeSeen);
        let absorbed = [];
        if (mtimeAdvanced && Array.isArray(doc.entries)) {
            const text = doc.entries.map((e) => `${e.type || ''} ${e.key || ''} ${JSON.stringify(e.value ?? '')} ${(e.tags || []).join(' ')}`).join('\n');
            // hits 仅记录命中的 marker（审计用），吸收只按白名单类型（与 push 对称，note 等噪声不吸收）
            const hits = scanMarkersFn(text, [...TRIGGER_MARKERS, ...LESSON_MARKERS]);
            absorbed = doc.entries
                .filter((e) => ALIGNED_ENTRY_TYPES.has(e.type))
                .map((e) => ({
                   id: e.id, type: e.type, key: e.key, value: e.value,
                   tags: e.tags || [],
                   source: `${target}:${e.source || 'align-pull'}`,
                    _alignedAt: now(), _alignedFrom: target, _hitMarkers: hits,
                }));
        }
        wm.absorbed = [...(wm.absorbed || []), ...absorbed];
        wm._mtimeSeen = targetMtime != null ? targetMtime : wm._mtimeSeen;
        wm.last_sync = now();
         // shadow / on 都记账到 backing（内存或文件）；off 跳过。非侵入=backing 默认内存，不落盘 home。
        let wrote = false;
        if (mode !== 'off') {
            backing.set(key, wm);
            if (mode === 'on') wrote = true;
            else if (logger && logger.log) logger.log(`[align:shadow] pull ${reader}->${target} absorbed=${absorbed.length}`);
        }
        return { skipped: false, isNew: mtimeAdvanced, absorbed, watermark: wm, wrote, mode };
    }

    // push：把 reader 侧 pending entries 登记进水位。shadow 只算不落盘；on 才写。
    function push(entries) {
        if (mode === 'off') return { skipped: true, reason: 'mode=off', pushed: 0, watermark: readWatermark() };
        const wm = readWatermark();
        const list = Array.isArray(entries) ? entries : [];
        const norm = list
            .filter((e) => e && ALIGNED_ENTRY_TYPES.has(e.type))
            .map((e) => ({
                id: e.id, type: e.type, key: e.key, value: e.value,
                tags: e.tags || [],
                source: e.source || `${reader}:align-push`,
                _pushedAt: now(),
            }));
        wm.pending = [...(wm.pending || []), ...norm];
        wm.last_sync = now();
         // shadow / on 都记账到 backing；off 跳过。非侵入=backing 默认内存，不落盘 home。
        let wrote = false;
        if (mode !== 'off') {
            backing.set(key, wm);
            if (mode === 'on') wrote = true;
            else if (logger && logger.push_shadow) logger.push_shadow({ reader, target, count: norm.length, entries: norm });
        }
        return { skipped: false, pushed: norm.length, watermark: wm, wrote, mode };
    }

    // status：双向水位，供 dashboard 可见。
    function status() {
        const wm = readWatermark();
        return {
            reader, target, mode,
            last_sync: wm.last_sync,
            _mtimeSeen: wm._mtimeSeen,
            absorbedCount: (wm.absorbed || []).length,
            pendingCount: (wm.pending || []).length,
        };
    }

    return { pull, push, status, readWatermark, get key() { return key; }, get mode() { return mode; } };
}

module.exports = {
    createMemoryAlign,
    createMemoryBacking,
    scanMarkers,
    watermarkKey,
    ALIGNED_ENTRY_TYPES,
    DEFAULT_TRIGGER_MARKERS,
    DEFAULT_LESSON_MARKERS,
};
