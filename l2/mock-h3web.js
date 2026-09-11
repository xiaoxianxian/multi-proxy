'use strict';

// h3web mock — 模拟 h3web 的最小 HTTP 后端（/api/gen + /api/status job 状态机）。
// 用途：验证 adapter 契约（P0 协议可行性）。
// 这是 adapter 的「下游 agent」侧替身：真实 h3web 是 3438 行 Python 标库，行为同款，
// adapter 只关心 HTTP 契约，下游语言无关。mock 用 node 写仅为**零依赖可控**，
// 不代表 adapter 只能连 node——adapter 可指向任何实现 /api/gen + /api/status 的后端。
//
// job 状态机（模拟 h3web 真实 async 语义）：
//    POST /api/gen {prompt}     → { job_id, state:'pending' }
//    GET  /api/status/:id       第 1 次 → { state:'running' }
//                         第 ≥2 次 → { state:'done', result:{ video_url } }
// 全程零副作用：不写任何文件、不起 h3web、不触 Minimax 云端。

const http = require('http');

module.exports = function startMockH3web(port) {
    const jobs = {};

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');
        const idMatch = /^\/api\/status\/([^/]+)$/.exec(u.pathname);

        if (u.pathname === '/api/gen' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const job_id = 'job_' + Math.random().toString(36).slice(2, 8);
                jobs[job_id] = { attempts: 0, prompt: 'unknown' };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ job_id, state: 'pending' }));
            });
            return;
        }

        if (idMatch && req.method === 'GET') {
            const id = idMatch[1];
            const j = jobs[id];
            if (!j) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'unknown job' }));
            }
            j.attempts += 1;
            const out = j.attempts < 2
                ? { state: 'running' }
                : { state: 'done', result: { video_url: '/outputs/' + id + '.mp4' } };
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
        close: () => new Promise((res) => server.close(res)),
    };
};
