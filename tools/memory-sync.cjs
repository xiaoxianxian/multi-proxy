#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * memory-sync.cjs — agent 记忆对齐协议的「可执行同步」(v0.2)
 *
 * 对应 memory-alignment-protocol.md。零 npm，Node>=18，.cjs。
 *
 * v0.2 变更（2026-10-10，维护者拍板「同步 gap 不许再漏东西」）：
 *   1. 新增 `gap` 命令 —— 机械对比「项目共享层现在有什么」vs「水位记的我读到哪」，
 *      输出未读/更新的文件 + 新增章节标题。**文件级 + 章节级**粒度，
 *      不再只捞「触发条件/血泪」条目（v0.1 只捞条目，日志/决策/状态全被过滤掉 → 必然漏）。
 *   2. targets 支持 glob（`…/PROJECT-STATE/*.md`），目录里新增文件自动纳入。
 *   3. 新增 scan_dirs：即使忘了写进 targets，也会扫目录发现「从未读过的新文件」。
 *   4. 水位升级 `_stateSeen`（mtime + bytes + lines + headings），兼容旧 `_mtimeSeen`。
 *
 * 共享层 = 项目 <项目>/PROJECT-STATE/ + <项目>/MEMORY.md（协议 §一）。
 * 项目相关留痕必须落在项目目录，不落在各 agent 私有隐藏目录。
 *
 * 触发器解析约定（协议 §三，2026-10-02 修订）：
 *   - 强触发器 = 列表项（编号 1./2./3. 或 bullet -/*）文本含「触发条件」
 *   - 血泪教训 = bullet 项文本含「⚠️⛔」或「血泪」
 *   - 条目可以跨节不连续（节标题只是上下文，不界定条目边界）
 *   - 条目稳定身份 id = 类型|编号|文本前40字（pull 增量判定、防重复吸收用）
 *
 * 用法：
 *   node memory-sync.cjs gap     [--direction hermes-to-workbuddy]  # 查缺口（推荐每次接手先跑）
 *   node memory-sync.cjs report  [--direction …]
 *   node memory-sync.cjs check --topic "文章 审核"  [--direction …]
 *   node memory-sync.cjs pull    [--direction …]   # 增量重扫 + 推进水位
 *   node memory-sync.cjs tombstone --id "<itemId>" [--direction …]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');

// alignment/ 可能在 <root>/alignment（项目内）或 <here>/alignment（agent-infra 内），两边都要能跑
const ALIGN_DIR = (() => {
  const cands = [path.join(ROOT, 'alignment'), path.join(HERE, 'alignment')];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[cands.length - 1];
})();

const TOMB_DIR = (() => {
  const cands = [path.join(ROOT, 'l2', 'sync'), path.join(path.dirname(ALIGN_DIR), 'tombstones')];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[cands.length - 1];
})();

const TRIGGER_MARKERS = ['触发条件'];
const LESSON_MARKERS = ['⚠️⛔', '血泪'];
const TODO_HEADING_RE = /待办提醒/;

// ── 小工具 ──────────────────────────────────────────────────────────
function expandHome(p) { return p ? p.replace(/^~/, os.homedir()) : p; }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`❌ 读不到 ${file}: ${e.message}`); process.exit(2); }
}

function mtimeMs(p) {
  try { return fs.statSync(expandHome(p)).mtimeMs; } catch { return 0; }
}

function textOf(lines) { return lines.map((s) => s.trim()).join(' ').replace(/\s+/g, ' '); }

function shaId(id) { return crypto.createHash('sha256').update(String(id)).digest('hex'); }

function rel(p) {
  const home = os.homedir();
  return String(p).startsWith(home) ? '~' + String(p).slice(home.length) : String(p);
}

// ── targets 展开：支持 glob（…/PROJECT-STATE/*.md）────────────────────
function globToRe(pat) {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$');
}

function expandTargets(targets) {
  const out = [];
  for (const t of targets) {
    const tf = expandHome(t);
    if (t.includes('*') || t.includes('?')) {
      const dir = path.dirname(tf);
      const re = globToRe(path.basename(t));
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => re.test(f)).sort(); }
      catch { out.push(tf); continue; }
      for (const f of files) out.push(path.join(dir, f));
    } else {
      out.push(tf);
    }
  }
  return Array.from(new Set(out));
}

// 目录自动发现：targets 里没写、但目录里确实有的 md 文件（防「忘了加 target 就永远扫不到」）
function discoverFromDirs(align, already) {
  const found = [];
  for (const d of (align.scan_dirs || [])) {
    const dd = expandHome(d);
    let files = [];
    try { files = fs.readdirSync(dd).filter((f) => f.endsWith('.md')).sort(); }
    catch { console.log(`  ⚠️ scan_dir 读不到：${rel(dd)}`); continue; }
    for (const f of files) {
      const full = path.join(dd, f);
      if (!already.includes(full)) found.push(full);
    }
  }
  return Array.from(new Set(found));
}

// ── 文件指纹：mtime + bytes + lines + 章节标题 ────────────────────────
function scanHeadings(md) {
  return md.split('\n')
    .filter((l) => /^#{1,3}\s+/.test(l))
    .map((l) => l.replace(/^#+\s+/, '').trim());
}

function fingerprint(file) {
  let md = '';
  try { md = fs.readFileSync(file, 'utf8'); }
  catch { return null; }
  return {
    mtime: mtimeMs(file),
    bytes: Buffer.byteLength(md, 'utf8'),
    lines: md.split('\n').length,
    headings: scanHeadings(md),
  };
}

// ── 全文扫描触发器/教训条目 ────────────────────────────────────────
function hasMarker(t) {
  return TRIGGER_MARKERS.some((m) => t.includes(m)) || LESSON_MARKERS.some((m) => t.includes(m));
}

function scanItems(md) {
  const lines = md.split('\n');
  const items = [];
  let heading = '(top)';
  let cur = null;
  const flush = () => { if (cur) { items.push(cur); cur = null; } };

  for (const l of lines) {
    const h = l.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); heading = h[1].trim(); continue; }

    const it = l.match(/^(\d+)[.、)]\s+(.*)$/);
    if (it) { flush(); cur = { num: it[1], heading, bullet: false, lines: [l] }; continue; }

    if (cur) {
      const nb = l.match(/^[-*+]\s+(.*)$/);
      if (nb && TODO_HEADING_RE.test(heading)) {
        flush();
        cur = { num: '•', heading, bullet: true, lines: [l] };
      } else if (l.trim()) {
        cur.lines.push(l);
      }
      continue;
    }

    const b = l.match(/^\s*[-*+]\s+(.*)$/);
    if (b && (hasMarker(b[1]) || TODO_HEADING_RE.test(heading))) {
      cur = { num: '•', heading, bullet: true, lines: [l] };
    }
  }
  flush();

  const out = [];
  for (const it of items) {
    const text = textOf(it.lines);
    const inTodo = TODO_HEADING_RE.test(it.heading);
    if (!inTodo && !hasMarker(text)) continue;
    it.text = text;
    it.isTrigger = inTodo || TRIGGER_MARKERS.some((m) => text.includes(m));
    it.isLesson = !it.isTrigger && LESSON_MARKERS.some((m) => text.includes(m));
    it.id = (it.isTrigger ? 'T' : it.isLesson ? 'L' : 'I') + ':' + it.num + '|' + text.slice(0, 40);
    out.push(it);
  }
  return out;
}

function hitKeywords(item, topic) {
  const kws = String(topic).split(/\s+/).filter(Boolean);
  return kws.filter((k) => item.text.includes(k));
}

// ── 墓碑（tombstone）：跨机可同步的删除标记 ─────────────────────────
// 只存 sha256(itemId)，不存明文 id / 记忆文本。接收方 pull 时比对命中即抑制。
function tombFile(direction) { return path.join(TOMB_DIR, `tombstones-${direction}.jsonl`); }

function loadTombstones(direction) {
  try {
    return new Set(
      fs.readFileSync(tombFile(direction), 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l).keyHash; } catch { return null; } })
        .filter(Boolean)
    );
  } catch { return new Set(); }
}

// ── 主流程 ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { cmd: argv[0] || '', topic: null, direction: 'hermes-to-workbuddy', id: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--topic' && argv[i + 1]) a.topic = argv[++i];
    else if (argv[i] === '--direction' && argv[i + 1]) a.direction = argv[++i];
    else if (argv[i] === '--id' && argv[i + 1]) a.id = argv[++i];
  }
  return a;
}

function resolveTargets(align) {
  const raw = Array.isArray(align.targets) && align.targets.length
    ? align.targets
    : (align.target_canonical ? [align.target_canonical] : null);
  if (!raw) { console.error('❌ alignment 文件既无 targets 列表也无 target_canonical'); process.exit(2); }
  return raw;
}

function handleTombstone(args) {
  if (!args.id) { console.error('❌ tombstone 需要 --id "<itemId>"（从 report/check 输出取 id）'); process.exit(1); }
  fs.mkdirSync(TOMB_DIR, { recursive: true });
  const f = tombFile(args.direction);
  let seq = 0;
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    if (lines.length) seq = (JSON.parse(lines[lines.length - 1]).seq) || 0;
  } catch { /* 新文件，从 0 起 */ }
  const rec = { keyHash: shaId(args.id), seq: seq + 1, ts: new Date().toISOString(), direction: args.direction };
  fs.appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8');
  console.log(`⏱ tombstone 已落盘（脱敏，可入库跨机同步）: ${rel(f)}`);
  console.log(`   keyHash=${rec.keyHash.slice(0, 16)}… seq=${rec.seq} direction=${args.direction}`);
}

