#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * tools/memory-sync.cjs — agent 记忆对齐协议的「可执行同步」(v0.1)
 *
 * 对应 l2/memory-alignment-protocol.md。零 npm，Node>=18，.cjs（见 AGENTS §4）。
 * 这是把"规矩"跑起来的第一步：读 alignment/<reader>-to-<target>.json 拿目标与水位，
 * 解析目标记忆里的触发器/教训条目，按话题命中 surface 给维护者；pull 时按 mtime
 * 判增量、只推进水位（永不全量重读对方大记忆）。
 *
 * 触发器解析约定（协议 §三，2026-10-02 修订，务必与写触发器的人对齐）：
 *   - 强触发器 = 列表项（编号 1./2./3. 或 bullet -/*）文本含「触发条件」
 *   - 血泪教训 = bullet 项文本含「⚠️⛔」或「血泪」
 *   - 条目物理上**可以跨节不连续**（节标题只是上下文，不界定条目边界——
 *     实测 WB MEMORY 的 ⏳ 节第 1、2 条之间夹着整个「履历平台项目映射」节）
 *   - 条目稳定身份 id = 类型|编号|文本前40字（pull 增量判定、防重复吸收用）
 *   - 不带上述标记的普通列表项不进入触发器池（宁缺毋滥；要扩标记改 TRIGGER_MARKERS）
 *
 * 用法：
 *   node tools/memory-sync.cjs report [--direction hermes-to-workbuddy]
 *   node tools/memory-sync.cjs check --topic "文章 审核 机审" [--direction ...]
 *   node tools/memory-sync.cjs pull   [--direction ...]   # 增量重扫 + 推进水位（写回 alignment json）
 * 对称跑 WB 侧：--direction workbuddy-to-hermes（该方向 targets 为多文件列表）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const ALIGN_DIR = path.join(ROOT, 'alignment');
const TRIGGER_MARKERS = ['触发条件'];
const LESSON_MARKERS = ['⚠️⛔', '血泪'];
const TODO_HEADING_RE = /待办提醒/; // 节级识别：WB 两种写法都要认——全局 MEMORY 的条目带「触发条件」字样，项目 MEMORY 的待办节条目不一定带

// ── 小工具 ──────────────────────────────────────────────────────────
function expandHome(p) { return p ? p.replace(/^~/, os.homedir()) : p; }

// ── 墓碑（tombstone）：跨机可同步的删除标记（2026-10-08，维护者选 ② 另找可入库落点）──
// 落点 l2/sync/tombstones-<direction>.jsonl（NOT alignment/，可入库；alignment/ 含内部代号/绝对路径永不入库）。
// 防泄露：只存 sha256(itemId)，不存明文 id / 记忆文本。接收方 pull 时对自己每条 item 算 sha256(id) 比对，命中即抑制。
const crypto = require('node:crypto');
const TOMB_DIR = path.join(ROOT, 'l2', 'sync');
function tombFile(direction) { return path.join(TOMB_DIR, `tombstones-${direction}.jsonl`); }
function shaId(id) { return crypto.createHash('sha256').update(String(id)).digest('hex'); }
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

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`❌ 读不到 ${file}: ${e.message}`); process.exit(2); }
}

function mtimeMs(p) {
  try { return fs.statSync(expandHome(p)).mtimeMs; } catch { return 0; }
}

function textOf(lines) { return lines.map((s) => s.trim()).join(' ').replace(/\s+/g, ' '); }

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
      // 在「⏳ 待办提醒」节内，行首（column-0）bullet 是独立触发器条目 → flush 后另起
      // （否则会被吞进上一条编号项的续行；带缩进的 bullet 仍视为续行/子列表）
      const nb = l.match(/^[-*+]\s+(.*)$/);
      if (nb && TODO_HEADING_RE.test(heading)) {
        flush();
        cur = { num: '•', heading, bullet: true, lines: [l] };
      } else if (l.trim()) {
        // 编号项续行（补注/换行）；空行不切断，下一个编号/标题才切断
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
    // 标记命中 OR 落在「⏳ 待办提醒」节内 → 进触发器池（两种写法兼容）
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
  if (Array.isArray(align.targets) && align.targets.length) return align.targets;
  if (align.target_canonical) return [align.target_canonical];
  console.error('❌ alignment 文件既无 targets 列表也无 target_canonical');
  process.exit(2);
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
  console.log(`⏱ tombstone 已落盘（committable + 脱敏，可入库跨机同步）: ${f}`);
  console.log(`   keyHash=${rec.keyHash.slice(0, 16)}… seq=${rec.seq} direction=${args.direction}`);
  console.log(`   接收方 pull 同 direction 时，会自动抑制该 itemId 对应的条目（不表面、不吸收）。`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // tombstone 是独立删除标记，不需要 alignment 配置，提前放行（alignment/ 可能尚未初始化）
  if (args.cmd === 'tombstone') { handleTombstone(args); return; }

  const alignFile = path.join(ALIGN_DIR, `${args.direction}.json`);
  const align = readJson(alignFile);
  const targets = resolveTargets(align);

  switch (args.cmd) {
    case 'report': {
      console.log(`📋 report @ ${args.direction}（reader=${align.reader}）`);
      for (const t of targets) {
        const tf = expandHome(t);
        let md;
        try { md = fs.readFileSync(tf, 'utf8'); }
        catch (e) { console.log(`  ⚠️ 跳过读不到 ${tf}: ${e.message}`); continue; }
        const items = scanItems(md);
        const lastSeen = (align._mtimeSeen && align._mtimeSeen[t]) || 0;
        console.log(`\n目标 ${t}（触发器/教训 ${items.length} 条；水位 mtime_seen=${lastSeen || '无'}）`);
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
      for (const t of targets) {
        const tf = expandHome(t);
        let md;
        try { md = fs.readFileSync(tf, 'utf8'); }
        catch { console.log(`  ⚠️ 跳过读不到 ${tf}`); continue; }
        const hits = scanItems(md)
          .map((it) => ({ it, matched: hitKeywords(it, args.topic) }))
          .filter((x) => x.matched.length > 0);
        if (!hits.length) continue;
        any = true;
        console.log(`\n目标 ${t}：命中 ${hits.length} 条，应主动 surface 给维护者：`);
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
      console.log(`🔄 pull @ ${args.direction}：按 mtime 增量重扫 ${targets.length} 个目标`);
      for (const t of targets) {
        const tf = expandHome(t);
        let md;
        try { md = fs.readFileSync(tf, 'utf8'); }
        catch { console.log(`  ⚠️ 跳过读不到 ${tf}`); continue; }
        const nowMs = mtimeMs(tf);
        const lastSeen = align._mtimeSeen[t] || 0;
        if (nowMs <= lastSeen) {
          console.log(`  ✅ ${t}：mtime 未超水位，无增量`);
          continue;
        }
        const items = scanItems(md);
        const fresh = items.filter((it) => !absorbedIds.has(it.id));
        align.absorbed = align.absorbed || [];
        for (const it of fresh) {
          if (tombed.has(shaId(it.id))) {
            console.log(`     ⏱ tombstoned, skip ${it.id.slice(0, 60)}…`);
            continue;
          }
          align.absorbed.push({
            ts: now.slice(0, 10),
            id: it.id,
            src: t,
            into: `${align.reader} 触发器池`,
            note: `pull 自动登记（${it.isTrigger ? '强触发' : '血泪教训'}），agent 确认后决定是否吸收进私有层`,
          });
        }
        align._mtimeSeen[t] = nowMs;
        align.last_sync = align.last_sync || {};
        align.last_sync.ts = now.slice(0, 10);
        align.last_sync.anchor = `pull ${now}: ${t} ${items.length} 条（新 ${fresh.length}）`;
        totalNew += fresh.length;
        console.log(`  🔄 ${t}：${items.length} 条触发器，其中未吸收过的新条目 ${fresh.length}：`);
        for (const it of fresh) console.log(`     [新] ${it.text.slice(0, 100)}${it.text.length > 100 ? '…' : ''}`);
      }
      fs.writeFileSync(alignFile, JSON.stringify(align, null, 2) + '\n', 'utf8');
      console.log(`  水位已推进 → ${alignFile}（共登记新条目 ${totalNew}）`);
      break;
    }

    default:
      console.log('用法: node tools/memory-sync.cjs <report | check --topic "…" | pull | tombstone --id "…"> [--direction A-to-B]');
      process.exit(1);
  }
}

main();
