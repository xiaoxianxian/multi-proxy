// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// cache-k-estimator：从代理白拿的 usage 自测「退回段是否按未命中价计费」（k）
//
// 为什么必须自测：tools 懒加载在带 prompt cache 的上游上赚不赚，取决于一个上游
// 私有口径 k —— 断点后退那一截（退回段）是否按未命中价收。这个数官方没写。
// ⭐ 2026-10-20 回源 + 实测闭合（细节见 docs/10-initiatives/94-DeepInfer与deepseek-recipe
// 外部对照-2026-10-20.md §7）：
//   ① 定义已回源：DeepSeek 官方 kv_cache 文档——prompt_cache_miss_tokens＝本请求输入中
//      未命中的 token（即 输入−命中）。53 号「裁到 4 把时 miss 反而变小」按此重算自洽
//      （被裁 token 不在请求里，输入与 hit 同步缩短，miss 只动差值：估算 −44 vs 实测 −58）。
//      命中机制＝前缀单元全匹配（非最长公共前缀）。
//   ② ⭐ k 已实测闭合（2026-10-20 真实 API，工具 tools/cache-k-real-run.js）：真实 codex
//      13 工具表 + 本 policy + deepseek-flash 直连，suffix/mid 双模式各 4 会话，
//      **8/8 换挡样本 k̂=0**（residual 全为负 ⇒ 上游 miss 口径比「新增正文」还省）。
//      ⇒ k ≤ k*(0.0204) ⇒ mid 不亏，auto 保持 mid 的依据坐实。
//      附带成本实测（干净 A/B、缓存隔离、同消息结构）：mid R3 省 31.9% vs suffix 省
//      10.9% 元/轮。与 53/54 旧价（d=0.1：mid −12.0% vs suffix −4.7%）方向一致且
//      **mid 优势扩大**（7.3 → 21 个点）——d 收紧后命中变便宜、miss 主导成本，
//      激进裁剪更占优，与经济学方向自洽。
//   ③ 复跑：node tools/cache-k-real-run.js --sessions 4（< $0.05；402=余额不足）。
//      ⚠️ DeepSeek API 必须直连：7897 代理吞 Authorization 头。
// k 只能实测定，而代理站在请求路径中间、每轮都能白拿 usage —— 这是 agent 侧
// 工具（Graft/zg 之流）和纯 Lakehouse 厂商都拿不到的位置。
//
// 算法（换挡样本）：
//   Δtotal = prompt_n − prompt_{n−1}
//   新增正文 Δmsg = Δtotal + saved_n        （saved_n = 本轮藏掉的 schema tokens）
//   Δmiss   = miss_n − miss_{n−1}
//   k=0 时期望 Δmiss = Δmsg（退回段仍按命中价）
//   k=1 时期望 Δmiss = Δmsg + Δregress（退回段整段按未命中价）
//   ⇒ k̂ = (Δmiss − Δmsg) / Δregress
//
// 稳定样本（Δregress = 0，形状没变）只做 sanity：Δmiss 应 ≈ Δtotal。
// 显著为正 → 有额外重算没被方程吸收，k̂ 需按这个残差上调，文档里标为未回源。
//
// 有了 k 之后由 suggestMode() 决定默认裁剪模式，判据见 kStar()。

const fs = require('fs');
const path = require('path');

const STORE = path.join(process.env.HOME || '/tmp', '.multi-proxy/cache-estimate.json');

// 命中价折扣：命中 token 的单价 / 未命中 token 的单价。
// 默认 0.02 ＝ 2026-10-20 官方定价页现价（Flash）：命中 $0.003/M、未命中 $0.15/M
// ⇒ 谷 0.02、峰（$0.006/$0.3）同为 0.02，与时段无关。旧值 0.1 源自 2026-08-02
// 官方 news0802（0.1 元/M vs 1 元/M），已过时。2026-10-20 老板拍改为现价。
// 影响面：kStar = d/(1−d) 由 0.111 收紧到 0.0204 ⇒ k ∈ [0.0204, 0.111] 的样本
// 建议由 mid 翻 suffix（命中折扣深 ⇒ 保前缀更值钱）。已核旧样本：账本唯一样本
// k=0，两种 d 下均判 mid，结论不翻转。回源记录见 94 号文档 §7.4。
function kStar(discount) {
  const d = Number.isFinite(discount) ? discount : 0.02;
  return d / (1 - d); // 净收益 = H·d − R·k·(1−d)，suffix 下 R=H ⇒ k ≤ k* 才不亏
}

// 冷启动轮数：前 (WARMUP_ROUNDS) 轮不产样本。
// ⚠️ 必须显式排除，不能靠「Δmsg=0 自然落空」——那是隐式依赖，改谁都看不出为什么。
//    实测依据（57 号）：首次请求的 miss 里含「上游首次建缓存」的一次性成本，
//    两轮做差会被这个数污染，算出的 k̂ 往「偏小」方向跑（⇒ auto 选 mid，偏激进）。
//    两条主路径的冷态长度还不一样（流式命中延迟一轮：646 tok 前缀 t1/t2 的 hit=0、
//    t3 才 hit=512；非流式 t2 就命中），统一按长的那条取：前 2 轮丢，样本从第 3 轮起算。
const WARMUP_ROUNDS = Math.max(0, Number(process.env.CACHE_K_WARMUP ?? 2));

