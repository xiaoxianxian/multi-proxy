// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// Claude 全家桶 adapter（v2-M5 R3-b）—— 把 Claude 接入 L2 编排中枢，对标 l1-agent-adapter.js。
// 覆盖三种形态：
//    - Anthropic Messages API（原生，非 OpenAI 兼容）：POST /v1/messages
//    - claude-code CLI（本地 coding agent）：若暴露 chat 端点走 invoke；否则退化为能力发现
//    - claude-desktop（GUI agent，非 HTTP 服务）：仅 health/发现
//
// 与 l1-agent（OpenAI 兼容：x-proxy-auth / /v1/chat/completions / choices[].message.content）
// 的四处差异（据 Anthropic 真实契约核实，非臆测）：
//    ① 鉴权头：x-api-key（非 Bearer、非 x-proxy-auth）+ 固定头 anthropic-version: 2023-06-01
//    ② 端点：POST /v1/messages（非 /v1/chat/completions）
//    ③ 请求体：system 是顶层参数（非 messages 内首条）；body 需 max_tokens
//    ④ 响应/流式：content[].text（非 choices[].message.content）；
//       流式走 Anthropic SSE（message_start / content_block_delta{delta:{text}} /
//       content_block_stop / message_stop），非 OpenAI choices[].delta
//
// 铁律（adapter-protocol.md §五，全程遵守）：
//    ① 对 Claude 只读：adapter 只「拦住 → 注入 x-api-key+anthropic-version → 转发」，
//      不写 Claude/claude-code/claude-desktop 任何文件、不改其配置。
//     ② 端口动态探测：绝不写死。候选端口谁在 LISTEN 用谁，否则用注入端口（mock/测试）。
//    ③ 零依赖：仅 node 内置 http + net + crypto（任务编号）。
//    ④ 密钥：apiKey（ANTHROPIC_API_KEY / 网关侧映射）由调用方注入；adapter 不打印、不落盘。
//      无 apiKey 时仅 health/models 可不带；/v1/messages 无 key → 下游 401 → invoke 抛错。
//    ⑤ 门控：新增能力默认 dormant，经 l2/mcp-default-seed.js 注册时 gate closed（shadow），
//      不改变现有路由行为，观察后再决定上线。

const http = require('http');
const crypto = require('crypto');
// 共享底座（质量工程 §三）：默认能力/默认模型唯一事实源（原本文件硬编码已迁入）。
const { adapterDefaults } = require('../knowledge-base/routing-base.js');

// ---- 动态端口探测（绝不写死，同 h3web/aigc/l1-agent 范式）----
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

// ---- 统一 http GET 辅助（GET 与 POST 共用 http.request，形态一致）----
function httpGetJson(host, port, pathStr, headers = {}, timeoutMs = 8000) {
    return new Promise((res, rej) => {
        const req = http.request(
            { host, port, path: pathStr, method: 'GET', timeout: timeoutMs, headers },
            (r) => {
                let buf = '';
                r.on('data', (c) => { buf += c; });
                r.on('end', () => res({ status: r.statusCode, body: buf }));
             });
        req.on('error', rej);
        req.setTimeout(timeoutMs, () => { req.destroy(); rej(new Error('timeout')); });
        req.end();
     });
}

// 同步 chat：POST /v1/messages → 200 返 { id, type:'message', content:[{type:'text',text}], ... }
// 流式 chat：同端点 stream:true → SSE 流逐事件回传
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

// 默认能力：已收口到共享底座 routing-base（原 'code', 'writing' 硬编码迁入，构造时实时读取）

// Anthropic 固定版本头
const ANTHROPIC_VERSION = '2023-06-01';

// 解析 Anthropic content[] 文本块 → 纯文本（非流式与流式共用）
function extractText(content) {
    if (Array.isArray(content)) {
        return content
            .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
            .map((b) => b.text || '')
            .join('');
    }
    if (typeof content === 'string') return content;
    return '';
}