// ── gap：文件级 + 章节级缺口检测（v0.2 核心）─────────────────────────
function handleGap(align, args) {
  const rawTargets = resolveTargets(align);
  const files = expandTargets(rawTargets);
  const discovered = discoverFromDirs(align, files);
  const all = files.concat(discovered);

  align._stateSeen = align._stateSeen || {};
  // 兼容旧水位：只有 _mtimeSeen 时，用它初始化
  if (align._mtimeSeen) {
    for (const [k, v] of Object.entries(align._mtimeSeen)) {
      const fk = expandHome(k);
      if (!align._stateSeen[fk]) align._stateSeen[fk] = { mtime: v, lines: 0, headings: [] };
    }
  }

  console.log(`🔍 gap @ ${args.direction}（reader=${align.reader} → target=${align.target}）`);
  console.log(`   共享层文件 ${all.length} 个（targets ${files.length} + 目录新发现 ${discovered.length}）`);

  const never = [];
  const changed = [];
  const clean = [];

  for (const f of all) {
    const fp = fingerprint(f);
    if (!fp) { console.log(`  ⚠️ 读不到 ${rel(f)}`); continue; }
    const seen = align._stateSeen[f];
    if (!seen) { never.push({ f, fp }); continue; }
    if (fp.mtime > (seen.mtime || 0) || fp.lines !== (seen.lines || 0)) {
      const oldH = new Set(seen.headings || []);
      const newH = fp.headings.filter((h) => !oldH.has(h));
      changed.push({ f, fp, seen, newHeadings: newH });
    } else {
      clean.push(f);
    }
  }

  let gapCount = never.length + changed.length;

  if (never.length) {
    console.log(`\n── 🆕 从未读过（${never.length}）── 这些文件在水位里没有记录，接手必读`);
    for (const { f, fp } of never) {
      console.log(`  🆕 ${rel(f)}  ${fp.bytes} B / ${fp.lines} 行`);
      for (const h of fp.headings.slice(0, 8)) console.log(`        § ${h.slice(0, 78)}`);
      if (fp.headings.length > 8) console.log(`        … 另有 ${fp.headings.length - 8} 个章节`);
    }
  }

  if (changed.length) {
    console.log(`\n── 🔄 有更新（${changed.length}）── 水位之后又变了`);
    for (const { f, fp, seen, newHeadings } of changed) {
      const dl = fp.lines - (seen.lines || 0);
      console.log(`  🔄 ${rel(f)}  ${fp.bytes} B / ${fp.lines} 行（较上次 ${dl >= 0 ? '+' : ''}${dl} 行）`);
      if (newHeadings.length) {
        console.log(`       新增章节 ${newHeadings.length}：`);
        for (const h of newHeadings.slice(0, 8)) console.log(`         + § ${h.slice(0, 76)}`);
        if (newHeadings.length > 8) console.log(`         … 另有 ${newHeadings.length - 8} 个`);
      } else {
        console.log(`       章节无新增（正文有改动）`);
      }
    }
  }

  if (clean.length) {
    console.log(`\n── ✅ 无变化（${clean.length}）──`);
    for (const f of clean) console.log(`  ✅ ${rel(f)}`);
  }

  console.log(`\n${gapCount === 0 ? '✅ 无缺口：共享层已全部被水位覆盖' : `⚠️ 缺口 ${gapCount} 个文件待读`}`);
  console.log(`   读完执行：node ${rel(path.join(HERE, 'memory-sync.cjs'))} pull --direction ${args.direction}  # 推进水位`);
  return { all, never, changed };
}

