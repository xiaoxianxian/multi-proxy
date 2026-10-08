// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// h3web mock — 模拟 h3web 的最小 HTTP 后端（/api/gen + /api/status job 状态机）。
// 用途：验证 adapter 契约（P0 协议可行性）。
// 这是 adapter 的「下游 agent」侧替身：真实 h3web 是 3438 行 Python 标库，行为同款，
// adapter 只关心 HTTP 契约，下游语言无关。mock 用 node 写仅为**零依赖可控**，
// 不代表 adapter 只能连 node——adapter 可指向任何实现 /api/gen + /api/status 的后端。
//
// job 状态机（模拟 h3web 真实 async 语义）：
//    POST /api/gen {prompt}     → { job_id, status:'pending' }
//    GET  /api/status/:id       第 1 次 → { status:'running' }
//                         第 ≥2 次 → { status:'done', output:{ video_url } }
// 全程零副作用：不写任何文件、不起 h3web、不触 Minimax 云端。

const http = require('http');

module.exports = function startMockH3web(port) {
    const jobs = {};
    let genCalls = 0;    // canary 计数用：下游到底被真打了几枪（新增，向后兼容）
    let statusCalls = 0;
    // 记录最后一次 POST /api/gen 的 body：供单测断言「档位字段真的透传到了下游」。
    // 没有这个，adapter 传错字段名（如 `size` 而非 `width`）也照样 200 done，是假绿灯。
    let lastGenPayload = null;
    let lastGenHeaders = null;
    // 故事板侧替身：同样记录最后一次 POST /api/storyboard 的 body，
    // 供单测断言「逐镜档位真的透传到了下游」（否则 adapter 传错键名也照样 200，是假绿灯）。
    let lastStoryboardPayload = null;

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');
        const idMatch = /^\/api\/status\/([^/]+)$/.exec(u.pathname);

        if (u.pathname === '/api/gen' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                genCalls += 1;
                try { lastGenPayload = JSON.parse(body || '{}'); } catch { lastGenPayload = null; }
                lastGenHeaders = req.headers;
                const job_id = 'job_' + Math.random().toString(36).slice(2, 8);
                jobs[job_id] = { attempts: 0, prompt: 'unknown' };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ job_id, status: 'pending' }));
            });
            return;
        }

        // 多镜头故事板：语义对齐 h3web._handle_storyboard —— shots 非空才受理，
        // 逐镜缺 prompt 视为参数错误（h3web 走 build_args 预校验拒 400，这里等价拒）。
        if (u.pathname === '/api/storyboard' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let p = null;
                try { p = JSON.parse(body || '{}'); } catch { p = null; }
                if (!p || !Array.isArray(p.shots) || p.shots.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'shots 不能为空' }));
                }
                const bad = p.shots.findIndex((s) => !(s && s.prompt));
                if (bad >= 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: `第 ${bad + 1} 镜参数错误: prompt 缺失` }));
                }
                genCalls += 1;   // 故事板也算一次 gen 口径的下游调用
                lastStoryboardPayload = p;
                const job_id = 'job_' + Math.random().toString(36).slice(2, 8);
                jobs[job_id] = { attempts: 0, prompt: 'storyboard' };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ job_id, status: 'pending' }));
            });
            return;
        }

        if (idMatch && req.method === 'GET') {
            statusCalls += 1;
            const id = idMatch[1];
            const j = jobs[id];
            if (!j) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'unknown job' }));
            }
            j.attempts += 1;
            const out = j.attempts < 2
                ? { status: 'running' }
                : { status: 'done', output: '/outputs/' + id + '.mp4' };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(out));
        }

        // 健康探针（h3web 真实是根路径 / 返 SPA，这里给 JSON info，adapter healthPath 可配）
        if (u.pathname === '/' || u.pathname === '/api/info') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ service: 'mock-h3web', status: 'ok' }));
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    server.listen(port, '127.0.0.1');
    return {
        server,
        getPort: () => server.address().port,
        getGenCalls: () => genCalls,
        getStatusCalls: () => statusCalls,
        getHttpCalls: () => genCalls + statusCalls,
        getLastGenPayload: () => lastGenPayload,
        getLastGenHeaders: () => lastGenHeaders,
        getLastStoryboardPayload: () => lastStoryboardPayload,
        // 清掉记录，供「这次根本没打枪」类断言（不清的话保留的是上一次的 payload，
        // 断言 toBeNull 会假红）。
        resetLastStoryboard: () => { lastStoryboardPayload = null; },
        close: () => new Promise((res) => server.close(res)),
    };
};
