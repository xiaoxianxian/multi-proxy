#!/usr/bin/env node
'use strict';
// 估算器校准：把内核的启发式估算，对上真 tokenizer 的实际值。
//
// 为什么需要：内核原来用的是「CJK 3 字符 ≈ 1 token」的拍脑袋公式。不校准，所有
// 「91.2% 是固定开销」这类百分比都不能对外；而中文占比高的语料上它**系统性低估 73%**。
//
// 语料（--corpus 选）：
//   sessions（默认）本机真实历史会话 ~/.codex/sessions/**/rollout-*.jsonl（不外传、不打印正文，只出统计）
//   skills    本机真实 SKILL.md 全文（l2/skill-hosts.js 扫出来的 129 份）—— 估算器现在就是给
//             「skill 上下文资产账本」记钱的，拿会话语料去拟合系数其实是**答非所问**，
//             2026-10-01 的系数就是改用 skills 语料拟合出来的。
// 真值（--truth 选，默认 o200k）：
//   o200k  gpt-tokenizer（o200k_base，GPT-4o/5 系）—— 2026-10-01 那组系数就是拿它拟合的
//   qwen   本机 Ollama 模型的 tokenizer.json（HF tokenizers）—— 走 tools/qwen-tokenizer-count.py，
//          只为数 token 不去起模型（MLX 27B 起一次几秒还占 18GB）
//
// 用法：
//   TOKENIZER_PKG=/path/to/node_modules/gpt-tokenizer node tools/token-estimate-calibrate.js
//   TOKENIZER_PKG=... node tools/token-estimate-calibrate.js --corpus=skills
//   node tools/token-estimate-calibrate.js --truth=qwen --tokenizer-file=.../tokenizer.json
//   → 结果落 logs/token-estimate-calibration.json（含 recommended 系数）；控制台打印分组误差表。

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const SESSIONS = process.env.CODEX_SESSIONS || path.join(os.homedir(), '.codex', 'sessions');
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS || 400);
const CORPUS = process.argv.includes('--corpus=skills') ? 'skills' : 'sessions';
const TRUTH = (process.argv.find((a) => a.startsWith('--truth=')) || '--truth=o200k').slice('--truth='.length);
const TOKENIZER_FILE = (process.argv.find((a) => a.startsWith('--tokenizer-file=')) || '').slice('--tokenizer-file='.length);
// ⚠️ 文件名带 truth：o200k 与 qwen 的系数**不一样**，两份证据必须能同时看，
//   共用一个文件名会互相覆盖（上一版就因此干净地盖掉了 o200k 那份）。
const OUT = process.env.CALIB_OUT
    || path.join(__dirname, '..', 'logs', `token-estimate-calibration-${TRUTH}.json`);

// 数真值：qwen 走 HF tokenizers（一次调用把整批文本数完，别一条一进程）
function countWithQwen(texts) {
    const tmp = path.join(os.tmpdir(), `qwen-tok-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(texts));
    try {
        const py = process.env.QWEN_TOKENIZER_PY || 'python3';
        const out = cp.execSync(`${JSON.stringify(py)} ${JSON.stringify(path.join(__dirname, 'qwen-tokenizer-count.py'))} ${JSON.stringify(TOKENIZER_FILE)} ${JSON.stringify(tmp)}`,
            { maxBuffer: 1 << 28 }).toString().trim();
        const arr = JSON.parse(out);
        if (!Array.isArray(arr) || arr.length !== texts.length) { throw new Error(`python 回的是 ${out.slice(0, 120)}`); }
        return arr;
    } finally { fs.rmSync(tmp, { force: true }); }
}

// 与内核完全一致的估算公式（改了一边必须改另一边）：CJK-aware，系数可 env 覆盖。
const CJK_RATIO = Number(process.env.TOKEN_CJK_RATIO ?? '') || 1.04;
const ASCII_RATIO = Number(process.env.TOKEN_ASCII_RATIO ?? '') || 0.255;
const CJK_RE = /[㐀-䶿一-鿿぀-ヿ豈-﫿]/g;
const estNow = (s) => Math.max(1, Math.round((s.match(CJK_RE) || []).length * CJK_RATIO + s.replace(CJK_RE, '').length * ASCII_RATIO));
// 旧公式（留着做对照，别删：它是「这条校准是为了修它」的证据）
const estOld = (s) => Math.max(1, Math.ceil(String(s).length / 3));

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  return c == null ? '' : JSON.stringify(c);
}

function classify(s) {
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uff00-\uffef]/g) || []).length;
  if (s.length && cjk / s.length >= 0.25) return 'cjk';
  if (/```|function\s|\bconst\s|\bdef\s|=>|;\n|\{[\s\S]{20,}\}/.test(s)) return 'code';
  return 'ascii';
}

