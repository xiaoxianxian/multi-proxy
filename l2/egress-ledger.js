// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// egress-ledger.js —— L2 出站账本：客户端进程 × 目的地 host × 出站字节（P2 观测件，2026-10-17）
//
// 为什么要有这个账本（对立项的诚实交代，避免日后被当成"顺手加的功能"）：
//   ZCode 事件（智谱 Z.ai 桌面 coding agent，2026-09-18 由开发者 ferstar 曝光）：
//   登录后静默把整个工作区打包加密直传阿里云 OSS。一份 313MB `.enc` 里 42,411 个文件、
//   **`.git` 目录占 86.6%**，而加密私钥只在服务端——用户连自己磁盘上那份密文都解不开。
//   UI 上两个开关都不控制上传，登录即加载。
//
//   对照到 multi-proxy 的结论很硬：**现有任何一条防线都看不见它**（详见 pack.yaml 的
//   诚实边界、以及 Portico `27-出网机制B的PAC设计.md` 只点 AI 域名清单会漏非 AI 域）。
//   根因不是没实现，是**维度不对**：
//     - packs/sandbox-egress 管「内容维度」——lib/redact.js 七条规则全是凭证模式
//       （PEM 私钥 / JWT / sk-·ghp_·AKIA / 连接串密码 / 身份证 / 银行卡），
//       313MB 二进制 tar.gz 里一条也命中不了；
//     - 本账本补的是「**体量 + 目的地**」维度——不需要知道包里是什么，
//       只需要知道「谁往哪儿发了多少」。
//
//   三条可观测信号（v1 只做观测，一律不拦截）：
//     ① oversize        —— 单次出站字节超阈值。正常一次 LLM 请求受 context 上限约束，
//                          很少到几十 MB；整仓快照加密包一上来就是几百 MB。
//     ② unknown-host    —— 目的地 host 不在已知 provider 清单里。这是比①更锋利的一条：
//                           AI 客户端往对象存储发数据，本身就是越界信号。
//     ③ ratio           —— 出站字节 / token 字节当量失衡。ZCode 同款的前例：
//                           "模型推理不到 200KB，却上传了超过 5G 仓库内容"。
//
// 非侵入铁律（与 l2/ 其它内核同构）：
//   - 门控 PROXY_L2_EGRESS_LEDGER 默认关 = 全 no-op（不注入即零行为变更）；
//   - 零依赖（仅 node 内置）；纯函数优先（extractOutbound / classify / summarize 可单测）；
//   - 仅内存环形缓冲，默认不落盘（落盘形态留二期，与 savings-gateway 一期同纪律）；
//   - 诚实优先：拿不到字节数就记 bytesFound=false **并填 null**，绝不填 0 冒充「没出站」
//     ——同 relay-ledger 的 usageFound / savings-gateway C0-3「假成本数字」的三条同源纪律。
//
// 🔴 直说三件事（别被"维度不对"这种词绕晕）：
//   Q1 现在能发现 ZCode 这类吗？
//      → 不能。ZCode 直连阿里云 OSS，不经过 multi-proxy，我们压根看不见它。
//   Q2 以后（补完某些能力后）能发现吗？
//      → 在 multi-proxy 这一层：永远不能。它天生只看得见 LLM 流量，客户端直连在它视界之外。
//        在 Portico 那一层：能，但要把"按 AI 域名收口"升级成"按进程 × 任何目的地 default-deny"。
//        这一层今天没建，且 macOS 上成熟的强制方案（类似 Little Snitch 的进程级拦截）还没核到。
//   Q3 能拦 / 处理吗？
//      → 本账本永远不能拦（它是观测件不是防线）。真正能拦的是网络层 / 进程层（见 Portico `27`）。
//
//   一句话：这不是"没做所以没支持"，是两层不同的事——
//     multi-proxy = 架构性不能（视界之外）；Portico = 位置对、但今天没建到那一层。
//   ⇒ 因此本账本是「出网管控」的**观测件**，不是防线。请勿对外承诺它能"拦住整包外发"。
//
// 跑法：node --test l2/tests/egress-ledger.test.js

const GATE_ENV = 'PROXY_L2_EGRESS_LEDGER';