// pull 时同步推进 _stateSeen（不只是 _mtimeSeen）
function advanceState(align, file) {
  const fp = fingerprint(file);
  if (!fp) return;
  align._stateSeen = align._stateSeen || {};
  align._stateSeen[file] = { mtime: fp.mtime, bytes: fp.bytes, lines: fp.lines, headings: fp.headings };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === 'tombstone') { handleTombstone(args); return; }

  const alignFile = path.join(ALIGN_DIR, `${args.direction}.json`);
  const align = readJson(alignFile);

  if (args.cmd === 'gap') { handleGap(align, args); return; }

  const targets = expandTargets(resolveTargets(align));

  switch (args.cmd) {
    case 'report': {
      console.log(`📋 report @ ${args.direction}（reader=${align.reader}）`);
      for (const tf of targets) {
        let md;
        try { md = fs.readFileSync(tf, 'utf8'); }
        catch (e) { console.log(`  ⚠️ 跳过读不到 ${rel(tf)}: ${e.message}`); continue; }
        const items = scanItems(md);
        const lastSeen = (align._mtimeSeen && align._mtimeSeen[tf]) || 0;
        console.log(`\n目标 ${rel(tf)}（触发器/教训 ${items.length} 条；水位 mtime_seen=${lastSeen || '无'}）`);
        for (const it of items) {
          const tag = it.isTrigger ? '强触发' : '血泪教训';
          console.log(`  [${tag}] ${it.num}. ${it.text.slice(0, 80)}${it.text.length > 80 ? '…' : ''}`);
          console.log(`       节: ${it.heading} | id: ${it.id}`);
        }
      }
      break;
    }

    case 'check': {
      if (!args.topic) { console.error('❌ check 需要 --topic "关键词 关键词"'); process.exit(1); }
      console.log(`🔍 check 话题「${args.topic}」@ ${args.direction}`);
      let any = false;
      for (const tf of targets) {
        let md;
        try { md = fs.readFileSync(tf, 'utf8'); }
        catch { console.log(`  ⚠️ 跳过读不到 ${rel(tf)}`); continue; }
        const hits = scanItems(md)
          .map((it) => ({ it, matched: hitKeywords(it, args.topic) }))
          .filter((x) => x.matched.length > 0);
        if (!hits.length) continue;
        any = true;
        console.log(`\n目标 ${rel(tf)}：命中 ${hits.length} 条，应主动 surface 给维护者：`);
        for (const { it, matched } of hits) {
          console.log(`  [命中:${matched.join('/')}|${it.isTrigger ? '强触发' : '血泪'}] ${it.text.slice(0, 100)}${it.text.length > 100 ? '…' : ''}`);
        }
      }
      if (!any) console.log('  未命中任何触发器。');
      break;
    }

    case 'pull': {
      align._mtimeSeen = align._mtimeSeen || {};
      const absorbedIds = new Set((align.absorbed || []).map((a) => a.id || a.src));
      const tombed = loadTombstones(args.direction);
      const now = new Date().toISOString();
      let totalNew = 0;
      console.log(`🔄 pull @ ${args.direction}：按增量重扫 ${targets.length} 个目标`);
      for (const tf of targets) {
        let md;
        try { md = fs.readFileSync(tf, 'utf8'); }
        catch { console.log(`  ⚠️ 跳过读不到 ${rel(tf)}`); continue; }
        const nowMs = mtimeMs(tf);
        const lastSeen = align._mtimeSeen[tf] || 0;
        if (nowMs <= lastSeen) {
          console.log(`  ✅ ${rel(tf)}：mtime 未超水位，无增量`);
          continue;
        }
        const items = scanItems(md);
        const fresh = items.filter((it) => !absorbedIds.has(it.id));
        align.absorbed = align.absorbed || [];
        let reg = 0;
        for (const it of fresh) {
          if (tombed.has(shaId(it.id))) {
            console.log(`     ⏱ tombstoned, skip ${it.id.slice(0, 60)}…`);
            continue;
          }
          align.absorbed.push({
            ts: now.slice(0, 10),
            id: it.id,
            src: rel(tf),
            into: `${align.reader} 触发器池`,
            note: `pull 自动登记（${it.isTrigger ? '强触发' : '血泪教训'}），agent 确认后决定是否吸收进私有层`,
          });
          reg++;
        }
        align._mtimeSeen[tf] = nowMs;
        advanceState(align, tf);
        align.last_sync = align.last_sync || {};
        align.last_sync.ts = now.slice(0, 10);
        align.last_sync.anchor = `pull ${now}: ${rel(tf)} ${items.length} 条（新 ${fresh.length}）`;
        totalNew += reg;
        console.log(`  🔄 ${rel(tf)}：${items.length} 条触发器，其中未吸收过的新条目 ${fresh.length}：`);
        for (const it of fresh) console.log(`     [新] ${it.text.slice(0, 100)}${it.text.length > 100 ? '…' : ''}`);
      }
      fs.writeFileSync(alignFile, JSON.stringify(align, null, 2) + '\n', 'utf8');
      console.log(`  水位已推进 → ${rel(alignFile)}（共登记新条目 ${totalNew}）`);
      break;
    }

    default:
      console.log('用法: node memory-sync.cjs <gap | report | check --topic "…" | pull | tombstone --id "…"> [--direction A-to-B]');
      process.exit(1);
  }
}

main();