// ---------- 取真实语料 ----------
function collectSessions() {
  let files = [];
  try { files = cp.execSync(`find ${JSON.stringify(SESSIONS)} -name "rollout-*.jsonl" -type f`).toString().trim().split('\n').filter(Boolean); }
  catch { return []; }
  const blocks = [];
  for (const f of files) {
    if (blocks.length >= MAX_BLOCKS * 4) break;
    let lines;
    try { lines = fs.readFileSync(f, 'utf8').trim().split('\n'); } catch { continue; }
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      const p = o.payload || {};
      if (p.role === 'user') blocks.push({ kind: 'user', text: textOf(p.content) });
      else if (p.type === 'message' && p.role === 'assistant') blocks.push({ kind: 'assistant', text: textOf(p.content) });
      else if (p.type === 'function_call') blocks.push({ kind: 'call', text: textOf(p.arguments) });
      else if (p.type === 'function_call_output') blocks.push({ kind: 'toolout', text: textOf(p.output) });
    }
  }
  return blocks.filter((b) => b.text && b.text.length >= 40);
}

// skills 语料：本机真实 SKILL.md 全文。skill 账本就是拿估算器记钱，
// 拿会话语料拟合系数是答非所问 —— 2026-10-01 那组系数就是这条路径拟合出来的。
function collectSkills() {
  const SH = require('../l2/skill-hosts.js');
  const ledger = SH.scanLedger({ tokens: false });
  const out = [];
  for (const e of ledger.entries) {
    if (!e.entry || !fs.existsSync(e.entry)) continue;
    let t; try { t = fs.readFileSync(e.entry, 'utf8'); } catch { continue; }
    if (t && t.length >= 40) out.push({ kind: 'skill', text: t });
  }
  return out;
}

function collect() {
  return CORPUS === 'skills' ? collectSkills() : collectSessions();
}

// ---------- 主流程 ----------
let tok;
if (TRUTH === 'qwen') {
    if (!TOKENIZER_FILE || !fs.existsSync(TOKENIZER_FILE)) {
        console.error('缺 --tokenizer-file=<tokenizer.json>。\n' +
            '本机拿 tokenizer.json 的办法（一次性，模型已在那儿）：\n' +
            '  python3 -c "import json,os;m=json.load(open(os.path.expanduser(\'~/.ollama/models/manifests/registry.ollama.ai/library/qwen3.8/27b-mlx\'));print([l[\'digest\'] for l in m[\'layers\'] if l.get(\'name\')==\'tokenizer.json\'][0])"\n' +
            '  # 拿到 digest 后：cp ~/.ollama/models/blobs/sha256-<digest> /tmp/qwen-tokenizer/tokenizer.json\n' +
            `然后：QWEN_TOKENIZER_PY=/path/to/python-with-tokenizers node tools/token-estimate-calibrate.js --corpus=skills --truth=qwen --tokenizer-file=/tmp/qwen-tokenizer/tokenizer.json`);
        process.exit(2);
    }
    try { cp.execSync(`${process.env.QWEN_TOKENIZER_PY || 'python3'} -c "import tokenizers"`, { stdio: 'ignore' }); }
    catch (e) { console.error('python 里没有 tokenizers 包：pip install tokenizers（或给 QWEN_TOKENIZER_PY 指向装了的那个 venv）'); process.exit(2); }
} else {
    try {
        tok = require(process.env.TOKENIZER_PKG || 'gpt-tokenizer');
    } catch (e) {
        console.error('缺少真 tokenizer。先装（一次性）：\n  mkdir -p /tmp/tokcal && cd /tmp/tokcal && npm i gpt-tokenizer --no-bin-links\n然后：\n  TOKENIZER_PKG=/tmp/tokcal/node_modules/gpt-tokenizer node tools/token-estimate-calibrate.js');
        process.exit(2);
    }
}

