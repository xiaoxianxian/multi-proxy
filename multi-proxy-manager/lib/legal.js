// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

// legal.js — 法务文本可达（D1）·纯状态/读取/渲染模块，可单测，绝不抛异常。
// 背景（2026-10-19 首启信任页评审 §6-P1#1 / §3-P2#6 / OD-5）：consent 页把完整《用户服务协议》
// 《隐私政策》指向仓库内 docs/legal/*.md 路径，终端用户「打不开」→ 法务承诺对终端用户不可达。
// 本模块把两份定稿法务文本做成面板内可达：GET /api/legal?type=terms|privacy 从 docs/legal 读原文 +
// 服务端安全渲染成 HTML（esc 先行，零客户端渲染），panel 直接注入；零网络、零外部依赖（本地文件）。
//
// 注入式：opts.dir（法务目录）/ opts.env 可注入 → 单测无需依赖真实仓库路径；生产缺文件时
// 返回 fallback（指向官方在线版 www.sifking.cn），绝不 500、绝不抛。
//
// 非侵入（AGENTS §3）：只读 docs/legal，不写任何 agent 目录/全局 env；纯本地文件读取。

const fs = require('fs');
const path = require('path');

// 法务文档登记：type → { 文件, 标题 }。新增法务文本在此加一行即可，面板/路由自动带上。
const DOCS = {
  terms:   { file: '用户服务协议.md', title: '用户服务协议' },
  privacy: { file: '隐私政策.md',     title: '隐私政策' },
};

// 官方在线版兜底（法务文本缺失 / 未打包进发布物时，指向官网，保持「可达」语义不断链）。
const ONLINE_HOME = 'https://www.sifking.cn';

// 法务目录默认位置：仓库根 docs/legal（本文件在 multi-proxy-manager/lib/，上两级是仓库根）。
// 可用 env MP_LEGAL_DIR 覆盖（测试 / 自定义部署）。
function defaultDir(env) {
  const override = (env || process.env).MP_LEGAL_DIR;
  if (override) return override;
  return path.join(__dirname, '..', '..', 'docs', 'legal');
}

// 从 front-matter / 正文头部粗提取版本号（v1.0 形态）；取不到回落 'v1.0（草案）'。永不抛。
function extractVersion(raw) {
  try {
    const head = raw.split(/\r?\n/).slice(0, 40).join('\n');
    const m = head.match(/\bv(\d+\.\d+)(?:\.\d+)?/i);
    if (m) return 'v' + m[1];
  } catch {
    /* fall through */
  }
  return 'v1.0（未标注）';
}

