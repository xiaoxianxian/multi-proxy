#!/usr/bin/env node
'use strict';
// 整包级估算校准（2026-10-02 新增，与块级校准 tools/token-estimate-calibrate.js 分工）
//
// 为什么需要第二个校准器：块级校准（129 份 SKILL.md + 会话）拟合的是「一段文本的估计准不准」。
// 而桥里真正报出去的数是 **estTotal = 整包七类之和**（tools/token-policy-bridge.js:508，
// 第 ① 步 fold 在 hook 链之前算的，早于任何改写）。整包 ≠ 逐块求和：
//   - 工具 schema 按 JSON.stringify 整段估（context-fold.js:209）
//   - system/instructions 单独成一类（fold 把 sys.concat(messages) 喂进来）
//   - 还有 role 分隔符、裸 JSON 结构这些「块与块之间」的 token
// 块级系数再准，也答不了「整包 estTotal 差多少」。这条线专治整包。
//
// 对照口径（必须和桥第 ① 步一字不差，否则对拍无意义）：
//   桥 = CF.fold({ ...body, messages: sys.concat(ctx.messages) })
//   本脚本 = 同一份 body + 同一份 ctxFromRequest 归一，只把 estimate 换成真 tokenizer。
//
// 🔴 硬边界（别越界）：o200k 是**代理真值**，不是 agnes 上游的真 tokenizer。
//    上游 agnes 的 tokenizer 无法本地数（/user/balance 被 Cloudflare 挡、模型侧也没暴露）。
//    ⇒ 本脚本只回答「估算器相对 o200k 偏多少」，**不回答 agnes 实际按什么计费**。
//    那条线要靠真链路 A/B 双发（见 --ab 分支说明），两者不许混为一谈。
//
// 用法：
//   TOKENIZER_PKG=/tmp/tokcal/node_modules/gpt-tokenizer \
//     node tools/token-estimate-calibrate-whole.js \
//       [--corpus=logs/bridge-corpus-*.jsonl] [--max=50] [--fit]
//   --fit   网格搜索新的 (cjkRatio, asciiRatio)，使整包 est 逼近 o200k truth
//   输出：logs/token-estimate-calibration-whole-o200k.json + 控制台对比表
// 环境变量（与 l2/token-policy.js 同约定，改了内核要同步改这里）：
//   TOKEN_CJK_RATIO（默认 1.04）／TOKEN_ASCII_RATIO（默认 0.255）

const fs = require('fs');
const path = require('path');
const os = require('os');

const B = require('../tools/token-policy-bridge.js');
const CF = require('../l2/context-fold.js');

const TOKENIZER_PKG = process.env.TOKENIZER_PKG || '/tmp/tokcal/node_modules/gpt-tokenizer';
// 两种指法都认：TOKENIZER_PKG 直接给包目录（既有脚本用法）或给包内入口文件。
const loadTok = () => {
  try { return require(TOKENIZER_PKG); } catch { return require(path.join(TOKENIZER_PKG, 'gpt-tokenizer')); }
};
const { countTokens } = loadTok();

const CJK_RE = /[㐀-䶿一-鿿぀-ヿ豈-﫿]/g;
const CJK_RATIO = Number(process.env.TOKEN_CJK_RATIO ?? '') || 1.04;
const ASCII_RATIO = Number(process.env.TOKEN_ASCII_RATIO ?? '') || 0.255;
const estNow = (s) => Math.max(1, Math.round((s.match(CJK_RE) || []).length * CJK_RATIO + s.replace(CJK_RE, '').length * ASCII_RATIO));

// 🔴 默认值分支**不要**再 slice：早期写成 `(arg || 'logs/bridge-corpus-*.jsonl').slice(9)`
//    ——没传 --corpus 时默认值被削掉前 9 个字符变成 `ge-corpus-*.jsonl`，静默零样本。
const CORPUS_ARG = process.argv.find((a) => a.startsWith('--corpus='));
const CORPUS_GLOB = CORPUS_ARG ? CORPUS_ARG.slice('--corpus='.length) : 'logs/bridge-corpus-*.jsonl';
const MAX_ROWS = Number((process.argv.find((a) => a.startsWith('--max=')) || '').slice('--max='.length)) || 50;
const DO_FIT = process.argv.includes('--fit');
const OUT = process.env.CALIB_OUT || path.join(__dirname, '..', 'logs', 'token-estimate-calibration-whole-o200k.json');