const blocks = collect();
// 分层抽样：保证小/中/大文本都进样本，避免全被几条超长工具输出淹没
const sorted = blocks.sort((a, b) => a.text.length - b.text.length);
const step = Math.max(1, Math.floor(sorted.length / MAX_BLOCKS));
const sample = sorted.filter((_, i) => i % step === 0);

// 真值：qwen 用批量数好的数组，o200k 逐条问 gpt-tokenizer
const acts = TRUTH === 'qwen' ? countWithQwen(sample.map((b) => b.text)) : null;

// 分组：按 CJK 占比分桶。旧版用「含代码特征就归 code」的启发式，会把中英混排的长块错分，
// 出来的 cjk 桶 median 与 tokens/char 互相打脸（1.016 vs 0.5165）—— 那是分组的锅，不是系数的锅。
const groups = { 'cjk>=0.5': [], 'cjk 0.1-0.5': [], 'cjk<0.1': [], all: [] };
sample.forEach((b, i) => {
  const est = estNow(b.text);
  const act = acts ? acts[i] : tok.countTokens(b.text);
  if (!act) return;                     // forEach 里没有 continue，0 token 的块直接跳过
  const len = b.text.length;
  const cjk = (b.text.match(CJK_RE) || []).length;
  const r = act / est;
  const row = { len, cjk, est, act, ratio: +r.toFixed(4), text: b.text };   // text 留在内存里给下面的公式对照用
  const k = cjk / len >= 0.5 ? 'cjk>=0.5' : cjk / len >= 0.1 ? 'cjk 0.1-0.5' : 'cjk<0.1';
  groups[k].push(row);
  groups.all.push(row);
});

const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length * p)]; };
function summarize(name, rows) {
  if (!rows.length) return null;
  const ratios = rows.map((r) => r.ratio);
  const sumEst = rows.reduce((s, r) => s + r.est, 0);
  const sumAct = rows.reduce((s, r) => s + r.act, 0);
  const sumLen = rows.reduce((s, r) => s + r.len, 0);
  return {
    group: name, n: rows.length,
    medianRatio: +q(ratios, 0.5).toFixed(3),
    p10Ratio: +q(ratios, 0.1).toFixed(3),
    p90Ratio: +q(ratios, 0.9).toFixed(3),
    weightedRatio: +(sumAct / sumEst).toFixed(3),
    tokensPerChar: +(sumAct / sumLen).toFixed(4),
    // 这一桶里「旧公式 ceil(len/3) 是真值的几倍」——>1 就是旧公式在低估
    oldFormulaRatio: +(sumAct / rows.reduce((s, r) => s + estOld(r.text), 0)).toFixed(3),
  };
}

// 拟合推荐系数（对 est = a*cjk字 + b*非cjk字符 做最小二乘，网格搜索）。
// ⚠️ 别用多元回归直接解：会话语料几乎全英文，列共线性会把 b 压成负数，结果荒谬。网格搜索 + 约束更稳。
function fitCoeffs(rows) {
  let best = null;
  for (let a = 0.3; a <= 2.0; a += 0.02) {
    for (let b = 0.15; b <= 0.6; b += 0.005) {
      let err = 0;
      for (const r of rows) { const e = a * r.cjk + b * (r.len - r.cjk); err += (r.act - e) * (r.act - e); }
      if (!best || err < best.err) best = { a, b, err };
    }
  }
  return { cjkRatio: +best.a.toFixed(3), asciiRatio: +best.b.toFixed(3) };
}

