// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

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
// 上游限流/5xx/网络错的退避重试底座（零依赖，仅 node 内置）
const { withHttpRetry } = require('../http-retry.js');
function retryLogger(n, info) {
  if (process.env.PROXY_DEBUG) console.warn('[l1-agent-adapter] 上游重试 #' + n, info);
}
// 共享底座（质量工程 §三）：默认能力/默认模型唯一事实源（原本文件硬编码已迁入）。
const { adapterDefaults } = require('../knowledge-base/routing-base.js');

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
                r.on('end', () => res({ status: r.statusCode, body: buf, headers: r.headers }));
            });
        req.on('error', rej);
        req.setTimeout(timeoutMs, () => { req.destroy(); rej(new Error('chat timeout')); });
        req.write(data);
        req.end();
    });
}

// L1 chat 型 agent 的默认能力：已收口到共享底座 routing-base（原 'code', 'writing' 硬编码迁入，
// 来自 registry 注册而非 agent 自报；构造时实时读取）

class L1AgentAdapter {
    constructor(opts = {}) {
        this.id = opts.id || 'l1-agent';
        this.name = opts.name || 'L1 chat agent';
        this.transport = opts.transport || ['http'];
        this.capabilities = opts.capabilities || [...adapterDefaults('l1-agent').capabilities];
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
            model: task.model || adapterDefaults('l1-agent').defaultModel,
            messages: task.messages || [],
            ...(task.stream !== undefined ? { stream: task.stream } : {}),
            // ⚠️ 实测坑（2026-10-01，本地 Ollama qwen3.8:27b-mlx 真跑）：推理型模型会把 token 预算
            //   先喂给 thinking，`max_tokens` 给小了 → thinking 吃光预算、content 还没开始生成，
            //   此时 Ollama 的 **/v1 兼容层不返回、一直挂起到调用方超时**（实测 200 → 挂满 180s；
            //   同一请求给 512 → 1.76s 正常返回 content）。即"预算不足"不是快速失败而是静默挂起。
            //   故显式带上限：不传时逐字保持原样（交给下游默认），传了就有确定天花板。
            ...(task.maxTokens ? { max_tokens: task.maxTokens } : {}),
        };
        // ⚠️ 上游限流/5xx/网络错走 withHttpRetry 退避重试（见 l2/http-retry.js）；
        //   这里只处理「重试用尽 / 不可重试」的最终结果，保持下方诊断信息不变。
        const r = await withHttpRetry(
            () => httpPostJson(host, port, this.chatPath, body, this._authHeaders(), this.timeoutMs),
            { logger: retryLogger });
        // ⚠️ 错误信息必须带响应体摘要（2026-10-01 真开暴露的可诊断性缺口）：
        //   上层代理会对**上游故障**回自己的状态码再包一层 —— 实测 :18790 对失效 key /
        //   额度耗尽 / 限流一律回 `{"error":"Upstream error","code":"UPSTREAM_ERROR"}`，
        //   状态码在 401 与 429 之间跳。只报 "HTTP 401" 会被误读成「我的 token 配错了」，
        //   而真因是**上游 provider 那边的事**（去查 key / 额度 / 限流），方向完全不同。
        if (r.status !== 200) {
            const brief = String(r.body || '').replace(/\s+/g, ' ').slice(0, 200);
            const tag = r.status === 401 ? 'auth failed' : 'chat failed';
            // 429 已实际退避重试；仍失败说明限流持续，标签如实反映（不再误导「该重试却没重试」）
            throw new Error(`L1 agent ${tag}: HTTP ${r.status} (task ${taskId})` +
                `${brief ? ` :: ${brief}` : ''}` + (r.status === 429 ? ' [上游限流·已退避重试仍失败]' : ''));
        }
        let parsed;
        try {
            parsed = JSON.parse(r.body);
        } catch {
            parsed = { raw: r.body };
        }
        // OpenAI /v1/chat/completions 形态：{ id, choices:[{message:{content}}] }
        const msg = (parsed.choices && parsed.choices[0] && parsed.choices[0].message) || {};
        // ⚠️ 实测坑（2026-10-01，三次现形，每次厂商不同 —— 这是本段注释存在的全部理由）：
        //   推理型模型会把 token 预算先喂给思维链，`content` 返空串，却被当成成功返回。
        //   ① 本地 Ollama qwen3.8：思维链在 **message.reasoning**
        //   ② DeepSeek 官方 / Kimi 官方：思维链在 **message.reasoning_content**
        //   两者字段不一致；只认 reasoning 那一版时，接 DeepSeek 会拿到空 content 且 status=done
        //   —— 静默空结果，调用方看不出来。故两个字段都兜，并在 contentSource 里写明来源。
        //   非空时行为逐字不变。
        let content = typeof msg.content === 'string' && msg.content ? msg.content : null;
        let contentSource = content ? 'content' : null;
        if (!content) {
            const candidates = [
                ['reasoning', msg.reasoning],
                ['reasoning_content', msg.reasoning_content],
            ];
            for (const [src, txt] of candidates) {
                if (typeof txt === 'string' && txt) { content = txt; contentSource = src; break; }
            }
        }
        return {
            task_id: taskId,
            type: 'chat',
            state: 'done',
            agent: this.id,
            result: {
                content,
                contentSource,                 // 'content' | 'reasoning' | null（都空时）
                model: parsed.model || body.model,
                id: parsed.id || taskId,
                raw: parsed.raw ? undefined : parsed,
            },
            // 出站账本测量值（egress-ledger · 观测件）：如实带上，是否记账由 orchestrator 侧
            // 门控 PROXY_L2_EGRESS_LEDGER 决定（默认关=不注入=不消费本字段）。
            // upstreamHost = 本次实际下一跳（本地代理 host:port）；真实 provider 出网在本地代理进程内，本层看不到。
            egress: {
                bytesOut: Buffer.byteLength(JSON.stringify(body), 'utf8'),
                upstreamHost: `${host}:${port}`,
                usage: parsed.usage || null,
            },
            error: null,
        };
    }

    // 便捷别名：同步一发一回（chat 型无轮询）
    async run(task) {
        return this.invoke(task);
    }
}

module.exports = { L1AgentAdapter, probePort };