class ClaudeAdapter {
    constructor(opts = {}) {
        this.id = opts.id || 'claude';
        this.name = opts.name || 'Claude (Anthropic Messages API / claude-code / claude-desktop)';
        this.transport = opts.transport || ['http'];
        this.capabilities = opts.capabilities || [...adapterDefaults('claude').capabilities];
        // 非任务队列：chat 型同步 invoke（无 task_id 持久化/轮询，同 l1-agent chat 型）
        this.supportsTaskQueue = opts.supportsTaskQueue !== undefined ? opts.supportsTaskQueue : false;
        this.portCandidates = opts.portCandidates || []; // 调用方注入（claude-code 本地 chat shim 端口待实测）
        this.injectedPort = opts.port;
        this.host = opts.host || '127.0.0.1';
        this.healthPath = opts.healthPath || '/health';
        this.modelsPath = opts.modelsPath || '/v1/models';
         // 端点：显式传 chatPath: null = 无 chat 端点（claude-code 无 HTTP shim / claude-desktop）→ 退化发现；
         //    未传（undefined）则默认 /v1/messages（Anthropic 原生 chat 入口）
        this.chatPath = opts.chatPath !== undefined ? opts.chatPath : '/v1/messages';
        this.anthropicVersion = opts.anthropicVersion || ANTHROPIC_VERSION;
        this.timeoutMs = opts.timeoutMs || 120000;
        // apiKey 由调用方注入（ANTHROPIC_API_KEY / 网关侧假 key）；适配器不打印、不落盘
        this._apiKey = opts.apiKey || null;
        this._resolvedPort = null;
    }

    // 内部：x-api-key + 固定 anthropic-version 头（无 key 则仅带 version → /v1/messages 401）
    _authHeaders(extra = {}) {
        const h = { ...extra, 'anthropic-version': this.anthropicVersion };
        if (this._apiKey) h['x-api-key'] = this._apiKey;
        return h;
    }

    // 动态锁定端口（首次 resolve 后缓存）
    async _resolveTarget() {
        if (this._resolvedPort) return { host: this.host, port: this._resolvedPort };
        const port = await probePort(this.portCandidates, this.injectedPort);
        this._resolvedPort = port;
        return { host: this.host, port };
    }

    // ---- 接口 1：能力声明（向 Agent Registry 注册能力的源）----
    capabilitiesDeclaration() {
        return {
            adapter: this.id,
            version: '1.0.0',
            transport: this.transport,
            capabilities: this.capabilities,
            supportsTaskQueue: this.supportsTaskQueue,
            protocol: 'anthropic', // 区别于 l1-agent 的 openai 兼容
            isChatAgent: true,
            supportsChat: !!this.chatPath, // 有 /v1/messages=可 chat；claude-code/desktop 可退化为发现
            healthEndpoint: this.healthPath,
            modelsEndpoint: this.modelsPath,
            authScheme: 'x-api-key',
        };
    }

    // ---- 接口 2：健康检查（GET /health，200 即进程活；无 key 也可探活）----
    async health() {
        const { host, port } = await this._resolveTarget();
        const r = await httpGetJson(host, port, this.healthPath, {}, 8000);
        let ok = false;
        let status = 'down';
        if (r.status === 200) {
            ok = true;
            status = 'ok';
        }
        return { ok, status, port, capabilities: this.capabilities, raw: r.status };
    }

    // ---- /v1/models 发现（能力/在线模型发现的源；OpenAI 兼容形态 {data:[{id}]}）----
    async listModels() {
        const { host, port } = await this._resolveTarget();
        const r = await httpGetJson(host, port, this.modelsPath, this._authHeaders(), 8000);
        if (r.status === 401) throw new Error('Claude auth failed: 401 (x-api-key 缺失/过期)');
        if (r.status === 404) return []; // 非 Messages 形态（claude-code/desktop）无 /v1/models → 空发现
        if (r.status !== 200) throw new Error(`Claude /v1/models failed: HTTP ${r.status}`);
        // 非 JSON 容错：claude-desktop 类发现型下游可能 200 但非模型列表
        try {
            const j = JSON.parse(r.body);
            return j.data || []; // OpenAI /v1/models 形态：{ object:'list', data:[{id,...}] }
        } catch {
            return [];
        }
    }

