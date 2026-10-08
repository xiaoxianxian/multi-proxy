#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * replay-golden.mjs — golden-set 回放 + 漂移比对 harness
 *
 * 用途：把一份带金标（expected）的基准集，按统一 prompt 过一遍多模型端点（默认 multi-proxy 本地代理），
 *      落一份带「模型版本指纹 + 输出摘要 + usage」的结果 jsonl；再和一份基线结果比对，量化「漂移」。
 *
 * 这是 HF《multi-harness RL》capture proxy 范式的「观测半边」落地：
 *   - 不训练，只测量；
 *   - 漂移信号 = 同一 (id) 在不同次回放里 responseModel 变了 / outDigest 变了 / 判对错变了。
 *
 * 零依赖（仅 Node 内置 fetch + crypto）。Node 18+。
 *
 * 用法：
 *   # 回放
 *   node tools/replay-golden.mjs --bench /path/to/zh-moderation-bench-v1.jsonl \
 *       --base-url http://127.0.0.1:18790/v1 --model qwen3.8:27b-mlx \
 *       --out /tmp/run-a.jsonl --label "qwen3.8-27b-mlx@2026-10-06"
 *
 *   # 比对两次回放（漂移）
 *   node tools/replay-golden.mjs --compare /tmp/run-a.jsonl /tmp/run-b.jsonl
 *
 * 注：prompt 构造针对 Jev/机审类「二选一 + expected」基准做了适配；换基准集时改 buildPrompt()。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.compare) {
  runCompare(ARGS.compare[0], ARGS.compare[1]);
  process.exit(0);
}

const BENCH = ARGS.bench;
const OUT = ARGS.out || '/tmp/replay-out.jsonl';
const BASE_URL = (ARGS['base-url'] || 'http://127.0.0.1:18790/v1').replace(/\/$/, '');
const MODEL = ARGS.model || 'qwen3.8:27b-mlx';
const API_KEY = ARGS['api-key'] || 'proxy';
const LABEL = ARGS.label || null;
const LIMIT = ARGS.limit ? parseInt(ARGS.limit, 10) : Infinity;
const CONCURRENCY = ARGS.concurrency ? parseInt(ARGS.concurrency, 10) : 4;

if (!BENCH) {
  console.error('缺少 --bench <文件>');
  process.exit(2);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

async function main() {
  const rows = readJsonl(BENCH);
  const items = rows.slice(0, LIMIT);
  console.log(`[replay] bench=${BENCH} 条目=${items.length} 端点=${BASE_URL} 模型=${MODEL}`);
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  const out = fs.createWriteStream(OUT, { flags: 'w' });

  let done = 0, ok = 0;
  const queue = items.map((it, i) => ({ it, i }));
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const { it, i } = queue[cursor++];
      const rec = await replayOne(it, i);
      out.write(JSON.stringify(rec) + '\n');
      done++;
      if (rec.match) ok++;
      if ((done % 10) === 0 || done === items.length) {
        process.stderr.write(`  …${done}/${items.length} 当前命中=${ok}\r`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  out.end();
  console.log(`\n[replay] 完成 → ${OUT}  命中=${ok}/${items.length}`);
}

async function replayOne(it, idx) {
  const prompt = buildPrompt(it);
  const t0 = Date.now();
  let raw, parsed = null, err = null;
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        max_tokens: 64,
        temperature: 0,
      }),
    });
    raw = await resp.text();
    try { parsed = JSON.parse(raw); } catch { /* 非 JSON 响应 */ }
  } catch (e) { err = e.message; }

  const content = parsed?.choices?.[0]?.message?.content ?? parsed?.content?.[0]?.text ?? raw ?? '';
  const verdict = extractVerdict(content, it.options);
  const expected = it.expected ?? null;
  const outDigest = content ? crypto.createHash('sha256').update(content).digest('hex').slice(0, 16) : null;

  return {
    id: it.id,
    idx,
    category: it.category ?? null,
    difficulty: it.difficulty ?? null,
    requestedModel: MODEL,
    responseModel: parsed?.model ?? null,
    versionLabel: LABEL,
    usage: parsed?.usage ?? null,
    verdict,
    expected,
    match: expected != null ? verdict === expected : null,
    outPreview: content.slice(0, 200),
    outDigest,
    finishReason: parsed?.choices?.[0]?.finish_reason ?? parsed?.stop_reason ?? null,
    ms: Date.now() - t0,
    ts: Date.now(),
    error: err,
  };
}

