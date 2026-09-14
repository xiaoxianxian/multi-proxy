'use strict';

// L1 chat 型 agent adapter —— 把 codex-proxy / hermes-proxy 包成可接入 Agent Registry 的 adapter。
// 是 Agent Adapter 协议（见 adapter-protocol.md）的「chat 型」分支（非任务队列型，区别于 aigc/h3web）。
//
// 实测铁律（据两代理真实契约核实，非臆测）：
//   - 都是 OpenAI 兼容代理：GET /health + GET /v1/models 共享；鉴权用 x-proxy-auth: <token>（非 Bearer）
//   - Codex（Node :18790）有 POST /v1/chat/completions → chat 可 invoke
//   - Hermes（Python/Flask :18793）**无 /v1/chat/completions**（chat 由 Hermes 自身转发到 Ollama/Qwen）
//     → Hermes 侧无 chat 端点，本 adapter 退化为「能力发现型」（health + 模型发现），无 chat 语义
//
// 协议四类接口映射（chat 型）：
//   1. 能力声明 capabilitiesDeclaration() —— 能力标签来自调用方/registry（agent 自身不暴露能力接口）
//   2. 健康检查 health()                  —— GET /health（codex/hermes 共享）
//   3-4. 任务接收/结果回传 invoke(task)   —— 同步：一发 chat 请求一次返回结果；无 chat 端点（hermes）退化为
//        发现调用（GET /v1/models）；agent 不持久化 task_id，故无异步轮询。
//
// 铁律（adapter-protocol.md §五，全程遵守）：
//   ① 只读：adapter 只「拦住 → 注入 x-proxy-auth → 转发」，不写两代理任何文件、不改其配置。
//   ② 端口动态探测：绝不写死。候选端口谁在 LISTEN 用谁，否则用注入端口（mock/测试）。
//   ③ 零依赖：仅 node 内置 http + net + crypto（任务编号）。
//   ④ 密钥：token（PROXY_AUTH_TOKEN）由调用方注入；adapter 不打印、不落盘。鉴权关闭（PROXY_AUTH_TOKEN
//      未设）时，两代理开放（无 token 即过）——这是实测现状。

const http = require('http');
const crypto = require('crypto');

// ---- 动态端口探测（绝不写死，同 h3web/aigc 范式）----
function netPortFree(port) {
    return new Promise((res) => {
        const net = require('net');
        const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); res(false); }); // 能连=有服务在听
        s.on('error', () => res(true)); // 连不上=空闲
        s.setTimeout(500);
        s.on('timeout', () => { s.destroy(); res(true); });
    });
}

// 候选端口取第一个「有服务在监听」的；都没有则 fall back 到 injectedPort。
async function probePort(candidates, injectedPort) {
    for (const p of candidates) {
        if (!(await netPortFree(p))) return p; // 占用 = 有人在 LISTEN
    }
    return injectedPort; // 全空时用注入端口（mock 测试场景）
}

function httpGetJson(host, port, pathStr, headers = {}, timeoutMs = 8000) {
    return new Promise((res, rej) => {
        const req = http.get({ host, port, path: pathStr, timeout: timeoutMs, headers }, (r) => {
            let buf = '';
            r.on('data', (c) => { buf += c; });
            r.on('end', () => res({ status: r.statusCode, body: buf }));
        });
        req.on('error', rej);
        req.setTimeout(timeoutMs, () => { req.destroy(); rej(new Error('timeout')); });
    });
}

function httpPostJson(host, port, pathStr, obj, headers = {}, timeoutMs = 120000) {
    return new Promise((res, rej) => {
        const data = Buffer.from(JSON.stringify(obj));
        const req = http.request(
            { host, port, path: pathStr, method: 'POST', timeout: timeoutMs,
              headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } },
            (r) => {
                let buf = '';
                r.on('data', (c) => { buf += c; });
                r.on('end', () => res({ status: r.statusCode, body: buf }));
            });
        req.on('error', rej);
        req.setTimeout(timeoutMs, () => { req.destroy(); rej(new Error('chat timeout')); });
        req.write(data);
        req.end();
    });
}

// L1 chat 型 agent 的默认能力（来自 registry 注册，非 agent 自报）
const DEFAULT_CAPABILITIES = ['code', 'writing'];

class L1AgentAdapter {
    constructor(opts = {}) {
        this.id = opts.id || 'l1-agent';
        this.name = opts.name || 'L1 chat agent';
        this.transport = opts.transport || ['http'];
        this.capabilities = opts.capabilities || [...DEFAULT_CAPABILITIES];
        // 非任务队列：chat 型是同步 invoke（无 task_id 持久化/轮询）
        this.supportsTaskQueue = opts.supportsTaskQueue !== undefined ? opts.supportsTaskQueue : false;
        this.portCandidates = opts.portCandidates || []; // 调用方注入（codex [18790,18791] / hermes [18793,18792]）
        this.injectedPort = opts.port;
        this.host = opts.host || '127.0.0.1';
        this.healthPath = opts.healthPath || '/health';
        this.modelsPath = opts.modelsPath || '/v1/models';
        // chat 端点：有则 invoke 走 chat；无（hermes）则 invoke 退化为发现调用
        this.chatPath = opts.chatPath; // codex: '/v1/chat/completions'；hermes: undefined
        this.timeoutMs = opts.timeoutMs || 120000;
        // token = PROXY_AUTH_TOKEN（鉴权关闭时调用方传 undefined，则不带 x-proxy-auth）
        this._token = opts.token;
        this._resolvedPort = null;
    }

