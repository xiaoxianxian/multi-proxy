'use strict';

// h3web adapter —— 实现 Agent Adapter 协议（见 adapter-protocol.md）的样例。
// 把一个本地 HTTP 服务（本地 Minimax H3 视频工具）包成可接入 Agent Registry 的 adapter。
//
// 铁律（adapter-protocol.md §五）：
//    ① 对 h3web 只读：adapter 只"拦住 → 转发 → 注入环境变量"，不写 h3web 任何文件、不改其端口配置。
//    ② 端口动态探测：绝不写死。探测候选端口（默认 [8731, 8732]）谁在 LISTEN 就用谁，
//       没有则用调用方注入的 port（零副作用的 mock / 测试场景）。
//    ③ 零依赖：仅 node 内置 http + net。
//
// 协议四类接口：
//    - 能力声明 getCapabilities()
//    - 健康检查 health()              （GET healthPath）
//    - 任务接收 submit(task)          （POST /api/gen 转发到 h3web，返回 task_id）
//    - 结果回传 result(task_id)       （GET /api/status/:id 转发到 h3web）
//
// 热插拔：adapter 是普通对象，可被 PluginRuntime load/unload，不随项目重启。

const http = require('http');

// ---- 可透传给 h3web POST /api/gen 的字段白名单 ----
// 对齐 h3web.py 的 build_args() 认的 key（2026-10-01 实测：代码默认宽高 512×512、steps 20、
// seconds 5 —— 768×1344 是 UI 表单默认值，不是 API 默认）。
// 为什么用白名单而不是「整个 task 全透传」：build_args 只从 p 里挑自己认的 key，
// 传错名（比如写 `size` 而不是 `width`）**不会报错，会静默回落到 512×512 默认档**，
// 出片看着「成功」但分辨率不对。白名单让拼错字段名在单测里立刻炸，而不是变成假成功。
// 注意：gen_mode='draft' 会在 h3web 侧被强制改写为 steps≤16 / 384×672，
// 与「要 768×1344 竖屏成片」互斥 —— 想竖屏成片必须走 final 档再显式给 width/height。
//
// ---- 省时的真正大头：性能参数，不是 gen_mode 标志 ----
// 2026-10-02 同尺寸（384×672 / steps 16）三档对照实测：
//     只降 steps=16（默认 layers50/reuse3/token_reduction 关） → 12.2 min
//     final 档手动给 layers40/reuse2/token_reduction         →  5.5 min   （省 55%）
//     再叠 gen_mode='draft' 标志                              →  4.8 min   （只再省 13%）
// build_args(h3web.py:1634-1654) 独立消费 layers/reuse/token_reduction/ssd_streaming，
// **与 gen_mode 完全解耦、不改写尺寸**。所以 opts.perf 比 genMode='draft' 干净：
// 省时的同时保住调用方指定的分辨率。
const H3WEB_GEN_FIELDS = [
    'gen_mode', 'steps', 'width', 'height', 'seconds', 'frames',
    'layers', 'reuse', 'core_reuse',
    'token_reduction', 'ssd_streaming', 'seed', 'int8',
    'first_frame', 'last_frame', 'ref_images', 'ref_video', 'ref_audio',
    'ratio', 'ir',
];

// ---- 省时性能预设（opts.perf）—— 一键塞 final 档，不改写尺寸 ----
// 取自 draft 档那套参数，但作用在 final 档：尺寸完全由调用方决定，
// 不会被 h3web 侧强转成 384×672。task 里显式给的同名 key 优先级更高（不会被覆盖）。
const PERF_PRESET = Object.freeze({ layers: 40, reuse: 2, token_reduction: true, ssd_streaming: true });

// ---- 动态端口探测（绝不写死）----
function netPortFree(port) {
    return new Promise((res) => {
        const net = require('net');
        const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); res(false); }); // 能连=占用=有人在听
        s.on('error', () => res(true)); // 连不上=空闲
        s.setTimeout(500);
        s.on('timeout', () => { s.destroy(); res(true); });
    });
}

// 候选端口取第一个"有服务在监听"的；都没有则 fall back 到 injectedPort。
async function probePort(candidates, injectedPort) {
    for (const p of candidates) {
        const free = await netPortFree(p);
        if (!free) return p; // 占用 = 有人在 LISTEN
    }
    return injectedPort; // 全空时用注入端口（mock 测试场景）
}

function httpGetJson(host, port, pathStr) {
    return new Promise((res, rej) => {
        const req = http.get({ host, port, path: pathStr, timeout: 8000 }, (r) => {
            let buf = '';
            r.on('data', (c) => { buf += c; });
            r.on('end', () => res({ status: r.statusCode, body: buf }));
        });
        req.on('error', rej);
        req.setTimeout(8000, () => { req.destroy(); rej(new Error('timeout')); });
    });
}

