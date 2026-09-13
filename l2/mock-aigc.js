'use strict';

// AIGC(hujing-ai) mock — 模拟 AIGC 生图生视频服务的最小 HTTP 后端。
// 对应真实下游：~/Documents/AIGC生图生视频/hujing-ai（FastAPI，REST + OAuth2）。
//
// 真实契约（据 hujing-ai backend 源码核实，非臆测）：
//    - 鉴权：所有 /api/v1/* 需 Authorization: Bearer <token>（OAuth2 password flow）
//    - 任务：POST   /api/v1/tasks           {subtype, params}            → TaskResponse{id,status:pending,...}
//            GET    /api/v1/tasks/:id                                → TaskResponse{id,status,...,result_images?}
//            POST   /api/v1/tasks/:id/cancel                         → {status:'cancelled'}
//    - 健康：GET    /api/v1/health                              → {status, overall}
//    - 状态机：pending → processing → 终态 completed | failed | cancelled
//      （据 workers/image_tasks.py：worker 置 completed/failed；cancel 置 cancelled）
//
// 用途：验证 aigc-adapter 契约（P0 协议可行性，非侵入）。
// 这是 adapter 的「下游 agent」侧替身：真实 AIGC 是 Python FastAPI，行为同款，
// adapter 只关心 HTTP + 鉴权契约，下游语言无关。
//
// 与 h3web mock 的关键差异：AIGC 多一层 Bearer 鉴权 + /api/v1 前缀 + 7 种 subtype 能力。
// 全程零副作用：不写任何文件、不起真 AIGC、不触生图/生视频云端。
// token 处理：mock 用固定 fake token 'test-token'，adapter 注入；demo 绝不打印 token。

const http = require('http');

// fixture token（仅 mock 用，非任何真实凭证）
const FAKE_TOKEN = 'test-token';

module.exports = function startMockAigc(port) {
    const tasks = {}; // taskId -> { attempts }

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');

        // 健康探针：AIGC 原生有 /api/v1/health（无需补桩），无需鉴权
        if (u.pathname === '/api/v1/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok', overall: 'healthy', service: 'mock-aigc' }));
        }

        // 鉴权：所有 /api/v1/tasks* 需 Bearer（模拟 AIGC OAuth2 中间件）
        if (u.pathname.startsWith('/api/v1/tasks')) {
            const authz = req.headers['authorization'] || '';
            if (authz !== `Bearer ${FAKE_TOKEN}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ detail: 'missing or invalid token' }));
            }
        }

        // 任务创建：POST /api/v1/tasks
        if (u.pathname === '/api/v1/tasks' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch { /* 容错 */ }
                const id = 'task_' + Math.random().toString(36).slice(2, 8);
                tasks[id] = { attempts: 0, subtype: parsed.subtype || 'unknown' };
                // 返回 TaskResponse 形态（id/subtype/status/progress）
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id,
                    subtype: parsed.subtype || 'unknown',
                    status: 'pending',
                    progress: 0,
                    params: parsed.params || null,
                    result_images: null,
                    created_at: new Date().toISOString() + 'Z',
                }));
            });
            return;
        }

        // 任务取消：POST /api/v1/tasks/:id/cancel
        const cancelMatch = /^\/api\/v1\/tasks\/([^/]+)\/cancel$/.exec(u.pathname);
        if (cancelMatch && req.method === 'POST') {
            const id = cancelMatch[1];
            const t = tasks[id];
            if (!t) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ detail: '任务不存在' }));
            }
            t.status = 'cancelled';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'task cancelled', task: { status: 'cancelled' } }));
        }

        // 任务结果：GET /api/v1/tasks/:id
        const getMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(u.pathname);
        if (getMatch && req.method === 'GET') {
            const id = getMatch[1];
            const t = tasks[id];
            if (!t) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ detail: '任务不存在' }));
            }
            t.attempts += 1;
            let status, result_images, image_url;
            if (t.status === 'cancelled') {
                status = 'cancelled';
            } else if (t.attempts < 2) {
                status = 'processing';           // 第 1 次查询：进行中
                result_images = null;
            } else {
                status = 'completed';            // 第 ≥2 次查询：终态
                result_images = [`/api/v1/files/${id}.jpg`];
                image_url = result_images[0];
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                id,
                status,
                progress: status === 'completed' ? 100 : 50,
                result_images,
                image_url,
                completed_at: status === 'completed' ? (new Date().toISOString() + 'Z') : null,
            }));
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'not found' }));
    });

    server.listen(port, '127.0.0.1');
    return {
        server,
        token: FAKE_TOKEN,
        getPort: () => server.address().port,
        close: () => new Promise((res) => server.close(res)),
    };
};
