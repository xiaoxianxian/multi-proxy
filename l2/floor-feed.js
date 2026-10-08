// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// floor-feed —— 「代理面 Floor View」的事件落盘 / 读取（append-only JSONL）
//
// 为什么单独一层：事件有**三个写入方**、**一个读取方**，口径必须只留一份：
//   写入方 ① l2/token-policy.js —— 每次 hook 命中追加一条 {kind:'hook'}（跨进程：桥进程写）
//   写入方 ② tools/floor-ingest.js —— 宿主（Munder 等）的 HIVE_SOCK 事件转写 {kind:'agent'}
//   写入方 ③ 测试 / 手工
//   读取方   manager 的 routes/floor.js（`GET /api/floor`）
// 写两份口径必然漂，所以只留这一份真源（同 public/floor-view.js 的纪律）。
//
// 纯 Node（fs/path/os），不依赖 express、不依赖 l2 其它模块。
//
// 记录形状（每行一个 JSON）：
//   { ts, kind:'agent', agentId, event:'Status'|'CostSample'|'Stop', model?, tokens?, input?, output?, cacheRead? }
//   { ts, kind:'hook',  hook, policy, agentType?, firedCount? }
//
// 🔴 无数据就是 null：readLastHook() 无记录 → null，页面画「—」。**绝不编造、绝不折算 0。**
// ⚠️ 落盘是 best-effort（append 绝不抛）：写入方在热路径上（token-policy.apply），
//    写盘失败只吞异常，不影响请求。

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_FEED = path.join(os.homedir(), '.multi-proxy', 'floor-feed.jsonl');
let feedFile = process.env.PROXY_FLOOR_FEED_FILE || DEFAULT_FEED;

function setFeedFile(f) { feedFile = f; }
function getFeedFile() { return feedFile; }

// best-effort 追加一行。永不抛（写入方可能在热路径）。
function append(rec) {
    try {
        fs.mkdirSync(path.dirname(feedFile), { recursive: true });
        fs.appendFileSync(feedFile, JSON.stringify(rec) + '\n');
        return true;
    } catch {
        return false;
    }
}

// 读最近 limit 行（默认全读）。坏行跳过，不抛。
function readAll(limit) {
    let txt;
    try { txt = fs.readFileSync(feedFile, 'utf8'); } catch { return []; }
    const lines = txt.split('\n').filter(Boolean);
    const slice = (limit && limit > 0) ? lines.slice(-limit) : lines;
    const out = [];
    for (const l of slice) {
        try { out.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
    }
    return out;
}

// 最近一次 hook 命中（倒序找第一条 kind==='hook'）。无 → null。
function readLastHook() {
    const all = readAll(2000);
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i] && all[i].kind === 'hook') return all[i];
    }
    return null;
}

// 按 agentId 聚合宿主事件 → 每个 agent 一条最新视图。无 → []。
// 字段缺失保留 null（不填 0）。
function readAgents() {
    const all = readAll(2000);
    const byId = new Map();
    for (const r of all) {
        if (!r || r.kind !== 'agent' || !r.agentId) continue;
        let cur = byId.get(r.agentId);
        if (!cur) {
            cur = { agentId: r.agentId, model: null, tokens: null, input: null, output: null, cacheRead: null, lastEvent: null, at: null };
            byId.set(r.agentId, cur);
        }
        if (r.event === 'Status' && Number.isFinite(r.tokens)) { cur.tokens = r.tokens; }
        if (r.event === 'CostSample') {
            if (r.model) cur.model = r.model;
            if (Number.isFinite(r.input)) cur.input = r.input;
            if (Number.isFinite(r.output)) cur.output = r.output;
            if (Number.isFinite(r.cacheRead)) cur.cacheRead = r.cacheRead;
        }
        if (r.event) cur.lastEvent = r.event;
        if (Number.isFinite(r.ts)) cur.at = r.ts;
    }
    return Array.from(byId.values()).sort((a, b) => (b.at || 0) - (a.at || 0));
}

module.exports = {
    append,
    readAll,
    readLastHook,
    readAgents,
    setFeedFile,
    getFeedFile,
    DEFAULT_FEED,
};