    // ---- 接口 3-4：任务接收/结果回传（chat 型同步 invoke；无 chat 端点退化为发现）----
    // task: { model, messages, system?, max_tokens?, stream? }
    // 有 chat 端点 → POST /v1/messages 同步/流式返回 { id, content, model, ... }
    // 无 chat 端点（claude-code 无 HTTP shim / claude-desktop）→ 退化发现，返 available_models
    async invoke(task) {
        if (!task) throw new Error('invoke(task) required');
        const { host, port } = await this._resolveTarget();
        const taskId = 'claude_' + crypto.randomBytes(6).toString('hex'); // adapter 本地发号（agent 不持久化）

        if (!this.chatPath) {
            // 无 chat 端点：退化为能力发现，如实返回（不臆造 chat 语义）
            const models = await this.listModels().catch(() => []);
            return {
                task_id: taskId,
                type: 'discovery',
                state: 'done',
                agent: this.id,
                note: `${this.id} 无 chat 端点（Claude CLI/desktop 为能力发现型）；退化为模型发现`,
                result: { available_models: models.map((m) => m.id) },
                error: null,
            };
        }

        // 有 chat 端点：POST /v1/messages，注入 x-api-key + anthropic-version
        const body = {
            model: task.model || adapterDefaults('claude').defaultModel,
            messages: task.messages || [],
            stream: task.stream === true,
        };
        if (task.max_tokens) body.max_tokens = task.max_tokens;
        if (task.system) body.system = task.system; // Anthropic：system 是顶层参数，非 messages 内

        const r = await httpPostJson(host, port, this.chatPath, body, this._authHeaders(), this.timeoutMs);
        if (r.status === 401) throw new Error(`Claude auth failed: 401 (task ${taskId})`);
        if (r.status !== 200) throw new Error(`Claude chat failed: HTTP ${r.status} (task ${taskId})`);

         // 流式：Anthropic SSE 逐事件累积（content_block_delta 的 delta.text）
        if (body.stream) {
            const text = this._parseSSE(r.body || '');
            return {
                task_id: taskId,
                type: 'chat',
                state: 'done',
                agent: this.id,
                stream: true,
                result: {
                    content: text,
                    model: body.model, // SSE 无顶层 model 字段，回退请求 model
                    stop_reason: this._sseLastStop,
                    events_seen: this._sseEventCount,
                 },
                error: null,
             };
         }

        let parsed;
        try {
            parsed = JSON.parse(r.body);
         } catch {
            parsed = { raw: r.body };
         }
         // Anthropic 形态：{ id, type:'message', role:'assistant', content:[{type:'text',text}], stop_reason, usage }
        const content = extractText(parsed.content);
        return {
            task_id: taskId,
            type: 'chat',
            state: 'done',
            agent: this.id,
            result: {
                content,
                model: parsed.model || body.model,
                id: parsed.id || taskId,
                stop_reason: parsed.stop_reason || null,
                usage: parsed.usage || null,
                raw: parsed,
             },
            // 出站账本测量值（egress-ledger · 观测件）：同 l1-agent-adapter，门控关=不消费。
            egress: {
                bytesOut: Buffer.byteLength(JSON.stringify(body), 'utf8'),
                upstreamHost: `${host}:${port}`,
                usage: parsed.usage || null,
            },
            error: null,
         };
     }

     // 解析 Anthropic SSE → 累积 content_block_delta 的 text；统计 data: 事件数
    _parseSSE(rawBody) {
       this._sseEventCount = 0;
       this._sseLastStop = null;
       let text = '';
       const lines = rawBody.split('\n');
       for (const line of lines) {
           if (line.startsWith('event:')) continue; // 事件类型行：仅结构参考
           if (!line.startsWith('data:')) continue;
           const payload = line.slice(5).trim();
           if (!payload || payload === '[DONE]') continue;
           let evt;
           try {
               evt = JSON.parse(payload);
           } catch {
               continue; // 跳过非 JSON 行
            }
           this._sseEventCount += 1; // 每个 data 事件记一次
           const t = evt.type;
           if (t === 'content_block_delta') {
               const d = evt.delta && evt.delta.text;
               if (typeof d === 'string') text += d;
            } else if (t === 'message_delta') {
               if (evt.delta && typeof evt.delta.stop_reason === 'string') {
                   this._sseLastStop = evt.delta.stop_reason;
                }
            }
        }
       return text;
    }

    // 便捷别名：同步一发一回（chat 型无轮询）
    async run(task) {
       return this.invoke(task);
    }
    }

    module.exports = { ClaudeAdapter, probePort, extractText, ANTHROPIC_VERSION };
