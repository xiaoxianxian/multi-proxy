'use strict';

// AIGC(hujing-ai) adapter —— 实现 Agent Adapter 协议（见 adapter-protocol.md）的样例。
// 把一个本地 HTTP 服务（绘境 AI / 生图生视频，FastAPI + OAuth2）包成可接入 Agent Registry 的 adapter。
//
// 铁律（adapter-protocol.md §五）：
//    ① 对 AIGC 只读：adapter 只"拦住 → 注入 Bearer → 转发"，不写 AIGC 任何文件、不改其配置。
//    ② 端口动态探测：绝不写死。探测候选端口（默认 [8731, 8732]，AIGC 实测漂移）谁在 LISTEN 就用谁，
//       没有则用调用方注入的 port（零副作用的 mock / 测试场景）。
//    ③ 零依赖：仅 node 内置 http + net。
//    ④ 密钥：token 由调用方注入（来自 AIGC 登录/OAuth2），adapter 不打印、不落盘。
//
// 与 h3web adapter 的三处差异（据 AIGC 真实契约核实）：
//     a) OAuth2：所有 /api/v1/* 需 Authorization: Bearer <token>（h3web 无鉴权）。
//     b) 路径前缀 /api/v1（h3web 是 /api/gen）。AIGC 自带 /api/v1/health，无需补桩。
//     c) 任务状态机 pending → processing → 终态 completed|failed|cancelled；有 cancel 接口
//       （支撑 M7 session 崩溃恢复 / 手动中止的 abort 语义，h3web 无）。
//
// 协议四类接口：
//     - 能力声明  capabilitiesDeclaration()
//     - 健康检查  health()                （GET /api/v1/health）
//     - 任务接收  submit(task)           （POST /api/v1/tasks，返回 task_id）
//     - 结果回传  result(task_id)        （GET /api/v1/tasks/:id）
//     - 取消      cancel(task_id)        （POST /api/v1/tasks/:id/cancel，AIGC 独有）
//
// 热插拔：adapter 是普通对象，可被 PluginRuntime load/unload，不随项目重启。

const http = require('http');

// ---- 动态端口探测（绝不写死，同 h3web）----
function netPortFree(port) {
    return new Promise((res) => {
        const net = require('net');
        const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); res(false); });
        s.on('error', () => res(true));
        s.setTimeout(500);
        s.on('timeout', () => { s.destroy(); res(true); });
    });
}

async function probePort(candidates, injectedPort) {
    for (const p of candidates) {
        const free = await netPortFree(p);
        if (!free) return p; // 占用 = 有人在 LISTEN
    }
    return injectedPort; // 全空时用注入端口（mock 测试场景）
}

// subtype → 能力标签映射（向 Registry 声明能力；AIGC 7 种 subtype 覆盖图/视频全链路）
const SUBTYPE_CAPABILITIES = {
    text_to_image:    ['image', 'text2image'],
    image_to_image:   ['image', 'img2img'],
    matting:          ['image', 'matting'],
    outpainting:      ['image', 'outpainting'],
    background_replace: ['image', 'bg-replace'],
    style_transfer:   ['image', 'style-transfer'],
    image_to_video:   ['image', 'video', 'img2video'],
};

function httpGetJson(host, port, pathStr, headers = {}, timeoutMs = 8000) {
    return new Promise((res, rej) => {
        const req = http.get(
            { host, port, path: pathStr, timeout: timeoutMs, headers },
            (r) => {
                let buf = '';
                r.on('data', (c) => { buf += c; });
                r.on('end', () => res({ status: r.statusCode, body: buf }));
            });
        req.on('error', rej);
        req.setTimeout(timeoutMs, () => { req.destroy(); rej(new Error('timeout')); });
    });
}

class AigcAdapter {
    constructor(opts = {}) {
        this.id = opts.id || 'aigc';
        this.name = opts.name || 'AIGC (local 绘境 AI 生图生视频)';
        this.transport = opts.transport || ['http'];
        // 7 种 subtype → 能力合集（去重）
        const caps = new Set();
        for (const list of Object.values(SUBTYPE_CAPABILITIES)) list.forEach((c) => caps.add(c));
        this.capabilities = opts.capabilities || [...caps];
        this.supportsTaskQueue = opts.supportsTaskQueue !== undefined ? opts.supportsTaskQueue : false;
        this.portCandidates = opts.portCandidates || [8731, 8732];
        this.injectedPort = opts.port;
        this.host = opts.host || '127.0.0.1';
        this.prefix = opts.prefix || '/api/v1';
        this.healthPath = opts.healthPath || `${this.prefix}/health`;
        this.timeoutMs = opts.timeoutMs || 900000;
        // token 由调用方注入；绝不打印、不落盘
        this._token = opts.token || null;
        this._resolvedPort = null;
    }

    // ---- 内部：带 Bearer 的请求头 ----
    _authHeaders(extra = {}) {
        const h = { ...extra };
        if (this._token) h['Authorization'] = `Bearer ${this._token}`;
        return h;
    }

