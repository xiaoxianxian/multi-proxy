#!/usr/bin/env node
// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// cache-k 红线实测闭合工具（2026-10-20 建，回应 94 号文档 §7.5「k 的实测闭合仍开着」）。
//
// 干什么：用**真实 DeepSeek API + 真实 codex 工具表（corpus 首轮 13 项）+ 生产 policy**，
// 采 observe() 能吃的「换挡样本」（两轮做差），把上游私有口径 k 估出来，
// 写回 ~/.multi-proxy/cache-estimate.json（estimator 的配置源）。
//
// 为什么必须真跑：k 是上游「断点后退那一截是否按未命中价收」的私有口径，
// 官方文档不写、recipe 源码零 cache 语义，只有站在请求路径上逐轮拿 usage 才能白拿到。
//
// 用法：node tools/cache-k-real-run.js [--mode both|suffix|mid] [--rounds 6] [--dry-run]
//   --dry-run 只打印会发的请求形状与预估成本，不真发（无余额时先验这个）。
//
// ⚠️ DeepSeek API 必须**直连**：本机 7897 代理会吞 Authorization 头（实测报
//   "auth header format should be Bearer sk-..."）。脚本内显式不走代理。
// ⚠️ 前置：.env 里 DEEPSEEK_API_KEY 且有余额（402 Insufficient Balance 会明确报错）。
// 成本量级：每模式 6 轮 × ~5k prompt tokens ≈ $0.005，both 两模式 < $0.02。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORPUS = path.join(ROOT, 'logs/bridge-corpus-2026-10-02.jsonl');
const lazyload = require(path.join(ROOT, 'packs/curator/policies/tools-lazyload.js'));
const KE = require(path.join(__dirname, 'cache-k-estimator.js'));

// —— 参数 ——
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const MODE = flag('mode', 'both');        // both | suffix | mid
const SESSIONS = Math.max(1, Number(flag('sessions', 4)) || 4); // 每模式独立会话数（每会话 3 轮）
const DRY = args.includes('--dry-run');

// —— 官方现价（2026-10-20 定价页，Flash；峰谷同率）——
const PRICE = { miss: 0.15 / 1e6, hit: 0.003 / 1e6 }; // 美元 / token

function loadKey() {
  const env = path.join(ROOT, '.env');
  for (const line of fs.readFileSync(env, 'utf8').split('\n')) {
    const m = line.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(\S+)\s*$/);
    if (m) return m[1];
  }
  throw new Error('.env 里没有 DEEPSEEK_API_KEY');
}

// —— 真实工具表：corpus 首轮请求体的 13 项（Responses 协议）→ chat completions function 格式 ——
function loadTools() {
  for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const body = typeof d === 'object' && d.tools ? d : (d.request || d.body || null);
    if (!body || !Array.isArray(body.tools)) continue;
    return body.tools.map((t, i) => {
      // 两种形态：{type:'function', name, description, parameters} 与 {type:'function', function:{…}}
      const f = t.function || t;
      const name = f.name || t.name || `tool_${i}`; // tool_search/web_search 无 name，补占位
      return {
        type: 'function',
        function: {
          name,
          description: String(f.description || '').slice(0, 2000),
          parameters: f.parameters || { type: 'object', properties: {} },
        },
      };
    });
  }
  throw new Error('corpus 里没找到带 tools 的请求体');
}