// token → 字节当量粗估。业界常用 1 token ≈ 4 bytes（英文），中文约 3 bytes/token。
// 这里统一取 4，作为量级判据的分母，**不是精确换算**——所以 named-benchmark 的结论
// 只当数量级信号用，不进账单、不当成本。
const DEFAULT_BYTES_PER_TOKEN = 4;
// 单次出站阈值 50MB。理由：主流模型的请求体受 context 窗口约束，正常到不了这个量级；
// 而整仓快照压缩包轻松几百 MB。阈值本身是可配的，别当普适常数。
const DEFAULT_OVERSIZE_BYTES = 50 * 1024 * 1024;
// 出站字节 / token 字节当量的失衡倍数阈值。正常编码会话: prompt 里带代码, 比值个位数到十几;
// 整包外传时 token 几乎为零而字节巨大, 比值会冲到成千上万, 量级差足够判。
const DEFAULT_RATIO_THRESHOLD = 20;
const DEFAULT_CAPACITY = 1000;

function gateOpen() {
    const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * 纯函数：算出站字节数。拿不到就返回 null（不猜、不填 0）。
 *
 * 三种可核形态：① 已给 bytes 直接用；② string → Buffer.byteLength（UTF-8 真实字节，
 * 不是字符数）；③ Buffer/Uint8Array → byteLength。
 * 走到对象/Object 分支时给 approximated=true —— JSON 序列化长度**不等于**线上真实
 * 字节（键名、空白、转义都会变），只能当估算用，所以必须把这层不确定标出来。
 *
 * @returns {{bytes:number|null, approximated:boolean}}
 */
function byteSizeOf(entry) {
    if (!entry || typeof entry !== 'object') return { bytes: null, approximated: false };
    if (Number.isFinite(entry.bytes)) return { bytes: entry.bytes, approximated: false };
    const body = entry.body;
    if (typeof body === 'string') return { bytes: Buffer.byteLength(body, 'utf8'), approximated: false };
    if (Buffer.isBuffer(body)) return { bytes: body.length, approximated: false };
    if (body instanceof Uint8Array) return { bytes: body.length, approximated: false };
    if (body != null && typeof body === 'object') {
        return { bytes: Buffer.byteLength(JSON.stringify(body), 'utf8'), approximated: true };
    }
    return { bytes: null, approximated: false };
}

/**
 * 纯函数：一条原始记录 → 标准化的出站行。挖不到字节/目的地一律置 null，不回填。
 *
 * @returns {{ts:number, client:string|null, destHost:string|null, bytes:number|null,
 *            bytesFound:boolean, approximated:boolean, tokens:number|null, proxy:string|null}}
 */
function extractOutbound(entry) {
    const e = (entry && typeof entry === 'object') ? entry : {};
    const size = byteSizeOf(e);
    const host = (typeof e.destHost === 'string' && e.destHost.length > 0)
        ? e.destHost
        : ((typeof e.upstreamHost === 'string' && e.upstreamHost.length > 0) ? e.upstreamHost : null);
    const tokens = Number.isFinite(e.tokens) ? e.tokens
        : (Number.isFinite(e.totalTokens) ? e.totalTokens : null);
    return {
        ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
        client: (typeof e.client === 'string' && e.client.length > 0) ? e.client : null,
        destHost: host,
        bytes: size.bytes,
        bytesFound: size.bytes != null,
        approximated: size.approximated,
        tokens,
        proxy: (typeof e.proxy === 'string' && e.proxy.length > 0) ? e.proxy : null,
    };
}

/**
 * 纯函数：单行的三条异常判据。返回 anomalies 数组（空 = 未见异常）与可回源的计算分量。
 *
 * 诚实纪律：tokens 缺失时 **不给 ratio**，而是单独标 tokensMissing=true 并让 ratio=null。
 * 理由：拿不到分母就空手算比值，等于拿 0 当分母或直接编一个，那是假数据；
 * 宁可这条只由 oversize / unknown-host 两条兜住，也不虚增一条「算出来了」的判据。
 */
function classify(row, opts = {}) {
    const o = (row && typeof row === 'object') ? row : {};
    const oversizeBytes = Number.isFinite(opts.oversizeBytes) ? opts.oversizeBytes : DEFAULT_OVERSIZE_BYTES;
    const ratioThreshold = Number.isFinite(opts.ratioThreshold) ? opts.ratioThreshold : DEFAULT_RATIO_THRESHOLD;
    const bytesPerToken = Number.isFinite(opts.bytesPerToken) ? opts.bytesPerToken : DEFAULT_BYTES_PER_TOKEN;
    const knownHosts = Array.isArray(opts.knownHosts) ? opts.knownHosts : null;

    const anomalies = [];
    const bytes = Number.isFinite(o.bytes) ? o.bytes : null;

    if (bytes != null && bytes > oversizeBytes) anomalies.push('oversize');

    const host = (typeof o.destHost === 'string' && o.destHost.length > 0) ? o.destHost : null;
    let hostKnown = null;
    if (knownHosts) {
        hostKnown = host != null && knownHosts.some((h) => host === h || host.endsWith(`.${h}`));
        if (host != null && !hostKnown) anomalies.push('unknown-host');
    }

    const tokens = Number.isFinite(o.tokens) ? o.tokens : null;
    const tokensMissing = tokens == null;
    // tokens 为 0 时（纯 outbound 无 LLM 成分）也不给比值——分母为 0 的比值没有意义，
    // 这类行交给 oversize / unknown-host 判，不靠一个除不出来的数充数。
    const expectedBytes = (!tokensMissing && tokens > 0) ? tokens * bytesPerToken : null;
    const ratio = (bytes != null && expectedBytes != null && expectedBytes > 0)
        ? Math.round((bytes / expectedBytes) * 1000) / 1000
        : null;
    if (ratio != null && ratio > ratioThreshold) anomalies.push('volume-token-ratio');

    return { anomalies, bytes, tokens, expectedBytes, ratio, hostKnown, tokensMissing };
}

/**
 * 纯函数：一组行 → 汇总报告。
 * 关键诚实字段：bytesFound / bytesMissing —— 挖不到字节的行单列，
 * 免得「总出站字节」被读成「全部出站」（少了的行没有消失，只是没量到）。
 */
function summarize(rows, opts = {}) {
    const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    let totalBytes = 0, bytesFound = 0, bytesMissing = 0, approximatedCount = 0;
    const perHost = {};
    const perClient = {};
    const anomalous = [];

    for (const r of list) {
        const c = classify(r, opts);
        if (c.bytes != null) {
            bytesFound += 1;
            totalBytes += c.bytes;
        } else {
            bytesMissing += 1;
        }
        if (r.approximated) approximatedCount += 1;

        const hKey = r.destHost || '<unknown>';
        const h = perHost[hKey] || { count: 0, bytes: 0, bytesMissing: 0 };
        h.count += 1;
        if (c.bytes != null) h.bytes += c.bytes; else h.bytesMissing += 1;
        perHost[hKey] = h;

        const cKey = r.client || '<unknown>';
        const cn = perClient[cKey] || { count: 0, bytes: 0, bytesMissing: 0, anomalies: 0 };
        cn.count += 1;
        if (c.bytes != null) cn.bytes += c.bytes; else cn.bytesMissing += 1;
        cn.anomalies += c.anomalies.length;
        perClient[cKey] = cn;

        if (c.anomalies.length) {
            anomalous.push({
                ts: r.ts, client: r.client, destHost: r.destHost,
                bytes: c.bytes, ratio: c.ratio, anomalies: c.anomalies,
            });
        }
    }

    return {
        rowCount: list.length,
        bytesFound,
        bytesMissing,
        approximatedCount,
        totalBytes,
        perHost,
        perClient,
        anomalousCount: anomalous.length,
        anomalous: anomalous.slice(0, 50),
    };
}

// 工厂：每实例独立 store（测试隔离），与 l2/ 其它内核同构
function createEgressLedger(opts = {}) {
    const capacity = Number.isFinite(opts.logCapacity) ? opts.logCapacity : DEFAULT_CAPACITY;
    const classifyOpts = opts.classify || {};
    const rows = [];

    function record(entry) {
        const row = extractOutbound(entry);
        rows.push(row);
        if (rows.length > capacity) rows.splice(0, rows.length - capacity);
        return row;
    }

    function report(filter) {
        const list = (filter && typeof filter === 'object')
            ? rows.filter((r) => {
                for (const [k, v] of Object.entries(filter)) {
                    if (r[k] !== v) return false;
                }
                return true;
            })
            : rows;
        return summarize(list, classifyOpts);
    }

    function getRows(filter) {
        if (filter && typeof filter === 'object') {
            return rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        }
        return rows.slice();
    }

    return { record, report, getRows, summarize: (r) => summarize(r, classifyOpts), classify: (r) => classify(r, classifyOpts), size: () => rows.length };
}

const _ledger = createEgressLedger();
module.exports = {
    GATE_ENV,
    gateOpen,
    DEFAULT_BYTES_PER_TOKEN,
    DEFAULT_OVERSIZE_BYTES,
    DEFAULT_RATIO_THRESHOLD,
    byteSizeOf,
    extractOutbound,
    classify,
    summarize,
    createEgressLedger,
    // 单例转发（进程级常驻账本；生产经 routes/ 注入同一个实例）
    record: _ledger.record,
    report: _ledger.report,
    getRows: _ledger.getRows,
};
