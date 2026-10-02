#!/usr/bin/env node
'use strict';

// floor-ingest —— 把「宿主 agent 的事件流」接进代理面 floor view
//
// 背景：Munder Difflin 这类宿主会 spawn 真 CLI，并把每个响应的 usage 经它自己的
//       loopback sidecar **TEE 成 HIVE_SOCK 事件**（Stop / Status / CostSample，见
//       60 号文档的真事件样本）。本脚本就是那个 socket 的对端：收事件 → 归一化 →
//       追加进 l2/floor-feed（`~/.multi-proxy/floor-feed.jsonl`）→ manager 的
//       `GET /api/floor` 读出来，落成「宿主 Agent」那一排格子。
//
// 用法：
//   node tools/floor-ingest.js                       # 监听默认 unix socket
//   node tools/floor-ingest.js --sock /tmp/x.sock    # 指定 socket（给宿主的 HIVE_SOCK 用）
//   cat events.jsonl | node tools/floor-ingest.js --stdin   # 从 stdin 吃（便于验证/回放）
//
// 输入行（每行一个 JSON），认两类：
//   ① 宿主原始事件：{hook_event_name:'Status'|'CostSample'|'Stop', agent_id, context_window?, model?, input?, output?, cache_read?}
//   ② 已归一化记录：{kind:'agent'|'hook', ...}（直接透传，便于桥/别处也往这里送）
//
// 设计：best-effort、永不因单行坏数据退出；写盘走 l2/floor-feed（唯一写入口径）。

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const feed = require('../l2/floor-feed');

// 归一化：宿主原始事件 → floor-feed 记录。返回 null 表示这行不认识（丢弃）。
function normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const now = Date.now();

    // ② 已归一化：kind 明确 → 透传（补 ts）
    if (obj.kind === 'agent' || obj.kind === 'hook') {
        return Object.assign({ ts: Number.isFinite(obj.ts) ? obj.ts : now }, obj);
    }

    // ① 宿主原始事件
    const ev = obj.hook_event_name;
    const agentId = obj.agent_id || obj.agentId;
    if (!ev || !agentId) return null;

    if (ev === 'Status') {
        const cw = obj.context_window || {};
        return {
            kind: 'agent', ts: now, agentId, event: 'Status',
            tokens: Number.isFinite(cw.total_input_tokens) ? cw.total_input_tokens : null,
        };
    }
    if (ev === 'CostSample') {
        return {
            kind: 'agent', ts: now, agentId, event: 'CostSample',
            model: obj.model || null,
            input: Number.isFinite(obj.input) ? obj.input : null,
            output: Number.isFinite(obj.output) ? obj.output : null,
            cacheRead: Number.isFinite(obj.cache_read) ? obj.cache_read : (Number.isFinite(obj.cacheRead) ? obj.cacheRead : null),
        };
    }
    if (ev === 'Stop') {
        return { kind: 'agent', ts: now, agentId, event: 'Stop' };
    }
    // 其它 hook 事件（PreToolUse/PostToolUse/…）暂不落盘（floor view 只用三类）
    return null;
}

let written = 0, dropped = 0;
// 处理一个 chunk（可能是多行、可能半行）→ 由调用方保证按行切分
function handleLine(line) {
    const s = String(line).trim();
    if (!s) return;
    let obj;
    try { obj = JSON.parse(s); } catch { dropped += 1; return; }
    const rec = normalize(obj);
    if (!rec) { dropped += 1; return; }
    if (feed.append(rec)) written += 1;
}

// ---- stdin 模式（回放/验证用）----
function runStdin() {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(handleLine);
    });
    process.stdin.on('end', () => {
        if (buf) handleLine(buf);
        console.log(`[floor-ingest] stdin done. written=${written} dropped=${dropped} → ${feed.getFeedFile()}`);
        process.exit(0);
    });
}

// ---- unix socket 模式（默认）----
function runSocket(sockPath) {
    try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch { /* ignore */ }
    const server = net.createServer((conn) => {
        let buf = '';
        conn.setEncoding('utf8');
        conn.on('data', (d) => {
            buf += d;
            const lines = buf.split('\n');
            buf = lines.pop();
            lines.forEach(handleLine);
        });
        conn.on('end', () => { if (buf) handleLine(buf); });
        conn.on('error', () => { /* 客户端断开不致命 */ });
    });
    server.on('error', (e) => {
        console.error('[floor-ingest] socket error: ' + e.message);
        process.exit(1);
    });
    server.listen(sockPath, () => {
        console.log(`[floor-ingest] listening on ${sockPath}`);
        console.log(`[floor-ingest] feed → ${feed.getFeedFile()}`);
        console.log('[floor-ingest] 把宿主的 HIVE_SOCK 指到这里即可；Ctrl-C 退出。');
    });
    const bye = () => { try { server.close(); if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch { /* ignore */ } process.exit(0); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--stdin') || !process.stdin.isTTY && process.env.FLOOR_INGEST_STDIN === '1') return runStdin();
    let sockPath = process.env.FLOOR_INGEST_SOCK
        || path.join(os.tmpdir(), 'multi-proxy-floor.sock');
    const i = argv.indexOf('--sock');
    if (i >= 0 && argv[i + 1]) sockPath = argv[i + 1];
    runSocket(sockPath);
}

if (require.main === module) main();

module.exports = { normalize };