/**
 * 用两轮样本估 k。
 * @param {{prompt:number, hit:number, miss:number, breakpoint:number|null, saved:number|null, round?:number}} s
 * @param {object|null} prev 上一轮同形状样本
 * @returns {{k:number|null, samples:number, residual:number|null, mode:string, reason:string, round:number}}
 */
function observe(s, prev) {
  const fin = (v) => Number.isFinite(v);
  // ⚠️ 缺 round 时不判冷态：冷态是「会话逐轮推进」的概念，合成样本/离线复现没有这层
  //    语义，硬判会把所有既有用例和离线 bench 打回 no-sample。没标记轮次的调用方
  //    （= 桥，它用 cur.round 逐轮递增）才走冷态过滤。
  const round = fin(s && s.round)
    ? s.round
    : (prev && fin(prev.round) ? prev.round + 1 : null);
  const empty = (reason) => ({ k: null, samples: 0, residual: null, mode: 'mid', reason, round });
  if (!s || !fin(s.prompt) || !fin(s.miss)) return empty('no-usage');
  if (!prev || !fin(prev.prompt) || !fin(prev.miss)) return empty('no-prev');
  if (round !== null && round <= WARMUP_ROUNDS) return empty('cold-start');

  const dTotal = s.prompt - prev.prompt;
  const dMiss = s.miss - prev.miss;
  const saved = fin(s.saved) ? s.saved : 0;
  const prevSaved = fin(prev.saved) ? prev.saved : 0;
  // 新增正文：total_n = total_{n−1} + Δmsg + saved_{n−1} − saved_n
  //   ⇒ Δmsg = Δtotal + (saved_n − saved_{n−1}) = Δtotal + Δsaved
  // ⚠️ 必须拿**增量**而不是本轮绝对值：写成 Δtotal + saved_n 的话，形状没变的稳定样本
  //    会被凭空多算一整份 saved（实测稳定样本残差从 −112 变成 −5286，正是这么来的）。
  //    形状切换时 saved_{n−1}=0，两种写法恰好同值，所以那个 bug 只在稳态才露出来。
  const dSaved = saved - prevSaved;
  const dMsg = dTotal + dSaved;
  const residual = dMiss - dMsg;            // 负值 = 上游 miss 口径比「新增正文」还省
  // 断点后退量：本轮断点比上轮靠前多少 tokens（>0 才算换挡样本）
  const bpA = fin(s.breakpoint) ? s.breakpoint : null;
  const bpB = fin(prev.breakpoint) ? prev.breakpoint : null;
  // 🔴 断点变化必须**是我们裁剪造成的**，不能是请求形状自己变了。
  //    实测踩到：两个会话的 tools 集不同（15 把 schema 1764 vs 1264），两轮都没裁
  //    （saved=0），bp 却"后退"500 → 被判 shape-switch，算出 k̂=1 这种荒谬值。
  //    后果不只是脏样本：k̂=1 ⇒ suggestMode 切 suffix ⇒ 在 k≈0 的上游白付 7 个点
  //    （54 号实测）。判据 = 至少一侧真发生过隐藏，否则 dRegress 记 0。
  const shaped = saved > 0 || prevSaved > 0;
  const dRegress = shaped && bpA !== null && bpB !== null ? Math.max(0, bpB - bpA) : 0;

  // ⚠️ saved 是 policy 用「3 字符 ≈ 1 token」粗估的（31 号校正后仍偏高约 30%），
  //    所以 dMsg 有偏差，k̂ 只能当量级用。真要精确，得让上游把 schema 段单独出数 —— 目前没有。
  if (dRegress <= 0) return { k: null, samples: 0, residual, mode: 'mid', reason: 'no-regress', round };

  const k = residual / dRegress;
  if (!Number.isFinite(k)) return { k: null, samples: 0, residual, mode: 'mid', reason: 'nan', round };
  return { k: Math.min(1, Math.max(0, k)), samples: 1, residual, mode: suggestMode(k), reason: 'shape-switch', round };
}

/** k ≥ k* ⇒ 跳着删（mid）会亏，老老实实删尾部（suffix）；否则 mid 更赚。 */
function suggestMode(k, discount) {
  const x = Number.isFinite(k) ? k : 0;
  return x >= kStar(discount) ? 'suffix' : 'mid';
}

function read(store = STORE) {
  try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return null; }
}

function write(est, store = STORE) {
  try {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    const prev = read(store) || { samples: 0 };
    fs.writeFileSync(store, JSON.stringify({
      updatedAt: new Date().toISOString(),
      samples: Math.max(Number(prev.samples) || 0, Number(est.samples) || 0),
      k: Number.isFinite(est.k) ? est.k : (Number.isFinite(prev.k) ? prev.k : null),
      residual: Number.isFinite(est.residual) ? est.residual : prev.residual ?? null,
      mode: est.mode,
      kStar: kStar(),
      source: est.reason === 'shape-switch' ? 'measured' : 'default',
    }, null, 2));
    return true;
  } catch { return false; }
}

module.exports = { observe, suggestMode, kStar, read, write, STORE };