function httpPostJson(host, port, pathStr, obj) {
    return new Promise((res, rej) => {
        const data = Buffer.from(JSON.stringify(obj));
        const req = http.request(
            { host, port, path: pathStr, method: 'POST', timeout: 8000,
              headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
            (r) => {
                let buf = '';
                r.on('data', (c) => { buf += c; });
                r.on('end', () => res({ status: r.statusCode, body: buf }));
            }
        );
        req.on('error', rej);
        req.setTimeout(8000, () => { req.destroy(); rej(new Error('timeout')); });
        req.write(data);
        req.end();
     });
}

class H3webAdapter {
    constructor(opts = {}) {
        this.id = opts.id || 'h3web';
        this.name = opts.name || 'h3web (local Minimax H3 video)';
        this.transport = opts.transport || ['http'];
        // 'compose'（2026-10-01 补）：与 registry profile（mcp-default-seed.js 的 h3web）保持同源，
        // 避免「registry 说能接、adapter 自己说不能」的声明分裂。视频合成（compose）归 h3web 承接，
        // 观察态真跑 §4.2 缺口 A：此前该 capability 无任何 owner → 路由无候选。
        this.capabilities = opts.capabilities || ['video', 'text2video', 'lipsync', 'image', 'compose'];
        this.supportsTaskQueue = opts.supportsTaskQueue !== undefined ? opts.supportsTaskQueue : false;
        this.portCandidates = opts.portCandidates || [8731, 8732];
        this.injectedPort = opts.port;        // 调用方注入（mock 测试 / 非默认环境）
        this.healthPath = opts.healthPath || '/';
        // 真实 h3web 端点（只读转发，不改 h3web）
        this.genPath = opts.genPath || '/api/gen';
        this.statusPathBase = opts.statusPathBase || '/api/status';
        this.timeoutMs = opts.timeoutMs || 900000;
        // 省时预设只读暴露，调用方可先读再决定用不用（也便于文档/route 里拿去拼 task）
        this.perfPreset = PERF_PRESET;
        this._resolvedPort = null;
        this._resolvedHost = '127.0.0.1';
    }

    // 动态锁定 h3web 端口（首次 resolve 后缓存）
    async _resolveTarget() {
        if (this._resolvedPort) return { host: this._resolvedHost, port: this._resolvedPort };
        const port = await probePort(this.portCandidates, this.injectedPort);
        this._resolvedPort = port;
        return { host: this._resolvedHost, port };
    }

    // 接口 1：能力声明（向 Agent Registry 注册能力的源）
    capabilitiesDeclaration() {
        return {
            adapter: this.id,
            version: '1.0.0',
            transport: this.transport,
            capabilities: this.capabilities,
            supportsTaskQueue: this.supportsTaskQueue,
            healthEndpoint: this.healthPath,
        };
    }

    // 接口 2：健康检查
    async health() {
        const { host, port } = await this._resolveTarget();
        const r = await httpGetJson(host, port, this.healthPath);
        let ok = false;
        if (r.status === 200) {
            try { JSON.parse(r.body); ok = true; } catch { /* h3web 根路径返 SPA HTML，非 JSON 也算活 */ }
            if (r.status === 200) ok = true;
        }
        return { ok, port, capabilities: this.capabilities, raw: r.status };
    }

    // 接口 3：任务接收（转发到 h3web /api/gen）
    // task 里按 H3WEB_GEN_FIELDS 白名单透传档位；两个便捷开关：
    //   opts.genMode='draft' —— 省时最少（实测 13%），且尺寸会被强制改写，只适合不看分辨率的草稿；
    //   opts.perf            —— 省时最多（实测 55%）且不动尺寸，final 档专用，推荐走这个。
    // return 体里的 echo = 本次真正发出去的 payload，调用方可自证「我传的档位到了下游」。
    async submit(task, opts = {}) {
        if (!task || !task.type) throw new Error('task.type required');
        const { host, port } = await this._resolveTarget();
        const payload = { prompt: task.prompt || '' };
        for (const k of H3WEB_GEN_FIELDS) {
            if (task[k] !== undefined && task[k] !== null) payload[k] = task[k];
        }
        if (opts.perf) {
            // opts.perf===true → 用预设；传对象 → 预设叠加自定义微调（如 {layers:32}）。
            // 只补 task 没显式给的同名 key，显式值优先，避免预设悄悄覆盖调用方的选择。
            const preset = opts.perf === true ? PERF_PRESET : { ...PERF_PRESET, ...opts.perf };
            for (const [k, v] of Object.entries(preset)) {
                if (payload[k] === undefined) payload[k] = v;
            }
        }
        if (opts.genMode) payload.gen_mode = opts.genMode;
        if (opts.steps) payload.steps = opts.steps;
        if (opts.width) payload.width = opts.width;
        if (opts.height) payload.height = opts.height;
        const r = await httpPostJson(host, port, this.genPath, payload);
        if (r.status !== 200) throw new Error(`h3web submit failed: HTTP ${r.status}`);
        const j = JSON.parse(r.body);
        if (!j.job_id) throw new Error('h3web /api/gen did not return job_id');
        return { task_id: j.job_id, state: j.status || 'pending', echo: payload };
    }

    // 接口 4：结果回传（转发到 h3web /api/status/:id）
    async result(taskId) {
        const { host, port } = await this._resolveTarget();
        const r = await httpGetJson(host, port, `${this.statusPathBase}/${taskId}`);
        if (r.status === 404) throw new Error(`task ${taskId} not found`);
        return JSON.parse(r.body);
    }

    // 便捷：提交 + 轮询到终态（非侵入，纯读转发）
    async run(task, { pollMs = 200, maxTries = 30 } = {}) {
        const { task_id } = await this.submit(task);
        for (let i = 0; i < maxTries; i += 1) {
            const r = await this.result(task_id);
            if (r.status === 'done' || r.status === 'failed') {
                return { task_id, ...r };
            }
            await new Promise((res) => setTimeout(res, pollMs));
        }
        throw new Error(`task ${task_id} not terminal in time`);
    }
}

module.exports = { H3webAdapter, probePort, PERF_PRESET };
