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
        this.capabilities = opts.capabilities || ['video', 'text2video', 'lipsync', 'image'];
        this.supportsTaskQueue = opts.supportsTaskQueue !== undefined ? opts.supportsTaskQueue : false;
        this.portCandidates = opts.portCandidates || [8731, 8732];
        this.injectedPort = opts.port;        // 调用方注入（mock 测试 / 非默认环境）
        this.healthPath = opts.healthPath || '/';
        // 真实 h3web 端点（只读转发，不改 h3web）
        this.genPath = opts.genPath || '/api/gen';
        this.statusPathBase = opts.statusPathBase || '/api/status';
        this.timeoutMs = opts.timeoutMs || 900000;
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
    async submit(task) {
        if (!task || !task.type) throw new Error('task.type required');
        const { host, port } = await this._resolveTarget();
        const r = await httpPostJson(host, port, this.genPath, { prompt: task.prompt || '', type: task.type });
        if (r.status !== 200) throw new Error(`h3web submit failed: HTTP ${r.status}`);
        const j = JSON.parse(r.body);
        if (!j.job_id) throw new Error('h3web /api/gen did not return job_id');
        return { task_id: j.job_id, state: j.state || 'pending' };
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
            if (r.state === 'done' || r.state === 'failed') {
                return { task_id, ...r };
            }
            await new Promise((res) => setTimeout(res, pollMs));
        }
        throw new Error(`task ${task_id} not terminal in time`);
    }
}

module.exports = { H3webAdapter, probePort };