// HTML 转义：渲染前先转义全量文本，结构标签在后叠加 → 即使法务文本含 `<`/`&`/`"` 也不会 XSS。
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 轻量 markdown → HTML：仅够渲染法务长文（标题/粗体/斜体/行内代码/分隔线/列表/引用/表格/段落）。
// esc 先行 + 结构标签在后，保证零 XSS；表格（管道式）渲染成 <table>。纯函数、确定性。
// 关键：段落按「连续普通行」累积成段再 inline()，使跨物理换行的 **粗体** 能正常闭合（中文软换行）。
function mdToHtml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = false;
  let buf = []; // 段落缓冲
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const flushP = () => {
    if (buf.length) { out.push('<p class="legal-p">' + inline(buf.join('')) + '</p>'); buf = []; }
   };
   // 行内：粗体 **x** / 斜体 *x* / 行内代码 `x`（全部作用在已 esc 文本上，标签是结构非内容）。
  function inline(t) {
    t = t.replace(/\*\*([^*]+?)\*\*/g, (m, g) => '<strong>' + g + '</strong>');
    t = t.replace(/`([^`]+?)`/g, (m, g) => '<code>' + g + '</code>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*([^*]|$)/g, (m, p, g, s) => p + '<em>' + g + '</em>' + s);
    return t;
   }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
     // 表格行：| a | b | c |（允许前后空格）—— 收集整段成 <table>
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushP(); closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!/^[:\-\s| ]+$/.test(cells.join('') || '|')) rows.push(cells); // 跳过分隔行 |---|:--:|
        i++;
       }
      i--; // 回退，外层 for 再加 1
      if (rows.length) {
        const head = rows[0];
        const body = rows.slice(1);
        out.push(
             '<table class="legal-table">' +
            '<thead><tr>' + head.map((c) => '<th>' + inline(esc(c)) + '</th>').join('') + '</tr></thead>' +
            (body.length ? '<tbody>' + body.map((r) =>
              '<tr>' + r.map((c) => '<td>' + inline(esc(c)) + '</td>').join('') + '</tr>')
              .join('') + '</tbody>' : '') +
           '</table>'
         );
       }
      continue;
     }
     // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushP(); closeList(); out.push('<hr class="legal-hr">'); continue; }
     // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushP(); closeList();
      const lvl = Math.min(h[1].length, 4);
      out.push('<h' + lvl + ' class="legal-h">' + inline(esc(h[2])) + '</h' + lvl + '>');
      continue;
     }
     // 引用
       if (/^\s*>\s?/.test(line)) {
      flushP(); closeList();
      out.push('<blockquote class="legal-quote">' + inline(esc(line).replace(/^\s*>\s?/, '')) + '</blockquote>');
      continue;
     }
     // 列表（- / • 起头）
    const li = line.match(/^\s*[-•]\s+(.*)$/);
    if (li) {
      flushP();
      if (!inList) { out.push('<ul class="legal-list">'); inList = true; }
      out.push('<li>' + inline(esc(li[1])) + '</li>');
      continue;
     }
     // 空行 → 段落边界
    if (line.trim() === '') { flushP(); closeList(); continue; }
     // 普通行：累积进段落缓冲（CJK 软换行，flush 时直接 join，不加空格）
    buf.push(esc(line.trim()));
   }
  flushP(); closeList();
  return out.join('\n');
}

// 取一份法务文本：读 docs/legal/<file> + 安全渲染。type 未知 / 文件缺失均不抛，返回结构化结果。
function legalDoc(type, opts = {}) {
  const env = opts.env || process.env;
  const key = String(type == null ? '' : type).trim().toLowerCase();
  const meta = DOCS[key];
  const dir = opts.dir || defaultDir(env);
  const available = Object.keys(DOCS);
  if (!meta) {
    return { ok: false, type: key, fallback: true, reason: '未知条款类型', online: ONLINE_HOME, available };
  }
  const file = path.join(dir, meta.file);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
    } catch {
    // 文件缺失（未打包 / 自定义部署 / CI）→ 不断链，指向官方在线版，面板可降级显示。
    return {
      ok: false, type: key, title: meta.title, fallback: true,
      reason: '本地法务文本暂缺（' + meta.file + '），已指向官方在线版',
      online: ONLINE_HOME, available,
    };
  }
  const version = extractVersion(raw);
  return {
    ok: true,
   type: key,
    title: meta.title,
    version,
    markdown: raw,
    html: mdToHtml(raw),
    source: meta.file,
    available,
    online: ONLINE_HOME,
   };
}

// D2（2026-10-19 全角色评审）：法务内容指纹 = sha256 over 两份定稿正文（顺序 terms→privacy，缺文件该篇空串仍参与）。
// 与 legalDoc 同源同 dir（opts.dir / opts.env）→ 同意记录绑它：文档正文一变，指纹变，旧同意失效（lib/consent.js verifyConsent 据此判定）。
// 确定性：本机有 docs/legal 与「无 docs/legal」算出不同指纹；缺文档期间同意的旧记录，在补齐/改动文档后应重新同意。绝不抛异常。
function legalHashOf(opts = {}) {
  const crypto = require('crypto');
  const env = opts.env || process.env;
  const dir = opts.dir || defaultDir(env);
  const parts = Object.keys(DOCS).map((key) => {
    let body = '';
    try {
      body = fs.readFileSync(path.join(dir, DOCS[key].file), 'utf8');
    } catch {
      body = '';
    }
    return key + '::' + (body + DOCS[key].file).replace(/\r\n/g, '\n');
  });
  return crypto.createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

module.exports = { legalDoc, legalHashOf, mdToHtml, DOCS, ONLINE_HOME, defaultDir, extractVersion, esc };