const result = {
  ts: new Date().toISOString(),
  tokenizer: TRUTH === 'qwen' ? 'HF tokenizers(本地 qwen3.8 tokenizer.json)' : 'gpt-tokenizer(o200k_base)',
  corpus: CORPUS,
  corpusPath: CORPUS === 'skills' ? '本机 129 份真实 SKILL.md 全文（l2/skill-hosts.scanLedger）' : SESSIONS,
  corpusBlocks: blocks.length,
  sampleSize: sample.length,
  groups: Object.entries(groups).map(([k, v]) => summarize(k, v)).filter(Boolean),
  recommended: fitCoeffs(groups.all),
  // 留个对照，证明「为什么要改」：旧公式在中文占比高的桶里到底差多少
  formulas: (() => {
    const rows = groups.all;
    const mape = (fn) => {
      let s = 0;
      for (const r of rows) { const e = fn(r.text); s += Math.pow((r.act - e) / r.act, 2); }
      return +(Math.sqrt(s / rows.length)).toFixed(4);
    };
    const w = (fn) => {
      const se = rows.reduce((s, r) => s + fn(r.text), 0);
      const sa = rows.reduce((s, r) => s + r.act, 0);
      return +(sa / se).toFixed(3);
    };
    const rec = fitCoeffs(rows);
    return {
      'ceil(len/3)（旧）': { weighted: w(estOld), mape: mape(estOld) },
      'cjk*0.75+rest/3.6（sidecar 旧式）': { weighted: w((t) => Math.round((t.match(CJK_RE) || []).length * 0.75 + t.replace(CJK_RE, '').length / 3.6)), mape: 0 },
      [`cjk*1.04+rest*0.255（现行）`]: { weighted: w(estNow), mape: mape(estNow) },
      [`拟合推荐 cjk*${rec.cjkRatio}+rest*${rec.asciiRatio}`]: { weighted: w((t) => Math.max(1, Math.round((t.match(CJK_RE) || []).length * rec.cjkRatio + t.replace(CJK_RE, '').length * rec.asciiRatio))), mape: mape((t) => Math.max(1, Math.round((t.match(CJK_RE) || []).length * rec.cjkRatio + t.replace(CJK_RE, '').length * rec.asciiRatio))) },
    };
  })(),
};

try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); } catch (e) { console.error('写盘失败:', e.message); }

console.log(`语料 ${result.corpusBlocks} 块 → 抽样 ${result.sampleSize} | 语料类型=${CORPUS} | tokenizer=${result.tokenizer}`);
console.log('（ratio = 真值 / 我们的估算；>1 说明我们低估；oldFormulaRatio 是旧公式在**这一桶**的失真度）\n');
console.log('分组           n     median   p10     p90     weighted  tokens/char  oldFormulaRatio');
for (const g of result.groups) {
  console.log(`${g.group.padEnd(13)}${String(g.n).padStart(4)}   ${String(g.medianRatio).padEnd(7)} ${String(g.p10Ratio).padEnd(7)} ${String(g.p90Ratio).padEnd(7)} ${String(g.weightedRatio).padEnd(9)} ${String(g.tokensPerChar).padEnd(11)} ${g.oldFormulaRatio}`);
}
console.log(`\n拟合推荐系数：cjk ${result.recommended.cjkRatio} token/字、ascii ${result.recommended.asciiRatio} token/字符`);
console.log('公式对照：');
for (const [k, v] of Object.entries(result.formulas)) { console.log(`  ${k.padEnd(34)} weighted=${v.weighted}  MAPE=${v.mape}`); }
console.log(`\n结果已落 ${OUT}`);
