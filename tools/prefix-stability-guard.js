#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.
//
// 🔴 状态（2026-10-22 标注）：**观测件，写完零接线**。全仓无任何 require（除本文件 :21 的用法示例
//    和 :88 的自测入口），也就是说现在它**不产生任何运行时效果**，只在本文件被直接执行时自测。
//    这是诚实的中间态标注，不是接线——改这一处不会让任何请求路径多走一行代码。
//
// 要真正启用，缺两步（都没做）：
//   1) 谁 require 它：需要由**发往上游之前**的那个人调用，即请求组装完成、字节已定的那一点
//      （候选：l2/forward.js / codex-proxy/proxy.js）。那两处是热路径红线区，改之前要老板授权，
//      所以至今没人接线。调用形如 :21：G.observe(sessionId, { messages, tools })。
//      key 必须是「会话级稳定」的（同一会话同一 key），否则每次都是 firstSeen，永远测不出变化。
//   2) 门控怎么开：环境变量 PROXY_PREFIX_GUARD=on（见本文件 :27）。默认关，关时 observe() 直接
//      返回 null（:70），调用方逐字节不变，可以放心先埋点后开门。存储是进程级内存 Map（:28），
//      不落盘，进程重启即空——跨重启的对比做不了。
//   自测（无需接线）：PROXY_PREFIX_GUARD=on node tools/prefix-stability-guard.js
'use strict';

// 前缀稳定性守卫（2026-10-21）
//
// 为什么需要：上游提示缓存是「前缀单元全匹配」（DeepSeek 官方 kv_cache 文档原文：
// "A subsequent request can only hit the cache if it fully matches a cache prefix
// unit"）。前缀里改一个字，整段掉回未命中价。而代理正好站在改请求的位置上——
// 工具裁剪、协议转换、注入 system 提示，每一处都可能悄悄改掉前缀。
// 本模块不优化缓存，只回答一个可判定的问题：**这一轮和上一轮比，前缀变没变，变在哪。**
//
// 设计边界（守 N3 纯观测铁律）：
//   - 零决策权、零改写：只算指纹、只出报告，不改请求；
//   - 存储纯内存（Map），进程级，不落盘——与 l2/route-sticky.js 同纪律；
//   - 门控 PROXY_PREFIX_GUARD 默认关，关时 observe() 直接返回 null，调用方逐字节不变。
//
// 用法：
//   const G = require('./prefix-stability-guard.js');
//   const r = G.observe(sessionId, { messages, tools });
//   if (r && r.changed) console.warn('前缀变了：', r.reason, r.diff);

const crypto = require('crypto');

const ON = process.env.PROXY_PREFIX_GUARD === 'on';
const store = new Map(); // key -> { hash, system, tools }

const sha = (s) => crypto.createHash('sha1').update(s || '').digest('hex').slice(0, 12);

// 取 system 文本：兼容 string 与 Anthropic 的 block 数组
function systemText(messages, system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n');
  }
  const m = Array.isArray(messages) ? messages.find((x) => x && x.role === 'system') : null;
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : String(m.content || '');
}

// 工具表的规范化序列化：含顺序、含字段名，顺序变了就一定变
function toolsSig(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  return JSON.stringify(tools.map((t) => {
    const f = t.function || t;
    return { n: f.name, d: f.description || '', p: f.parameters || f.input_schema || null };
  }));
}

// 首个差异位置 + 前后各 20 字上下文：够定位「谁往前缀里塞了动态内容」
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return { at: i, prev: a.slice(Math.max(0, i - 20), i + 20), now: b.slice(Math.max(0, i - 20), i + 20) };
    }
  }
  return { at: n, prev: a.slice(Math.max(0, n - 20)), now: b.slice(Math.max(0, n - 20)) };
}

function fingerprint(req) {
  const sys = systemText(req && req.messages, req && req.system);
  const sig = toolsSig(req && req.tools);
  return { hash: sha(sys + '\u0000' + sig), system: sys, tools: sig };
}

function observe(key, req) {
  if (!ON) return null;
  const fp = fingerprint(req);
  const prev = store.get(key);
  store.set(key, fp);
  if (!prev) return { changed: false, firstSeen: true, hash: fp.hash };
  if (prev.hash === fp.hash) return { changed: false, firstSeen: false, hash: fp.hash };
  const dSys = prev.system === fp.system ? null : firstDiff(prev.system, fp.system);
  const dTools = prev.tools === fp.tools ? null : true;
  const reason = dSys && dTools ? 'system 与 tools 都变了' : dSys ? 'system 变了' : 'tools 变了';
  return { changed: true, firstSeen: false, hash: fp.hash, prevHash: prev.hash, reason, diff: dSys, toolsChanged: !!dTools };
}

function reset() { store.clear(); }
function size() { return store.size; }

module.exports = { observe, fingerprint, reset, size, systemText, toolsSig, isOn: () => ON };

// 自测：node tools/prefix-stability-guard.js（需 PROXY_PREFIX_GUARD=on）
if (require.main === module) {
  if (!ON) {
    console.log('门控默认关。加 PROXY_PREFIX_GUARD=on 跑自测。');
    process.exit(0);
  }
  const base = {
    messages: [{ role: 'system', content: '你是编码助手，回答简洁。' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'exec_command', description: 'run', parameters: { a: 1 } } },
            { type: 'function', function: { name: 'read_file', description: 'read', parameters: { b: 2 } } }],
  };
  const stamp = JSON.parse(JSON.stringify(base));
  stamp.messages[0].content += ' 当前时间 2026-10-21 01:40:00';
  const reorder = JSON.parse(JSON.stringify(base));
  reorder.tools.reverse();

  const r1 = observe('s1', base);
  const r2 = observe('s1', base);
  const r3 = observe('s1', stamp);
  const r4 = observe('s2', reorder);
  const r5 = observe('s2', reorder);

  const checks = [
    ['首次观测标 firstSeen', r1.firstSeen === true],
    ['同前缀重复 ⇒ 未变', r2.changed === false],
    ['system 插时间戳 ⇒ 检出变化', r3.changed === true && /system/.test(r3.reason)],
    ['能给出首个差异位置', r3.diff && typeof r3.diff.at === 'number'],
    ['tools 换顺序 ⇒ 首次不算变（新 key）', r4.firstSeen === true],
    ['tools 换顺序 ⇒ 第二次基准内稳定', r5.changed === false],
  ];
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✔' : '✘'} ${name}`); if (!ok) bad++; }
  console.log(bad ? `\n${bad} 项未过` : '\n自测全过（6/6）');
  if (r3.diff) console.log('差异样例：', JSON.stringify(r3.diff, null, 0).slice(0, 220));
  process.exit(bad ? 1 : 0);
}