// ---- 语料：桥抓的真包（bridge-corpus-*.jsonl，CAPTURE_BODY 落盘，不改生产代码一行）----
function collect() {
  // ⚠️ 不用 shell glob/ls：沙箱里 execSync 的 sh 展开不到这里的中文路径（报 ENOENT），
  //    直接 readdir 扫。这个坑跟项目经理无关，纯粹是别让校准器依赖外部 shell。
  const abs = path.join(__dirname, '..', CORPUS_GLOB);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.match(new RegExp('^' + base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')))
      .map((f) => path.join(dir, f))
    : [];
  const rows = [];
  for (const f of files) {
    for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) {
      if (!l.trim()) continue;
      try { rows.push(JSON.parse(l)); } catch { /* 坏行跳过，别让它把整批校准带崩 */ }
    }
  }
  return rows.sort((a, b) => new Date(a.ts) - new Date(b.ts)).slice(-MAX_ROWS);
}

// 与桥第 ① 步同构：归一 responses → messages，再 sys.concat(messages) 喂 fold。
function buildRequest(row) {
  const body = row.body || {};
  const isResponses = String(row.path || '').startsWith('/v1/responses');
  const api = isResponses ? 'responses' : 'chat-completions';
  let ctx = null;
  try { ctx = B.ctxFromRequest(body, api); } catch (e) { return null; }
  if (!ctx) return null;
  const sys = ctx.systemPrompt ? [{ role: 'system', content: ctx.systemPrompt }] : [];
  return { request: { ...body, messages: sys.concat(ctx.messages) }, ctx };
}

/** 用给定 estimate 跑一遍 fold，返回整包 total。同结构、只换秤。 */
function totalWith(request, estimate) {
  const f = CF.createContextFold({ estimate }).fold(request);
  return f.estimate.total;
}

const rows = collect();
if (!rows.length) {
  console.error(`样本为空：没读到语料。corpus=${CORPUS_GLOB}（在 ${path.join(__dirname, '..')} 下找 logs/bridge-corpus-*.jsonl）`);
}
const samples = [];
for (const row of rows) {
  const built = buildRequest(row);
  if (!built) continue;
  const { request } = built;
  const truth = totalWith(request, (s) => Math.max(1, countTokens(String(s))));
  const est = totalWith(request, estNow);
  samples.push({
    ts: row.ts, path: row.path, model: row.model,
    estTotal: est, truthO200k: truth,
    ratio: truth / est,                       // >1 = 估算低估
    bias: (truth - est) / est,                // 负 = 估低了
    estSaved: Number.isFinite(row.estSaved) ? row.estSaved : null,
  });
}

const sumT = samples.reduce((a, s) => a + s.truthO200k, 0);
const sumE = samples.reduce((a, s) => a + s.estTotal, 0);
const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length * p)]; };
const ratios = samples.map((s) => s.ratio);

// 网格搜索新系数（多元回归在这批语料上共线性风险高 —— 会话/真包几乎全英文，
// 给 b 的搜索区间卡在 [0.15,0.6]、a 卡在 [0.6,1.8]，比无约束求解稳）。
function fit(list) {
  let best = null;
  for (let a = 0.6; a <= 1.8; a += 0.01) {
    for (let b = 0.15; b <= 0.6; b += 0.005) {
      const e = (s) => Math.max(1, Math.round((s.match(CJK_RE) || []).length * a + s.replace(CJK_RE, '').length * b));
      const tt = list.reduce((acc, s) => acc + totalWith(s.request, e), 0);
      const te = list.reduce((acc, s) => acc + totalWith(s.request, eNow(null, e)), 0);
      const err = Math.abs(tt - te);
      if (!best || err < best.err) best = { cjk: a, ascii: b, err, truth: tt, est: te };
    }
  }
  return best;
}
const eNow = (unused, f) => f; // fit 内部直接换 estimate，保留占位让网格可读

const fitted = DO_FIT && samples.length ? fit(samples) : null;

const result = {
  ts: new Date().toISOString(),
  scope: 'whole-request（整包七类之和，与桥 estTotal 同口径）',
  tokenizer: 'gpt-tokenizer(o200k_base) 代理真值 ⚠️ 非 agnes 上游真 tokenizer',
  corpus: CORPUS_GLOB,
  corpusRows: rows.length,
  sampleSize: samples.length,
  current: { cjkRatio: CJK_RATIO, asciiRatio: ASCII_RATIO },
  aggregate: {
    sumEst: sumE, sumTruth: sumT,
    weightedRatio: +(sumT / sumE).toFixed(4),
    weightedBias: +((sumT - sumE) / sumE).toFixed(4),
    medianRatio: +q(ratios, 0.5).toFixed(4),
    p10Ratio: +q(ratios, 0.1).toFixed(4),
    p90Ratio: +q(ratios, 0.9).toFixed(4),
  },
  fitted: fitted ? { cjkRatio: +fitted.cjk.toFixed(3), asciiRatio: +fitted.ascii.toFixed(3), estTruthDeltaAbs: Math.round(fitted.err) } : null,
  note: fitted
    ? '新系数只在本批真包上使 est→o200k 的绝对值残差最小；是否落到内核需再用 129 份 SKILL.md 语料复验（块级校准是另一条线）。'
    : '加 --fit 才拟合。',
  samples: samples.map((s) => ({ ts: s.ts, path: s.path, estTotal: s.estTotal, truthO200k: s.truthO200k, ratio: s.ratio, bias: s.bias })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');

console.log(`整包估算校准 · ${result.sampleSize} 个真包 · 真值 = o200k（⚠️ 代理真值，非 agnes 真 tokenizer）`);
console.log('口径：与桥第①步同构 CF.fold({...body, messages: sys.concat(ctx.messages)})，只把 estimate 换成 o200k');
console.log('');
console.log('ts                  path                 estTotal   o200k    ratio   bias');
for (const s of samples) {
  console.log(`${s.ts.slice(5, 19)}  ${String(s.path).padEnd(18)}  ${String(s.estTotal).padStart(8)}  ${String(s.truthO200k).padStart(7)}  ${s.ratio.toFixed(3)}  ${(s.bias * 100).toFixed(1)}%`);
}
console.log('');
const ag = result.aggregate;
console.log(`合计 est=${sumE} vs o200k=${sumT}｜加权 ratio=${ag.weightedRatio}｜加权 bias=${(ag.weightedBias * 100).toFixed(1)}%｜中位 ratio=${ag.medianRatio}｜p10=${ag.p10Ratio} p90=${ag.p90Ratio}`);
if (fitted) {
  console.log(`拟合新系数: cjk=${fitted.cjk.toFixed(3)} ascii=${fitted.ascii.toFixed(3)}（整包残差 ${Math.round(fitted.err)} tok，绝对值最小）`);
}
console.log(`→ ${OUT}`);