/** prompt 构造（机审二分类基准适配）。换基准集时改这里。 */
function buildPrompt(it) {
  const opts = (it.options || []).map((o) => `- ${o.id}: ${o.description}`).join('\n');
  const system = (it.state || '请判断内容是否需要拦截。') +
    `\n只能输出选项 id（如 ${it.expected ? it.expected : 'harmful'}），不要解释。`;
  const user = `待判断内容：${it.question || ''}\n\n可选：\n${opts}\n\n输出选项 id：`;
  return { system, user };
}

/** 从模型输出里抠出选项 id；抽取不到则返回原始内容的 sha 片段（仍可用于 digest 漂移判定）。 */
function extractVerdict(content, options) {
  if (!content) return null;
  const ids = (options || []).map((o) => o.id);
  for (const id of ids) {
    if (new RegExp(`(^|\\s|["'>\`])${escapeRe(id)}(\\s|["'<\` ,.:!?]|$)`).test(content)) return id;
  }
  return content.trim().slice(0, 32);
}

function runCompare(aPath, bPath) {
  const a = indexById(readJsonl(aPath));
  const b = indexById(readJsonl(bPath));
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  let modelSwap = 0, digestDrift = 0, verdictFlip = 0, onlyA = 0, onlyB = 0;
  const flips = [];
  for (const id of ids) {
    const ra = a[id], rb = b[id];
    if (ra && !rb) { onlyA++; continue; }
    if (!ra && rb) { onlyB++; continue; }
    if (ra.responseModel && rb.responseModel && ra.responseModel !== rb.responseModel) modelSwap++;
    if (ra.outDigest && rb.outDigest && ra.outDigest !== rb.outDigest) digestDrift++;
    if (ra.match != null && rb.match != null && ra.match !== rb.match) {
      verdictFlip++;
      flips.push({ id, a: ra.verdict, b: rb.verdict, expected: ra.expected });
    }
  }
  const n = ids.length - onlyA - onlyB;
  console.log(`\n=== 漂移比对：${aPath}  vs  ${bPath} ===`);
  console.log(`可比条目        : ${n}`);
  console.log(`模型静默换后端   : ${modelSwap}  (responseModel 变了)`);
  console.log(`输出摘要漂移     : ${digestDrift}  (outDigest 变了)`);
  console.log(`判对错翻转       : ${verdictFlip}  (match 从对变错 / 错变对)`);
  console.log(`仅 A 有 / 仅 B 有 : ${onlyA} / ${onlyB}`);
  if (flips.length) {
    console.log(`\n翻转明细（前 ${Math.min(flips.length, 20)} 条）:`);
    for (const f of flips.slice(0, 20)) console.log(`  ${f.id}: ${f.a} → ${f.b}  (金标=${f.expected})`);
  }
  // 准确率
  const accA = accuracy(a), accB = accuracy(b);
  console.log(`\n准确率 A=${accA}  B=${accB}`);
}

function accuracy(idx) {
  const vals = Object.values(idx).filter((r) => r.match != null);
  if (!vals.length) return 'n/a';
  const hit = vals.filter((r) => r.match).length;
  return `${(hit / vals.length * 100).toFixed(1)}% (${hit}/${vals.length})`;
}

// ---------- 工具 ----------
function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function indexById(rows) {
  const m = {};
  for (const r of rows) if (r.id != null) m[r.id] = r;
  return m;
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--compare') { o.compare = [argv[++i], argv[++i]]; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      o[k] = v;
    }
  }
  return o;
}