    // 动态锁定 AIGC 端口（首次 resolve 后缓存）
    async _resolveTarget() {
        if (this._resolvedPort) return { host: this.host, port: this._resolvedPort };
        const port = await probePort(this.portCandidates, this.injectedPort);
        this._resolvedPort = port;
        return { host: this.host, port };
    }

    // 接口 1：能力声明（向 Agent Registry 注册能力的源）
    capabilitiesDeclaration() {
        return {
            adapter: this.id,
            version: '1.0.0',
            transport: this.transport,
            capabilities: this.capabilities,
            supportsTaskQueue: this.supportsTaskQueue,
            supportsCancel: true, // AIGC 独有，区别于 h3web
            healthEndpoint: this.healthPath,
        };
    }

    // 接口 2：健康检查（AIGC 原生有 /api/v1/health，无需补桩）
    async health() {
        const { host, port } = await this._resolveTarget();
        const r = await httpGetJson(host, port, this.healthPath, {}, 8000);
        let ok = false;
        if (r.status === 200) {
            try { const j = JSON.parse(r.body); ok = (!j.status || j.status === 'ok' || j.overall === 'healthy' || true); }
            catch { ok = r.status === 200; } // 200 即活
        }
        return { ok: r.status === 200, port, capabilities: this.capabilities, raw: r.status };
    }

    // 接口 3：任务接收（POST /api/v1/tasks，注入 Bearer）
    async submit(task) {
       if (!task || !task.subtype) throw new Error('task.subtype required (one of 7)');
       const allowed = Object.keys(SUBTYPE_CAPABILITIES);
       if (!allowed.includes(task.subtype)) throw new Error(`unknown subtype ${task.subtype} (one of ${allowed.join('/')})`);
       const { host, port } = await this._resolveTarget();
       const data = Buffer.from(JSON.stringify({ subtype: task.subtype, params: task.params || {} }));
       const done = await new Promise((res, rej) => {
            const req = http.request(
                {
                    host, port, path: `${this.prefix}/tasks`, method: 'POST', timeout: 30000,
                    headers: this._authHeaders({
                        'Content-Type': 'application/json',
                        'Content-Length': data.length,
                    }),
                },
                (r) => {
                    let buf = '';
                    r.on('data', (c) => { buf += c; });
                    r.on('end', () => res({ status: r.statusCode, body: buf }));
                });
            req.on('error', rej);
            req.setTimeout(30000, () => { req.destroy(); rej(new Error('submit timeout')); });
            req.write(data);
            req.end();
        });
        if (done.status === 401) throw new Error('AIGC auth failed: 401 (token 缺失/过期)');
        if (done.status !== 200) throw new Error(`AIGC submit failed: HTTP ${done.status}`);
        const j = JSON.parse(done.body);
        if (!j.id) throw new Error('AIGC /api/v1/tasks 未返回 id');
        return { task_id: j.id, state: j.status || 'pending' };
    }

    // 接口 4：结果回传（GET /api/v1/tasks/:id）
    async result(taskId) {
        const { host, port } = await this._resolveTarget();
        const r = await httpGetJson(host, port, `${this.prefix}/tasks/${taskId}`, this._authHeaders(), 30000);
        if (r.status === 401) throw new Error('AIGC auth failed: 401');
        if (r.status === 404) throw new Error(`task ${taskId} not found`);
        if (r.status !== 200) throw new Error(`AIGC result failed: HTTP ${r.status}`);
        return JSON.parse(r.body);
    }

    // AIGC 独有：取消任务（POST /api/v1/tasks/:id/cancel）— 支撑 M7 session abort/崩溃恢复
    async cancel(taskId) {
        const { host, port } = await this._resolveTarget();
        const done = await new Promise((res, rej) => {
            const req = http.request(
                {
                    host, port, path: `${this.prefix}/tasks/${taskId}/cancel`, method: 'POST', timeout: 30000,
                    headers: this._authHeaders({ 'Content-Type': 'application/json' }),
                },
                (r) => {
                    let buf = '';
                    r.on('data', (c) => { buf += c; });
                    r.on('end', () => res({ status: r.statusCode, body: buf }));
                });
            req.on('error', rej);
            req.setTimeout(30000, () => { req.destroy(); rej(new Error('cancel timeout')); });
            req.end();
        });
        if (done.status === 404) throw new Error(`task ${taskId} not found`);
        if (done.status !== 200) throw new Error(`AIGC cancel failed: HTTP ${done.status}`);
        return JSON.parse(done.body);
    }

    // 便捷：提交 + 轮询到终态（非侵入，纯读转发）。终态 = completed | failed | cancelled。
    async run(task, { pollMs = 200, maxTries = 60 } = {}) {
        const { task_id } = await this.submit(task);
        for (let i = 0; i < maxTries; i += 1) {
            const r = await this.result(task_id);
            if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') {
                return { task_id, ...r };
            }
            await new Promise((res) => setTimeout(res, pollMs));
        }
        throw new Error(`task ${task_id} not terminal in time`);
    }
}

// 导出 subtype→能力映射 + 探测工具（供 demo / 测试）
module.exports = { AigcAdapter, probePort, SUBTYPE_CAPABILITIES };