    // 内部：x-proxy-auth 头（无 token 则不加 → 两代理当前鉴权开放，无 token 也过）
    _authHeaders(extra = {}) {
        const h = { ...extra };
        if (this._token) h['x-proxy-auth'] = this._token;
        return h;
    }

    // 动态锁定端口（首次 resolve 后缓存）
    async _resolveTarget() {
        if (this._resolvedPort) return { host: this.host, port: this._resolvedPort };
        const port = await probePort(this.portCandidates, this.injectedPort);
        this._resolvedPort = port;
        return { host: this.host, port };
    }

    // ---- 接口 1：能力声明（向 Agent Registry 注册能力的源；能力标签来自注册，非 agent 自报）----
    capabilitiesDeclaration() {
        return {
            adapter: this.id,
            version: '1.0.0',
            transport: this.transport,
            capabilities: this.capabilities,
            supportsTaskQueue: this.supportsTaskQueue,
            isChatAgent: true,
            supportsChat: !!this.chatPath, // codex=true；hermes=无 chat 端点
            healthEndpoint: this.healthPath,
            modelsEndpoint: this.modelsPath,
        };
    }

    // ---- 接口 2：健康检查（GET /health，两代理共享）----
    async health() {
        const { host, port } = await this._resolveTarget();
        const r = await httpGetJson(host, port, this.healthPath, this._authHeaders(), 8000);
        let ok = false;
        let status = 'down';
        if (r.status === 200) {
            try {
                const j = JSON.parse(r.body);
                ok = true;
                // codex 返 status: healthy|degraded|down；hermes 返 status: ok。两者 200 即进程活
                status = j.status || 'ok';
                if (j.status === 'down') ok = false; // 进程在但自检判定 down（非进程宕）
            } catch { ok = true; status = 'ok'; } // 非 JSON 也 200 算活
        }
        return { ok, status, port, capabilities: this.capabilities, raw: r.status };
    }

    // ---- /v1/models 发现（两代理共享；能力/在线模型发现的源）----
    async listModels() {
        const { host, port } = await this._resolveTarget();
        const r = await httpGetJson(host, port, this.modelsPath, this._authHeaders(), 8000);
        if (r.status === 401) throw new Error('L1 agent auth failed: 401 (x-proxy-auth 缺失/过期)');
        if (r.status !== 200) throw new Error(`L1 agent /v1/models failed: HTTP ${r.status}`);
        const j = JSON.parse(r.body);
        return j.data || []; // OpenAI /v1/models 形态：{ object:'list', data:[{id,...}] }
    }

    // ---- 接口 3-4：任务接收/结果回传（chat 型同步 invoke；hermes 无 chat 端点退化为发现）----
    // task: { model, messages, stream? } → chat 同步返回 { id, content, model }
    // hermes（无 chat 端点）：task 走发现，返回 available_models（不臆造 chat 语义）
    async invoke(task) {
        if (!task) throw new Error('invoke(task) required');
        const { host, port } = await this._resolveTarget();
        const taskId = 'l1_' + crypto.randomBytes(6).toString('hex'); // adapter 本地发号（agent 不持久化）

        if (!this.chatPath) {
            // 无 chat 端点（hermes）：不做 chat，退化为能力发现，如实返回
            const models = await this.listModels();
            return {
                task_id: taskId,
                type: 'discovery',
                state: 'done',
                agent: this.id,
                note: `${this.id} 无 chat 端点（chat 由下游转发到 Ollama/Qwen）；退化为能力发现`,
                result: { available_models: models.map((m) => m.id) },
                error: null,
            };
        }

        // chat 端点（codex）：POST /v1/chat/completions，注入 x-proxy-auth，同步返回
        const body = {
            model: task.model || 'default',
            messages: task.messages || [],
            ...(task.stream !== undefined ? { stream: task.stream } : {}),
        };
        const r = await httpPostJson(host, port, this.chatPath, body, this._authHeaders(), this.timeoutMs);
        if (r.status === 401) throw new Error(`L1 agent auth failed: 401 (task ${taskId})`);
        if (r.status !== 200) throw new Error(`L1 agent chat failed: HTTP ${r.status} (task ${taskId})`);
        let parsed;
        try {
            parsed = JSON.parse(r.body);
        } catch {
            parsed = { raw: r.body };
        }
        // OpenAI /v1/chat/completions 形态：{ id, choices:[{message:{content}}] }
        const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message
            ? parsed.choices[0].message.content
            : null;
        return {
            task_id: taskId,
            type: 'chat',
            state: 'done',
            agent: this.id,
            result: { content, model: parsed.model || body.model, id: parsed.id || taskId, raw: parsed.raw ? undefined : parsed },
            error: null,
        };
    }

    // 便捷别名：同步一发一回（chat 型无轮询）
    async run(task) {
        return this.invoke(task);
    }
}

module.exports = { L1AgentAdapter, probePort };