// —— 会话构造（⭐ 轮次编排是能采到样本的关键，别改）——
// observe() 的换挡样本要求三件事同时成立：round > WARMUP_ROUNDS(=2)、saved>0、breakpoint 后退。
// 而 keepNames 随调用历史单调递增 ⇒ 一个会话里只有一次「裁得更多」的换挡。
// 所以：R1/R2 保持无调用证据（全发、预热+过冷态），R3 才注入调用历史触发第一次裁剪；
// 每会话 3 轮，多样本靠多个独立会话累积（会话间 user 内容带序号 ⇒ 前缀不同、不互相污染）。
//   R1 = [system, user0]                     全发（no-usage-evidence）
//   R2 = [system, user0, user1]              全发（同上；R2 命中 R1 的缓存做预热）
//   R3 = [system, user0, asst(tc), tool, user2]  有调用证据 ⇒ 裁剪 ⇒ 换挡样本（round=3 过冷态）
function buildRound(i, sid) {
  const messages = [
    { role: 'system', content: 'You are a coding agent working in a repository. Answer concisely.' },
    { role: 'user', content: `Session ${sid} round 0: list the repository layout and summarize what this project does.` },
  ];
  if (i === 0) return messages;
  if (i === 1) {
    messages.push({ role: 'user', content: `Session ${sid}: what testing framework does it use? One sentence.` });
    return messages;
  }
  // i>=2：注入「调用过 exec_command」的历史（chat 协议 tool_calls 形态，activeToolNames 认）
  for (let r = 1; r <= i; r++) {
    messages.push({
      role: 'assistant', content: null,
      tool_calls: [{ id: `call_${sid}_${r}`, type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls -la"}' } }],
    });
    messages.push({ role: 'tool', tool_call_id: `call_${sid}_${r}`, content: `total 48\ndrwxr-xr-x  src  tests  README.md  package.json  (session ${sid} round ${r})` });
    if (r < i) messages.push({ role: 'user', content: `Session ${sid} round ${r}: also check tests dir. One sentence.` });
  }
  messages.push({ role: 'user', content: `Session ${sid} round ${i}: now open src/main and explain the entry point. Keep it under 100 words.` });
  return messages;
}

// —— 干净基线：与裁剪模式**同消息结构**（同样带 tool_calls），唯一差异是 tools 全发
//    （minTools=99 拦死 policy）；system 末尾加 [baseline-run] 标记 ⇒ 前缀与裁剪模式
//    不同，不继承前面跑动烤热的缓存（第一轮实测踩到：模式间缓存交叉污染，mid 的
//    「全发基线」hit=2560 是假基线，省 −117% 纯属统计假象）。
function buildBaseline(i, sid) {
  const messages = buildRound(i, sid);
  messages[0] = Object.assign({}, messages[0], { content: messages[0].content + ' [baseline-run]' });
  return messages;
}

// —— 直连 DeepSeek（不走代理）——
async function chat(key, body) {
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) || `HTTP ${r.status}`;
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return j;
}

function usageOf(j) {
  const u = j.usage || {};
  // 字段名实测核对（2026-10-20 deepseek-flash / V4.1）：usage.prompt_tokens +
  // usage.prompt_tokens_details.cached_tokens；**没有** prompt_cache_miss_tokens 字段，
  // miss 由 prompt − cached 推。旧版 DeepSeek 的 prompt_cache_hit/miss_tokens 仍做兼容。
  const d = u.prompt_tokens_details || {};
  const prompt = u.prompt_tokens ?? u.prompt ?? null;
  const hit = d.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.prompt_cache_hit ?? null;
  const miss = u.prompt_cache_miss_tokens ?? u.prompt_cache_miss ?? (prompt != null && hit != null ? prompt - hit : null);
  return { prompt, hit, miss, raw: u };
}

function costOf(u) {
  const c = (u.hit || 0) * PRICE.hit + (u.miss || 0) * PRICE.miss;
  return c;
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

async function runMode(key, tools, mode) {
  const isBase = mode === 'none'; // none = 干净基线：全程全发（minTools 拦死裁剪），system 带标记隔离缓存
  console.log(`\n=== 模式 ${mode}${isBase ? '（干净基线：全程全发，system 带 baseline 标记隔离缓存）' : `（pruneMode=${mode}）`} · ${SESSIONS} 个独立会话 × 3 轮 ===`);
  const rows = [];
  const ks = [];
  for (let sid = 1; sid <= SESSIONS; sid++) {
    let prev = null;
    for (let i = 0; i < 3; i++) {
      const messages = isBase ? buildBaseline(i, sid) : buildRound(i, sid);
      // 生产 policy 裁剪（与代理链路同一 handler、同一口径）；基线用 minTools 拦死 ⇒ 恒全发
      const budget = isBase ? { pruneMode: 'suffix', minTools: 99 } : { pruneMode: mode };
      const pr = lazyload.handler({ tools, messages }, { budget });
      const s = {
        prompt: 0, hit: 0, miss: 0,
        saved: pr.saved || 0,
        breakpoint: pr.breakpointSchemaTokens ?? null,
        round: i + 1,
      };
      if (DRY) {
        console.log(`  S${sid} R${i + 1} kept=${pr.kept}/${pr.total} saved=${pr.saved} reason=${pr.reason} bp=${pr.breakpointSchemaTokens}`);
        prev = s;
        continue;
      }
      const j = await chat(key, { model: 'deepseek-flash', messages, tools: pr.tools || tools, max_tokens: 64 });
      const u = usageOf(j);
      s.prompt = u.prompt; s.hit = u.hit; s.miss = u.miss;
      const est = KE.observe(s, prev);
      if (est.k !== null) ks.push(est.k);
      console.log(`  S${sid} R${i + 1} kept=${pr.kept}/${pr.total} saved=${pr.saved} bp=${pr.breakpointSchemaTokens} | prompt=${u.prompt} hit=${u.hit} miss=${u.miss} | $${costOf(u).toFixed(6)}${est.k !== null ? ` | ★k=${est.k.toFixed(4)} ${est.mode}(${est.reason})` : ''}${i === 0 && sid === 1 ? ' | raw usage: ' + JSON.stringify(u.raw) : ''}`);
      rows.push({ sid, round: i + 1, pr, s, est });
      prev = s;
    }
  }
  return { rows, ks };
}

(async () => {
  const key = loadKey();
  const tools = loadTools();
  const totalTokens = lazyload.schemaTokens(tools);
  console.log(`工具表 ${tools.length} 项（schemaTokens≈${totalTokens}）｜模式=${MODE}｜会话=${SESSIONS}×3 轮｜${DRY ? 'DRY-RUN 不发请求' : '真实请求'}`);

  if (DRY) {
    for (const m of (MODE === 'both' ? ['none', 'suffix', 'mid'] : [MODE])) await runMode(key, tools, m);
    console.log('\nDRY-RUN 完。预估成本：both × 3 模式 × 4 会话 × 3 轮 ≈ 36 请求 < $0.05。去掉 --dry-run 真跑。');
    return;
  }

  const modes = MODE === 'both' ? ['none', 'suffix', 'mid'] : [MODE];
  const results = {};
  for (const m of modes) results[m] = await runMode(key, tools, m);

  // —— 汇总：干净基线（none）vs 各裁剪模式，同 round 对齐 ——
  console.log('\n=== 汇总（官方现价 hit $0.003/M · miss $0.15/M；none=同消息结构全发基线）===');
  const base = results.none;
  const baseAvg = (round) => {
    const rs = base.rows.filter((r) => r.round === round);
    return rs.length ? rs.reduce((a, r) => a + costOf(r.s), 0) / rs.length : null;
  };
  const allK = [];
  for (const m of modes) {
    const { rows, ks } = results[m];
    allK.push(...ks.map((k) => ({ m, k })));
    if (m === 'none') {
      const avg = (round, f) => { const rs = rows.filter((r) => r.round === round); return rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : 0; };
      console.log(`  none(基线): R1 均 $${avg(1, (r) => costOf(r.s)).toFixed(6)}｜R2 $${avg(2, (r) => costOf(r.s)).toFixed(6)}｜R3 $${avg(3, (r) => costOf(r.s)).toFixed(6)}（R3 均 prompt=${avg(3, (r) => r.s.prompt).toFixed(0)}）`);
      continue;
    }
    const bR3 = baseAvg(3);
    const cR3 = rows.filter((r) => r.round === 3);
    const cCost = cR3.length ? cR3.reduce((a, r) => a + costOf(r.s), 0) / cR3.length : 0;
    const cPrompt = cR3.length ? cR3.reduce((a, r) => a + r.s.prompt, 0) / cR3.length : 0;
    console.log(`  ${m}: R3 均 $${cCost.toFixed(6)}（prompt=${cPrompt.toFixed(0)}）vs 基线 R3 $${bR3 ? bR3.toFixed(6) : 'N/A'} ⇒ ${bR3 ? '省 ' + ((1 - cCost / bR3) * 100).toFixed(1) + '% 元/轮' : '无基线'}`);
    console.log(`    k 样本 ${ks.length} 个：[${ks.map((k) => k.toFixed(3)).join(', ')}]${ks.length ? ` 中位 ${median(ks).toFixed(4)}` : ''}`);
  }
  // —— 热态对照：同会话内 R2（全发、缓存已热）vs R3（本模式裁剪） ——
  // 53/54 记的「mid −12.0% vs suffix −4.7%」比的是**冷启动全发**（hit=0、$0.000411）；
  // 真实 agent 会话跑到第二轮缓存早就热了，基线应是同会话内上一轮全发。两个基线
  // 给出相反结论：冷启动下 suffix 省 10.9%，热态下 suffix 反而贵 14%（2026-10-21 发现）。
  console.log('\n=== 热态对照（同会话内：R2 全发 → R3 裁剪，缓存已热）===');
  for (const m of modes) {
    const rows = (results[m].rows || []);
    const hot = rows.filter((r) => r.round === 2 && r.s.prompt);
    // 只比「这一轮真的裁了」的样本：none 模式的 R3 只是对话自然变长（saved=0），
    // 拿它跟 R2 比得到的是「多聊一轮要多少钱」，不是「裁剪省不省」，混进来会误导。
    const cut = rows.filter((r) => r.round === 3 && r.s.prompt && (r.pr && r.pr.saved > 0));
    if (!hot.length || !cut.length) continue;
    const avgCost = (rs) => rs.reduce((a, r) => a + costOf(r.s), 0) / rs.length;
    const avgHit = (rs) => rs.reduce((a, r) => a + (r.s.hit || 0) / r.s.prompt, 0) / rs.length;
    const a = avgCost(hot), b = avgCost(cut);
    console.log(`  ${m}: 热态全发 $${a.toFixed(6)}（命中 ${(avgHit(hot) * 100).toFixed(1)}%）→ 裁剪 $${b.toFixed(6)}（命中 ${(avgHit(cut) * 100).toFixed(1)}%）＝ ${b <= a ? '省' : '贵'} ${(Math.abs(1 - b / a) * 100).toFixed(1)}%`);
  }

  // —— k 汇总与账本 ——
  if (allK.length) {
    const km = median(allK.map((x) => x.k));
    const worst = Math.max(...allK.map((x) => x.k));
    console.log(`\n=== k 结论 ===\n  全样本中位 k=${km.toFixed(4)}（n=${allK.length}，最差 ${worst.toFixed(4)}）`);
    console.log(`  对照 kStar(d=0.02)=${KE.kStar(0.02).toFixed(4)}：${km <= KE.kStar(0.02) ? '中位 k ≤ k* ⇒ mid 不亏（auto 保持 mid）' : '中位 k > k* ⇒ mid 亏 ⇒ auto 会切 suffix'}`);
    KE.write({ k: km, residual: null, samples: allK.length, mode: km <= KE.kStar(0.02) ? 'mid' : 'suffix', reason: 'shape-switch' });
    console.log(`  账本已更新 → ~/.multi-proxy/cache-estimate.json（k=${km.toFixed(4)}, samples=${allK.length}）`);
  } else {
    console.log('\n⚠️ 没采到换挡样本——检查 WARMUP/cold-start 与会话构造，别猜。');
  }
})().catch((e) => {
  if (e.status === 402) {
    console.error('\n❌ Insufficient Balance：key 有效但余额不足。充值后重跑同一命令即可（脚本无状态依赖）。');
    process.exit(2);
  }
  console.error('\n❌', e.message);
  process.exit(1);
});
